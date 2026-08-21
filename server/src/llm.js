// The brain of the comic pipeline: condenses oversized recipes and writes the
// per-panel scene descriptions an image model paints. Runs on OpenRouter, so
// the text model can be swapped without touching this file.

import { STYLE_POSITIVE, STYLE_NEGATIVE } from "./style.js";
import { MAX_STEPS, condenseLocally } from "./chunk.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export const LLM_MODEL = process.env.OPENROUTER_TEXT_MODEL || "google/gemini-2.5-flash";

// Text generation has the same problem the image side does: any one account
// can run out of credit. Providers are tried in order until one answers.
function textProviders(){
  const all = {
    gemini:     { name: "gemini",     call: viaGemini,     key: "GEMINI_API_KEY" },
    groq:       { name: "groq",       call: viaGroq,       key: "GROQ_API_KEY" },
    openrouter: { name: "openrouter", call: viaOpenRouter, key: "OPENROUTER_API_KEY" }
  };
  // Order is configurable so a provider that runs out of credit can be moved
  // down without a code change.
  const order = (process.env.TEXT_PROVIDER_ORDER || "gemini,groq,openrouter")
    .split(",").map(s => s.trim()).filter(Boolean);
  return order.map(name => all[name]).filter(p => p && process.env[p.key]);
}

export function llmConfigured(){
  return textProviders().length > 0;
}

export function llmStatus(){
  return {
    model: LLM_MODEL,
    providers: textProviders().map(p => p.name),
    active: textProviders()[0]?.name || null
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function retryDelayMs(status, headers, body, attempt){
  if(status === 429){
    const fromBody = /try again in ([\d.]+)s/i.exec(body || "");
    if(fromBody) return Math.ceil(parseFloat(fromBody[1]) * 1000) + 400;
    const header = headers?.get?.("retry-after");
    if(header && Number.isFinite(Number(header))) return Number(header) * 1000 + 400;
  }
  return Math.min(8000, 700 * 2 ** attempt);
}

// A 402/401/403 means this account is out - move to the next provider rather
// than burning retries on it.
function isTerminal(status){
  return status === 401 || status === 402 || status === 403 || status === 404;
}

async function postJson(url, headers, body, timeoutMs){
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
}

async function viaOpenRouter(messages, { maxTokens, temperature, timeoutMs }){
  const res = await postJson(OPENROUTER_URL, {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "HTTP-Referer": process.env.PUBLIC_URL || "https://family-recipe-box.onrender.com",
    "X-Title": "The Family Recipe Box"
  }, {
    model: LLM_MODEL,
    temperature,
    // Sent explicitly: OpenRouter rejects requests whose default token
    // ceiling exceeds what the account balance can cover.
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages
  }, timeoutMs);
  return { res, read: data => data?.choices?.[0]?.message?.content || "" };
}

async function viaGroq(messages, { maxTokens, temperature, timeoutMs }){
  const res = await postJson(GROQ_URL, {
    Authorization: `Bearer ${process.env.GROQ_API_KEY}`
  }, {
    model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
    temperature,
    max_completion_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages
  }, timeoutMs);
  return { res, read: data => data?.choices?.[0]?.message?.content || "" };
}

// Gemini's own API takes a different shape: system text is hoisted out of the
// message list and JSON mode is a generationConfig flag.
async function viaGemini(messages, { maxTokens, temperature, timeoutMs }){
  const model = process.env.GEMINI_TEXT_MODEL || "gemini-3.5-flash-lite";
  const system = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const contents = messages
    .filter(m => m.role !== "system")
    .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

  const res = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    { "x-goog-api-key": process.env.GEMINI_API_KEY },
    {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json"
      }
    },
    timeoutMs
  );
  return {
    res,
    read: data => (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("")
  };
}

export async function llmJson(messages, { maxTokens = 1400, temperature = 0.55 } = {}){
  const providers = textProviders();
  if(providers.length === 0) throw new Error("No text model is configured");

  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 90000);
  const maxAttempts = Number(process.env.LLM_MAX_ATTEMPTS || 4);
  const failures = [];

  for(const provider of providers){
    let lastError = "";
    for(let attempt = 0; attempt < maxAttempts; attempt++){
      let res, read;
      try{
        ({ res, read } = await provider.call(messages, { maxTokens, temperature, timeoutMs }));
      }catch(e){
        lastError = `${provider.name}: ${e.message}`;
        break;
      }

      if(res.ok){
        const data = await res.json();
        if(data.error){
          lastError = `${provider.name}: ${JSON.stringify(data.error).slice(0, 200)}`;
          break;
        }
        try{
          return parseJsonLoose(read(data));
        }catch(e){
          lastError = `${provider.name}: ${e.message}`;
          break;
        }
      }

      const detail = await res.text().catch(() => "");
      lastError = `${provider.name} ${res.status}: ${detail.slice(0, 200)}`;
      if(isTerminal(res.status)) break;
      if(res.status !== 429 && res.status < 500) break;
      if(attempt === maxAttempts - 1) break;
      await sleep(retryDelayMs(res.status, res.headers, detail, attempt));
    }
    failures.push(lastError);
    console.error(`[llm] ${lastError} - trying next provider`);
  }

  throw new Error(`All text providers failed: ${failures.join(" | ")}`);
}

// Models occasionally wrap JSON in prose or fences; recover the object.
export function parseJsonLoose(text){
  const raw = String(text || "").trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try{ return JSON.parse(unfenced); }catch(e){}
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if(start !== -1 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
  throw new Error("The model did not return usable JSON");
}

// --- Step condensing -------------------------------------------------------

export async function condenseSteps(steps, recipeTitle, limit = MAX_STEPS){
  if(steps.length <= limit) return { steps, condensed: false };
  if(!llmConfigured()) return { steps: condenseLocally(steps, limit), condensed: true, by: "local" };

  try{
    const result = await llmJson([
      {
        role: "system",
        content:
          "You condense cooking instructions. Merge only closely related consecutive " +
          "steps, never reorder them, and never drop an instruction, timing, " +
          "temperature or quantity. Keep as much detail as the step budget allows - " +
          "condensing too far is worse than not condensing enough. Reply ONLY with " +
          'JSON: {"steps":[{"title":"short imperative title","text":"the merged instruction"}]}'
      },
      {
        role: "user",
        content:
          `Recipe: ${recipeTitle}\n` +
          `Condense these ${steps.length} steps into exactly ${limit} steps - ` +
          `not fewer. Every original instruction must survive inside one of them.\n\n` +
          steps.map((step, i) => `${i + 1}. ${step.text}`).join("\n")
      }
    ], { temperature: 0.3, maxTokens: 2000 });

    const condensed = (result.steps || [])
      .map(step => ({ title: String(step.title || "").trim(), text: String(step.text || "").trim() }))
      .filter(step => step.text)
      .slice(0, limit);

    // Guard against over-merging, which loses detail and shrinks the comic.
    const floor = Math.max(1, Math.ceil(limit * 0.75));
    if(condensed.length < floor){
      return { steps: condenseLocally(steps, limit), condensed: true, by: "local",
               error: `model returned only ${condensed.length} steps` };
    }
    return { steps: condensed, condensed: true, by: "model" };
  }catch(e){
    return { steps: condenseLocally(steps, limit), condensed: true, by: "local", error: e.message };
  }
}

// --- Panel authoring -------------------------------------------------------

const PANEL_SYSTEM =
  "You are the storyboard artist for a hand-painted family cookbook. " +
  "You turn cooking steps into comic panel descriptions for an illustrator.\n\n" +
  "House style (every panel must obey it): " + STYLE_POSITIVE + ".\n" +
  "Never describe: " + STYLE_NEGATIVE + ".\n\n" +
  "Rules:\n" +
  "- Write exactly one panel per step, in order.\n" +
  "- `scene` is a vivid single sentence naming the concrete cookware, food and " +
  "hand action, plus the visible state of the food (colour, texture, steam, sizzle).\n" +
  "- Show the food and equipment, never a person's face or body.\n" +
  "- Keep cookware consistent across panels of the same recipe.\n" +
  "- `caption` is a short human label of at most 6 words for the app UI.\n\n" +
  'Reply ONLY with JSON: {"panels":[{"stepIndex":0,"caption":"...","scene":"..."}]}';

export async function authorPanels({ recipeTitle, category, ingredients, chunk, totalChunks }){
  const stepLines = chunk.steps
    .map((step, i) => `${i + 1}. ${step.title ? step.title + " - " : ""}${step.text}`)
    .join("\n");

  const result = await llmJson([
    { role: "system", content: PANEL_SYSTEM },
    {
      role: "user",
      content:
        `Recipe: ${recipeTitle}\n` +
        `Category: ${category || "Other"}\n` +
        (ingredients?.length ? `Key ingredients: ${ingredients.slice(0, 14).join(", ")}\n` : "") +
        `This is comic strip ${chunk.index + 1} of ${totalChunks}, covering recipe steps ` +
        `${chunk.startStep + 1}-${chunk.endStep + 1}.\n\n` +
        `Write exactly ${chunk.steps.length} panel${chunk.steps.length === 1 ? "" : "s"} for:\n${stepLines}`
    }
  ], { maxTokens: 1600 });

  const panels = (result.panels || [])
    .map((panel, i) => ({
      stepIndex: chunk.startStep + (Number.isInteger(panel.stepIndex) && panel.stepIndex < chunk.steps.length
        ? panel.stepIndex
        : i),
      caption: String(panel.caption || chunk.steps[i]?.title || "").trim() || `Step ${chunk.startStep + i + 1}`,
      scene: String(panel.scene || "").trim()
    }))
    .filter(panel => panel.scene)
    .slice(0, chunk.steps.length);

  if(panels.length === 0) throw new Error("The model returned no usable panels");

  // Backfill if the model returned fewer panels than steps.
  while(panels.length < chunk.steps.length){
    const i = panels.length;
    const step = chunk.steps[i];
    panels.push({
      stepIndex: chunk.startStep + i,
      caption: step.title || `Step ${chunk.startStep + i + 1}`,
      scene: `${step.text} shown as a close-up of the food and cookware on a warm kitchen counter`
    });
  }

  return panels;
}

// The brain of the comic pipeline: condenses oversized recipes and writes the
// per-panel scene descriptions an image model paints. Runs on OpenRouter, so
// the text model can be swapped without touching this file.

import { STYLE_POSITIVE, STYLE_NEGATIVE } from "./style.js";
import { MAX_STEPS, condenseLocally } from "./chunk.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export const LLM_MODEL = process.env.OPENROUTER_TEXT_MODEL || "google/gemini-2.5-flash";

export function llmConfigured(){
  return Boolean(process.env.OPENROUTER_API_KEY);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// OpenRouter rate-limits and, on a low balance, rejects requests whose
// max_tokens it cannot cover - so max_tokens is always sent explicitly.
function retryDelayMs(status, headers, body, attempt){
  if(status === 429){
    const fromBody = /try again in ([\d.]+)s/i.exec(body || "");
    if(fromBody) return Math.ceil(parseFloat(fromBody[1]) * 1000) + 400;
    const header = headers?.get?.("retry-after");
    if(header && Number.isFinite(Number(header))) return Number(header) * 1000 + 400;
  }
  return Math.min(8000, 700 * 2 ** attempt);
}

export async function llmJson(messages, { maxTokens = 1400, temperature = 0.55 } = {}){
  const key = process.env.OPENROUTER_API_KEY;
  if(!key) throw new Error("OPENROUTER_API_KEY is not set");

  const maxAttempts = Number(process.env.LLM_MAX_ATTEMPTS || 5);
  let lastError = "";

  for(let attempt = 0; attempt < maxAttempts; attempt++){
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.PUBLIC_URL || "https://family-recipe-box.onrender.com",
        "X-Title": "The Family Recipe Box"
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages
      }),
      signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || 90000))
    });

    if(res.ok){
      const data = await res.json();
      if(data.error) throw new Error(`OpenRouter: ${JSON.stringify(data.error).slice(0, 300)}`);
      const content = data?.choices?.[0]?.message?.content || "";
      return parseJsonLoose(content);
    }

    const detail = await res.text().catch(() => "");
    lastError = `OpenRouter ${res.status}: ${detail.slice(0, 300)}`;

    // 4xx other than rate limiting will not improve on retry.
    if(res.status !== 429 && res.status < 500) throw new Error(lastError);
    if(attempt === maxAttempts - 1) break;
    await sleep(retryDelayMs(res.status, res.headers, detail, attempt));
  }

  throw new Error(lastError || "OpenRouter request failed");
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

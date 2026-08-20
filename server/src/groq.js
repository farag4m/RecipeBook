// Groq is the brain of the comic pipeline: it condenses oversized recipes
// and writes the per-panel scene descriptions that the image model paints.
// Groq has no text-to-image endpoint, so it never renders pixels itself.

import { STYLE_POSITIVE, STYLE_NEGATIVE } from "./style.js";
import { MAX_STEPS, condenseLocally } from "./chunk.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

export function groqConfigured(){
  return Boolean(process.env.GROQ_API_KEY);
}

async function groqJson(messages, { maxTokens = 1400, temperature = 0.55 } = {}){
  const key = process.env.GROQ_API_KEY;
  if(!key) throw new Error("GROQ_API_KEY is not set");

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature,
      max_completion_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages
    }),
    signal: AbortSignal.timeout(Number(process.env.GROQ_TIMEOUT_MS || 60000))
  });

  if(!res.ok){
    const detail = await res.text().catch(() => "");
    throw new Error(`Groq ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  return parseJsonLoose(content);
}

// Models occasionally wrap JSON in prose or fences; recover the object.
export function parseJsonLoose(text){
  const raw = String(text || "").trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try{ return JSON.parse(unfenced); }catch(e){}
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if(start !== -1 && end > start){
    return JSON.parse(unfenced.slice(start, end + 1));
  }
  throw new Error("Groq did not return usable JSON");
}

// --- Step condensing -------------------------------------------------------

export async function condenseSteps(steps, recipeTitle, limit = MAX_STEPS){
  if(steps.length <= limit) return { steps, condensed: false };
  if(!groqConfigured()) return { steps: condenseLocally(steps, limit), condensed: true, by: "local" };

  try{
    const result = await groqJson([
      {
        role: "system",
        content:
          "You condense cooking instructions. Merge closely related consecutive steps " +
          "so nothing is lost and the order never changes. Reply ONLY with JSON: " +
          '{"steps":[{"title":"short imperative title","text":"the merged instruction"}]}'
      },
      {
        role: "user",
        content:
          `Recipe: ${recipeTitle}\n` +
          `Condense these ${steps.length} steps into at most ${limit} steps.\n\n` +
          steps.map((step, i) => `${i + 1}. ${step.text}`).join("\n")
      }
    ], { temperature: 0.3 });

    const condensed = (result.steps || [])
      .map(step => ({ title: String(step.title || "").trim(), text: String(step.text || "").trim() }))
      .filter(step => step.text)
      .slice(0, limit);

    if(condensed.length === 0) throw new Error("empty condense result");
    return { steps: condensed, condensed: true, by: "groq" };
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

  const result = await groqJson([
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
  ]);

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

  if(panels.length === 0) throw new Error("Groq returned no usable panels");

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

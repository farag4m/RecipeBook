// Turns a messy blob of pasted text into a structured recipe.
//
// The old client-side parser matched line prefixes with regexes, so anything
// that was not already laid out as "Ingredients:" / "Steps:" fell apart. This
// hands the blob to the text model instead.

import { llmJson } from "./llm.js";
import { CATEGORIES } from "./recipe.js";

const SYSTEM =
  "You turn messy pasted text into one structured recipe. The text may be a " +
  "screenshot transcript, a chat message, a blog ramble, a voice note, or notes " +
  "in any language and any order.\n\n" +
  "Rules:\n" +
  "- Extract only what is actually there. Never invent an ingredient, a quantity, " +
  "a temperature or a time that the text does not state.\n" +
  "- Keep quantities, units, temperatures and timings exactly as written.\n" +
  "- Split run-on instructions into separate ordered steps, one action each.\n" +
  "- Every step gets a short imperative title of at most four words.\n" +
  "- Ingredients are plain strings, one per line, quantity first.\n" +
  "- Infer the title from the dish if it is not stated outright.\n" +
  `- category must be exactly one of: ${CATEGORIES.join(", ")}.\n` +
  "- servings and contributor are empty strings when the text does not say.\n" +
  "- Put anything useful that is neither ingredient nor step into notes.\n" +
  "- Translate the recipe into English if it is written in another language.\n\n" +
  'Reply ONLY with JSON: {"title":"","category":"","servings":"","contributor":"",' +
  '"ingredients":["..."],"steps":[{"title":"","text":""}],"notes":"","confidence":0.0}';

export async function parseRecipeText(raw){
  const text = String(raw || "").trim();
  if(!text) throw new Error("Paste some recipe text first.");
  if(text.length > 12000) throw new Error("That text is too long to parse in one go.");

  const result = await llmJson([
    { role: "system", content: SYSTEM },
    { role: "user", content: `Turn this into one recipe:\n\n${text}` }
  ], { temperature: 0.2, maxTokens: 3000 });

  const ingredients = (Array.isArray(result.ingredients) ? result.ingredients : [])
    .map(item => String(typeof item === "string" ? item : item?.text || "").trim())
    .filter(Boolean);

  const steps = (Array.isArray(result.steps) ? result.steps : [])
    .map(step => {
      if(typeof step === "string") return { title: "", text: step.trim() };
      return {
        title: String(step?.title || "").trim(),
        text: String(step?.text || step?.instruction || "").trim()
      };
    })
    .filter(step => step.text);

  if(steps.length === 0 && ingredients.length === 0){
    throw new Error("No recipe could be found in that text.");
  }

  return {
    title: String(result.title || "").trim() || "Untitled Recipe",
    category: CATEGORIES.includes(result.category) ? result.category : "Other",
    servings: String(result.servings || "").trim(),
    contributor: String(result.contributor || "").trim(),
    ingredients,
    steps,
    notes: String(result.notes || "").trim(),
    confidence: Number.isFinite(result.confidence) ? result.confidence : null
  };
}

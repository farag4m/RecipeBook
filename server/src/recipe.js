// Server-side recipe normalisation. The browser no longer owns the storage
// format, so the shape is enforced here.

const CATEGORIES = ["Breakfast","Mains","Sides","Desserts","Drinks","Snacks","Other"];

export function slugify(s){
  return String(s || "recipe").toLowerCase().trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "recipe";
}

export function newId(){
  return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function text(value){
  return String(value ?? "").trim();
}

function stepFrom(item){
  if(typeof item === "string"){
    const t = item.trim();
    return t ? { title: "", text: t } : null;
  }
  if(!item || typeof item !== "object") return null;
  const body = text(item.text || item.instruction || item.description || item.title);
  if(!body) return null;
  return { title: text(item.title || item.name), text: body };
}

// Ingredient-attached steps come first (in ingredient order), then extras.
export function collectSteps(raw){
  const out = [];
  for(const ing of (Array.isArray(raw.ingredients) ? raw.ingredients : [])){
    if(!ing || typeof ing !== "object") continue;
    const source = ing.step || ing.steps;
    const list = Array.isArray(source) ? source : (source ? [source] : []);
    for(const item of list){
      const step = stepFrom(item);
      if(step) out.push(step);
    }
  }
  for(const item of (Array.isArray(raw.steps) ? raw.steps : [])){
    const step = stepFrom(item);
    if(step) out.push(step);
  }
  return out;
}

export function ingredientText(item){
  if(typeof item === "string") return item.trim();
  if(!item || typeof item !== "object") return "";
  if(item.text) return text(item.text);
  const parts = [item.quantity, item.unit, item.name || item.ingredient].map(text).filter(Boolean);
  const note = text(item.note || item.notes);
  return (parts.join(" ") + (note ? ` (${note})` : "")).trim();
}

export function normalizeRecipe(raw, existing = null){
  const steps = collectSteps(raw);
  const title = text(raw.title) || "Untitled Recipe";
  return {
    format: "family-recipe-box.recipe.v2",
    id: existing?.id || text(raw.id) || newId(),
    slug: slugify(raw.slug || title),
    title,
    category: CATEGORIES.includes(raw.category) ? raw.category : "Other",
    servings: text(raw.servings),
    contributor: text(raw.contributor || raw.author),
    ingredients: (Array.isArray(raw.ingredients) ? raw.ingredients : [])
      .map(ingredientText).filter(Boolean),
    steps: steps.map(step => step.text),
    stepTitles: steps.map(step => step.title || step.text),
    notes: text(raw.notes),
    comics: Array.isArray(raw.comics) ? raw.comics : (existing?.comics || []),
    cover: raw.cover || existing?.cover || null
  };
}

export { CATEGORIES };

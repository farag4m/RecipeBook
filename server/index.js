// The Family Recipe Box - API and static host.
//
// Recipes and their comic art live in Postgres; the browser never touches
// GitHub and never holds a write credential.
//
// Comic pipeline: cap the recipe at 12 steps -> split into 1-4 strips of ~3
// steps -> the LLM writes one style-locked panel description per step -> an
// image provider paints each strip as a multi-panel comic page.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_STEPS, PANELS_PER_CHUNK, MAX_CHUNKS, normalizeSteps, planChunks } from "./src/chunk.js";
import { condenseSteps, authorPanels, llmConfigured, LLM_MODEL } from "./src/llm.js";
import { buildImagePrompt, seedFor, STYLE_NAME } from "./src/style.js";
import { renderStrip, providerStatus } from "./src/image/index.js";
import { normalizeRecipe, newId, slugify, CATEGORIES } from "./src/recipe.js";
import * as db from "./src/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, "..");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8mb" }));

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  if(req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const wrap = handler => (req, res) => handler(req, res).catch(e => {
  console.error(`[${req.method} ${req.path}]`, e);
  res.status(e.status || 500).json({ error: e.message || "Server error" });
});

// --- health & config -------------------------------------------------------

app.get("/api/health", wrap(async (req, res) => {
  let database = { configured: db.dbConfigured(), ok: false };
  if(db.dbConfigured()){
    try{
      database = { configured: true, ok: true, ...(await db.stats()) };
    }catch(e){
      database = { configured: true, ok: false, error: e.message };
    }
  }
  res.json({
    ok: true,
    service: "family-recipe-box",
    style: STYLE_NAME,
    llm: { configured: llmConfigured(), model: LLM_MODEL },
    image: providerStatus(),
    database,
    limits: { maxSteps: MAX_STEPS, panelsPerChunk: PANELS_PER_CHUNK, maxChunks: MAX_CHUNKS },
    uptime: Math.round(process.uptime())
  });
}));

app.get("/api/config", (req, res) => {
  res.json({
    comicsEnabled: llmConfigured(),
    categories: CATEGORIES,
    maxSteps: MAX_STEPS,
    panelsPerChunk: PANELS_PER_CHUNK,
    maxChunks: MAX_CHUNKS,
    imageProvider: providerStatus().active
  });
});

// --- comic generation ------------------------------------------------------

async function mapLimit(items, limit, worker){
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while(cursor < items.length){
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// Draws every strip for a recipe and stores the art against its id.
async function drawComics(recipe){
  const submitted = normalizeSteps(
    recipe.steps.map((textValue, idx) => ({ title: recipe.stepTitles[idx] || "", text: textValue }))
  );
  if(submitted.length === 0) return { comics: [], steps: [], plan: null };

  const { steps, condensed, by } = await condenseSteps(submitted, recipe.title, MAX_STEPS);
  const chunks = planChunks(steps);
  const concurrency = Number(process.env.COMIC_CONCURRENCY || 2);

  const comics = await mapLimit(chunks, concurrency, async chunk => {
    const panels = await authorPanels({
      recipeTitle: recipe.title,
      category: recipe.category,
      ingredients: recipe.ingredients,
      chunk,
      totalChunks: chunks.length
    });
    const prompt = buildImagePrompt({ recipeTitle: recipe.title, panels });
    const seed = seedFor(`${recipe.title}#${chunk.index}`);
    const image = await renderStrip({ prompt, panels, recipeTitle: recipe.title, seed });

    const imageId = `${recipe.id}-${chunk.index + 1}`;
    await db.putComicImage({
      id: imageId,
      recipeId: recipe.id,
      idx: chunk.index,
      mime: image.mime,
      base64: image.base64
    });

    return {
      index: chunk.index,
      url: `/api/images/${imageId}`,
      name: `${recipe.title} - part ${chunk.index + 1}`,
      stepRange: [chunk.startStep + 1, chunk.endStep + 1],
      provider: image.provider,
      panels: panels.map(panel => ({ stepIndex: panel.stepIndex, caption: panel.caption }))
    };
  });

  return {
    comics,
    steps,
    plan: {
      submittedSteps: submitted.length,
      usedSteps: steps.length,
      condensed,
      condensedBy: by || null,
      chunkCount: chunks.length,
      panelsPerChunk: chunks.map(chunk => chunk.steps.length)
    }
  };
}

// --- images ----------------------------------------------------------------

app.get("/api/images/:id", wrap(async (req, res) => {
  const image = await db.getComicImage(req.params.id);
  if(!image) return res.status(404).json({ error: "Image not found" });
  res.set("Content-Type", image.mime);
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.send(image.bytes);
}));

// --- recipes ---------------------------------------------------------------

app.get("/api/recipes", wrap(async (req, res) => {
  res.json({ ok: true, recipes: await db.listRecipes() });
}));

app.get("/api/recipes/:id", wrap(async (req, res) => {
  const recipe = await db.getRecipe(req.params.id);
  if(!recipe) return res.status(404).json({ error: "Recipe not found" });
  res.json({ ok: true, recipe });
}));

// Stores the recipe, then optionally draws its art and stores it again.
// The row has to exist first: comic_images references recipes(id).
async function persistWithComics(recipe, wantComics){
  let saved = await db.upsertRecipe(recipe);
  if(!wantComics || !recipe.steps.length) return { recipe: saved, plan: null };

  try{
    const drawn = await drawComics(recipe);
    if(!drawn.comics.length) return { recipe: saved, plan: drawn.plan };
    // Condensing may have rewritten the step list; keep what was drawn.
    recipe.steps = drawn.steps.map(step => step.text);
    recipe.stepTitles = drawn.steps.map(step => step.title || step.text);
    recipe.comics = drawn.comics;
    saved = await db.upsertRecipe(recipe);
    return { recipe: saved, plan: drawn.plan };
  }catch(e){
    // Art is a bonus, never a gate on saving the recipe.
    console.error("[comics]", e.message);
    return { recipe: saved, plan: { error: e.message } };
  }
}

// Shared by create and update: normalise, store, optionally draw.
async function saveRecipe({ body, existing, res }){
  const recipe = normalizeRecipe(body, existing);
  const wantComics = body.generateComics !== false && llmConfigured();
  const { recipe: saved, plan } = await persistWithComics(recipe, wantComics);
  res.json({ ok: true, recipe: saved, plan });
}

app.post("/api/recipes", wrap(async (req, res) => {
  const body = req.body || {};
  if(!String(body.title || "").trim()) return res.status(400).json({ error: "A title is required." });
  await saveRecipe({ body: { ...body, id: newId() }, existing: null, res });
}));

app.put("/api/recipes/:id", wrap(async (req, res) => {
  const existing = await db.getRecipe(req.params.id);
  if(!existing) return res.status(404).json({ error: "Recipe not found" });
  const body = req.body || {};
  if(body.generateComics !== false) await db.deleteComicImages(req.params.id);
  await saveRecipe({ body: { ...body, id: req.params.id }, existing, res });
}));

app.delete("/api/recipes/:id", wrap(async (req, res) => {
  const removed = await db.deleteRecipe(req.params.id);
  if(!removed) return res.status(404).json({ error: "Recipe not found" });
  res.json({ ok: true });
}));

// --- bulk import / export --------------------------------------------------

app.get("/api/export", wrap(async (req, res) => {
  const recipes = await db.listRecipes();
  res.set("Content-Disposition", 'attachment; filename="family-recipe-box.json"');
  res.json({ format: "family-recipe-box.export.v2", exportedAt: new Date().toISOString(), recipes });
}));

app.post("/api/import", wrap(async (req, res) => {
  const body = req.body || {};
  const incoming = Array.isArray(body) ? body
    : Array.isArray(body.recipes) ? body.recipes
    : body.recipe ? [body.recipe]
    : [body];

  const withComics = body.generateComics === true && llmConfigured();
  const saved = [];
  for(const raw of incoming.filter(Boolean)){
    const recipe = normalizeRecipe({ ...raw, id: raw.id || newId() });
    const result = await persistWithComics(recipe, withComics);
    saved.push(result.recipe);
  }
  res.json({ ok: true, imported: saved.length, recipes: saved });
}));

// Draws (or redraws) art for one stored recipe.
app.post("/api/recipes/:id/comics", wrap(async (req, res) => {
  const existing = await db.getRecipe(req.params.id);
  if(!existing) return res.status(404).json({ error: "Recipe not found" });
  if(!llmConfigured()) return res.status(503).json({ error: "OPENROUTER_API_KEY is not configured." });

  await db.deleteComicImages(req.params.id);
  const drawn = await drawComics(existing);
  existing.steps = drawn.steps.map(step => step.text);
  existing.stepTitles = drawn.steps.map(step => step.title || step.text);
  existing.comics = drawn.comics;
  const saved = await db.upsertRecipe(existing);
  res.json({ ok: true, recipe: saved, plan: drawn.plan });
}));

// --- static site -----------------------------------------------------------

app.use(express.static(SITE_ROOT, { extensions: ["html"], index: "index.html" }));
app.get("*", (req, res, next) => {
  if(req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(SITE_ROOT, "index.html"));
});

const port = process.env.PORT || 3000;

async function start(){
  if(db.dbConfigured()){
    try{
      await db.initSchema();
      console.log("[recipe-box] database ready");
    }catch(e){
      console.error("[recipe-box] database init failed:", e.message);
    }
  }else{
    console.warn("[recipe-box] DATABASE_URL not set - recipe storage disabled");
  }
  app.listen(port, "0.0.0.0", () => {
    console.log(`[recipe-box] listening on ${port}`);
    console.log(`[recipe-box] llm=${llmConfigured() ? LLM_MODEL : "off"} image=${providerStatus().active}`);
  });
}

start();

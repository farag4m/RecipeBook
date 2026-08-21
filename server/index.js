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
import { condenseSteps, authorPanels, llmConfigured, llmStatus, LLM_MODEL } from "./src/llm.js";
import { buildPanelPrompt, buildCoverPrompt, seedFor, STYLE_NAME } from "./src/style.js";
import { renderStrip, providerStatus, providersReady } from "./src/image/index.js";
import { normalizeRecipe, newId, slugify, CATEGORIES } from "./src/recipe.js";
import { composeComicSvg, composePanelSvg } from "./src/comic/compose.js";
import { parseRecipeText } from "./src/parse.js";
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
      database.artQueue = await db.artQueueDepth();
    }catch(e){
      database = { configured: true, ok: false, error: e.message };
    }
  }
  res.json({
    ok: true,
    service: "family-recipe-box",
    style: STYLE_NAME,
    llm: { configured: llmConfigured(), ...llmStatus() },
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

  // One image per step. A three-panel strip collapses to slivers on a phone,
  // so each step gets its own full-bleed panel that can fill the screen.
  const comics = await mapLimit(chunks, concurrency, async chunk => {
    const panels = await authorPanels({
      recipeTitle: recipe.title,
      category: recipe.category,
      ingredients: recipe.ingredients,
      chunk,
      totalChunks: chunks.length
    });

    const drawn = [];
    for(const [i, panel] of panels.entries()){
      const stepIndex = chunk.startStep + i;
      const step = chunk.steps[i];
      const imageId = `${recipe.id}-${chunk.index + 1}-${i + 1}`;
      const prompt = buildPanelPrompt({
        recipeTitle: recipe.title,
        scene: panel.scene,
        index: stepIndex,
        total: steps.length
      });

      try{
        const image = await renderStrip({
          prompt,
          panels: [panel],
          recipeTitle: recipe.title,
          seed: seedFor(`${recipe.title}#${stepIndex}`)
        });
        await db.putComicImage({
          id: imageId,
          recipeId: recipe.id,
          idx: stepIndex,
          mime: image.mime,
          base64: image.base64,
          captions: [{ n: stepIndex + 1, text: step?.text || panel.caption }]
        });
        drawn.push({
          stepIndex,
          url: `/api/images/${imageId}`,
          caption: panel.caption,
          provider: image.provider
        });
      }catch(e){
        console.error(`[panel ${imageId}]`, e.message);
      }
    }

    return {
      index: chunk.index,
      name: `${recipe.title} - part ${chunk.index + 1}`,
      stepRange: [chunk.startStep + 1, chunk.endStep + 1],
      provider: drawn[0]?.provider || null,
      panels: drawn
    };
  });

  let cover = null;
  try{
    cover = await drawCover({ ...recipe, steps: steps.map(step => step.text) });
  }catch(e){
    console.error("[cover]", e.message);
  }

  return {
    comics: comics.filter(c => c.panels.length),
    cover,
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

// Draws the plated hero shot used on the recipe card.
async function drawCover(recipe){
  const prompt = buildCoverPrompt({
    recipeTitle: recipe.title,
    ingredients: recipe.ingredients
  });
  const image = await renderStrip({
    prompt, panels: [], recipeTitle: recipe.title,
    seed: seedFor(`${recipe.title}#cover`),
    // Panels want hands in shot; a plated cover does not.
    negative: ["hands", "fingers", "arms", "holding a plate", "cooking in progress", "raw ingredients"]
  });

  // The storyboard fallback letters captions onto a blank page. A cover has
  // no captions, so it would render an empty file - better no cover at all,
  // since the card then falls back to a real panel.
  if(image.provider === "svg"){
    throw new Error("no image provider available for a cover");
  }
  const id = `${recipe.id}-cover`;
  await db.putComicImage({
    id, recipeId: recipe.id, idx: -1,
    mime: image.mime, base64: image.base64, captions: []
  });
  return { url: `/api/images/${id}`, provider: image.provider };
}

// --- images ----------------------------------------------------------------

app.get("/api/images/:id", wrap(async (req, res) => {
  const image = await db.getComicImage(req.params.id);
  if(!image) return res.status(404).json({ error: "Image not found" });

  const captions = Array.isArray(image.captions) ? image.captions : [];
  if(req.query.raw === "1" || image.mime === "image/svg+xml"){
    res.set("Content-Type", image.mime);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(image.bytes);
  }

  res.set("Cache-Control", "public, max-age=300");
  res.set("Content-Type", "image/svg+xml");

  // One panel at a time. Art drawn as a wide strip is cropped down to the
  // requested panel so it can fill a narrow screen instead of shrinking.
  // plain=1 drops the lettering, for thumbnails where a speech bubble is noise.
  // Art drawn one image per step carries a single caption, and must letter as
  // a panel (speech bubble) rather than as a whole strip (narration boxes).
  const requested = Number.parseInt(req.query.panel, 10);
  const panel = Number.isInteger(requested) ? requested : (captions.length === 1 ? 0 : NaN);
  const plain = req.query.plain === "1";
  if(Number.isInteger(panel) && captions.length){
    return res.send(composePanelSvg({
      bytes: image.bytes,
      mime: image.mime,
      caption: plain ? null : captions[Math.min(Math.max(0, panel), captions.length - 1)],
      panelIndex: panel,
      panelCount: captions.length
    }));
  }

  if(captions.length){
    return res.send(composeComicSvg({ bytes: image.bytes, mime: image.mime, captions }));
  }

  res.set("Content-Type", image.mime);
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

  // Every image provider is out of allowance: queue the art rather than
  // saving a placeholder the author never asked for.
  if(!providersReady()){
    await db.enqueueArt(recipe.id, "image allowance spent at save time");
    saved = await db.upsertRecipe({ ...recipe, artPending: true });
    return { recipe: saved, plan: { queued: true, reason: "image allowance spent" } };
  }

  try{
    const drawn = await drawComics(recipe);
    // Panel failures are collected rather than thrown, so an empty result is
    // the normal shape of "nothing could be drawn" - queue it.
    if(!drawn.comics.length){
      await db.enqueueArt(recipe.id, "no panels could be drawn");
      saved = await db.upsertRecipe({ ...recipe, artPending: true });
      return { recipe: saved, plan: { ...(drawn.plan || {}), queued: true } };
    }
    // Condensing may have rewritten the step list; keep what was drawn.
    recipe.steps = drawn.steps.map(step => step.text);
    recipe.stepTitles = drawn.steps.map(step => step.title || step.text);
    recipe.comics = drawn.comics;
    if(drawn.cover) recipe.cover = drawn.cover;
    recipe.artPending = false;
    saved = await db.upsertRecipe(recipe);
    await db.finishArtJob(recipe.id);
    return { recipe: saved, plan: drawn.plan };
  }catch(e){
    // Art is a bonus, never a gate on saving the recipe - but it should not
    // be lost either, so a failure joins the queue.
    console.error("[comics]", e.message);
    await db.enqueueArt(recipe.id, e.message);
    saved = await db.upsertRecipe({ ...recipe, artPending: true });
    return { recipe: saved, plan: { queued: true, error: e.message } };
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

// --- smart add ------------------------------------------------------------

// Parse only: the result goes back to the browser for review before saving.
app.post("/api/parse", wrap(async (req, res) => {
  if(!llmConfigured()) return res.status(503).json({ error: "No text model is configured." });
  const parsed = await parseRecipeText((req.body || {}).text);
  res.json({ ok: true, recipe: parsed });
}));

// Redraws just the card cover, without touching the panels.
app.post("/api/recipes/:id/cover", wrap(async (req, res) => {
  const existing = await db.getRecipe(req.params.id);
  if(!existing) return res.status(404).json({ error: "Recipe not found" });
  existing.cover = await drawCover(existing);
  const saved = await db.upsertRecipe(existing);
  res.json({ ok: true, recipe: saved });
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
  if(!llmConfigured()) return res.status(503).json({ error: "No text model is configured." });

  await db.deleteComicImages(req.params.id);
  const drawn = await drawComics(existing);
  existing.steps = drawn.steps.map(step => step.text);
  existing.stepTitles = drawn.steps.map(step => step.title || step.text);
  existing.comics = drawn.comics;
  if(drawn.cover) existing.cover = drawn.cover;
  const saved = await db.upsertRecipe(existing);
  res.json({ ok: true, recipe: saved, plan: drawn.plan });
}));

// --- static site -----------------------------------------------------------

app.use(express.static(SITE_ROOT, { extensions: ["html"], index: "index.html" }));
app.get("*", (req, res, next) => {
  if(req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(SITE_ROOT, "index.html"));
});

// --- queued art worker -----------------------------------------------------

// Drains the queue whenever a provider has allowance again. Cloudflare's
// allowance returns at UTC midnight, so a slow poll is plenty.
const WORKER_MS = Number(process.env.ART_WORKER_MS || 300000);

async function drainArtQueue(){
  if(!db.dbConfigured() || !llmConfigured()) return;
  if(!providersReady()) return;

  let job;
  while((job = await db.claimArtJob())){
    const recipe = await db.getRecipe(job.recipe_id);
    if(!recipe){ await db.finishArtJob(job.recipe_id); continue; }

    console.log(`[art-queue] drawing ${recipe.title} (attempt ${job.attempts})`);
    try{
      const drawn = await drawComics(recipe);
      if(!drawn.comics.length) throw new Error("no panels could be drawn");
      recipe.steps = drawn.steps.map(step => step.text);
      recipe.stepTitles = drawn.steps.map(step => step.title || step.text);
      recipe.comics = drawn.comics;
      if(drawn.cover) recipe.cover = drawn.cover;
      recipe.artPending = false;
      await db.upsertRecipe(recipe);
      await db.finishArtJob(recipe.id);
      console.log(`[art-queue] finished ${recipe.title}`);
    }catch(e){
      console.error(`[art-queue] ${recipe.title} failed: ${e.message}`);
      await db.failArtJob(recipe.id, e.message, providersReady() ? 10 : 60);
      if(!providersReady()) break;   // allowance went during this job
    }
  }
}

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
  setInterval(() => drainArtQueue().catch(e => console.error("[art-queue]", e.message)), WORKER_MS);
  setTimeout(() => drainArtQueue().catch(() => {}), 15000);

  app.listen(port, "0.0.0.0", () => {
    console.log(`[recipe-box] listening on ${port}`);
    console.log(`[recipe-box] llm=${llmStatus().providers.join(">") || "off"} image=${providerStatus().active}`);
  });
}

start();

// The Family Recipe Box - comic generation service.
//
// Pipeline: cap the recipe at 12 steps -> split into 1-4 strips of ~3 steps
// -> Groq writes one style-locked panel description per step -> an image
// provider paints each strip as a multi-panel comic page.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_STEPS, PANELS_PER_CHUNK, MAX_CHUNKS, normalizeSteps, planChunks } from "./src/chunk.js";
import { condenseSteps, authorPanels, groqConfigured, GROQ_MODEL } from "./src/groq.js";
import { buildImagePrompt, seedFor, STYLE_NAME } from "./src/style.js";
import { renderStrip, providerStatus } from "./src/image/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, "..");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// The static site can also be hosted on GitHub Pages, so allow cross-origin use.
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if(req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- health & config -------------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "family-recipe-box-comics",
    style: STYLE_NAME,
    groq: { configured: groqConfigured(), model: GROQ_MODEL },
    image: providerStatus(),
    limits: { maxSteps: MAX_STEPS, panelsPerChunk: PANELS_PER_CHUNK, maxChunks: MAX_CHUNKS },
    uptime: Math.round(process.uptime())
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    enabled: groqConfigured(),
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

app.post("/api/comics", async (req, res) => {
  const started = Date.now();
  try{
    if(!groqConfigured()){
      return res.status(503).json({ error: "GROQ_API_KEY is not configured on the server." });
    }

    const body = req.body || {};
    const recipeTitle = String(body.title || "").trim() || "Untitled Recipe";
    const category = String(body.category || "").trim();
    const ingredients = (Array.isArray(body.ingredients) ? body.ingredients : [])
      .map(item => String(item || "").trim()).filter(Boolean);

    const submitted = normalizeSteps(body.steps);
    if(submitted.length === 0){
      return res.status(400).json({ error: "At least one step is required." });
    }

    const { steps, condensed, by } = await condenseSteps(submitted, recipeTitle, MAX_STEPS);
    const chunks = planChunks(steps);

    // Kept low so a burst of strips does not trip Groq's per-minute cap.
    const concurrency = Number(process.env.COMIC_CONCURRENCY || 2);
    const comics = await mapLimit(chunks, concurrency, async chunk => {
      const panels = await authorPanels({
        recipeTitle, category, ingredients, chunk, totalChunks: chunks.length
      });
      const prompt = buildImagePrompt({ recipeTitle, panels });
      const seed = seedFor(`${recipeTitle}#${chunk.index}`);
      const image = await renderStrip({ prompt, panels, recipeTitle, seed });

      return {
        index: chunk.index,
        stepRange: [chunk.startStep + 1, chunk.endStep + 1],
        steps: chunk.steps,
        panels,
        prompt,
        provider: image.provider,
        image: { mime: image.mime, base64: image.base64 }
      };
    });

    res.json({
      ok: true,
      title: recipeTitle,
      style: STYLE_NAME,
      plan: {
        submittedSteps: submitted.length,
        usedSteps: steps.length,
        condensed,
        condensedBy: by || null,
        chunkCount: chunks.length,
        panelsPerChunk: chunks.map(chunk => chunk.steps.length)
      },
      steps,
      comics,
      tookMs: Date.now() - started
    });
  }catch(e){
    res.status(500).json({ error: e.message || "Comic generation failed", tookMs: Date.now() - started });
  }
});

// --- static site -----------------------------------------------------------

app.use(express.static(SITE_ROOT, { extensions: ["html"], index: "index.html" }));
app.get("*", (req, res, next) => {
  if(req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(SITE_ROOT, "index.html"));
});

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`[recipe-comics] listening on ${port}`);
  console.log(`[recipe-comics] groq=${groqConfigured() ? GROQ_MODEL : "NOT CONFIGURED"} image=${providerStatus().active}`);
});

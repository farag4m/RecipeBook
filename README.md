# The Family Recipe Box

A recipe box backed by JSON files in this GitHub repo, with AI-drawn comic
strips for the cooking steps.

## Features

- Reads recipes from the public `data` branch
- Writes recipes through the GitHub Contents API with each user's token
- Adds, edits, deletes, searches, filters, imports, and exports recipes
- Draws comic strips for the steps when a recipe is saved
- Shares individual recipes through browser share sheets or copyable links
- Opens shared recipe links for review and GitHub save

## How the comics work

When a recipe is saved, the browser posts its steps to the comic service:

1. The recipe is capped at **12 steps**. Longer recipes are condensed by Groq
   (merging closely related consecutive steps) so nothing is lost.
2. The steps are split into **1-4 strips of about 3 steps each**:
   1-3 steps → 1 strip, 4-6 → 2, 7-9 → 3, 10-12 → 4.
3. **Groq** writes one comic panel description per step, locked to the house
   art style (warm cream paper, watercolour over ink linework, hands only,
   orange action marks, no text).
4. An image model paints each strip as a single multi-panel comic page.
5. The browser commits each strip to the `data` branch and records it on the
   recipe, so the site keeps working as plain static JSON + PNG.

### Groq does not generate images

GroqCloud serves text, audio and vision-understanding models only - it has no
text-to-image endpoint. So Groq is the *brain* (condensing, panel scripts,
style-locked prompts) and a separate image model paints the pixels:

| Provider | Env var | Notes |
| --- | --- | --- |
| `gemini` | `GEMINI_API_KEY` | Default. Matches the existing hand-painted art. |
| `openai` | `OPENAI_API_KEY` | Optional alternative. |
| `pollinations` | none | Keyless, low fidelity, opt-in only. |
| `svg` | none | Built-in storyboard fallback so saving never fails. |

`IMAGE_PROVIDER=auto` picks the first configured provider and always falls
back to `svg`.

## Running the service locally

```bash
cd server
npm install
cp .env.example .env      # fill in GROQ_API_KEY and GEMINI_API_KEY
GROQ_API_KEY=... GEMINI_API_KEY=... npm start
```

Then open <http://localhost:3000>. The service also serves `index.html`, so
the frontend and API share an origin.

### API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Health check used by Render; reports Groq and image provider status |
| `GET /api/config` | Public limits for the frontend |
| `POST /api/comics` | `{title, category, ingredients, steps[]}` → generated strips as base64 |

## Deploying to Render

Live: <https://family-recipe-box.onrender.com>

The repo ships a Blueprint (`render.yaml`): one free web service that serves
both the static site and the API.

1. In Render, create a **Blueprint** from this repo.
2. Set `GROQ_API_KEY` and `GEMINI_API_KEY` in the service environment.
3. Render builds `server/` and serves the site at the service URL.

Health checks hit `/api/health`. Free services sleep when idle, so the first
request after a quiet period takes about a minute.

## GitHub Data

Recipes live as files under:

```text
users/<github-username>/recipes/<recipe-slug>.json
```

Generated comic strips live as PNG files under:

```text
comics/<recipe-slug>/strip-<n>.png
```

Family members need collaborator access to the repo and a fine-grained GitHub
token with `Contents: Read and write` for this repo. Public reads do not
require a token.

## Recipe JSON Format

```json
{
  "format": "family-recipe-box.recipe.v1",
  "title": "Mujadara",
  "category": "Mains",
  "servings": "4",
  "contributor": "Aunt Rosa",
  "ingredients": [
    {
      "text": "1 cup brown or green lentils",
      "step": {
        "title": "Rinse lentils",
        "text": "Rinse lentils, then boil for 15 minutes until just tender."
      }
    }
  ],
  "steps": [
    {"title": "Serve", "text": "Fluff everything together and serve warm."}
  ],
  "comics": [
    {
      "path": "comics/mujadara/strip-1.png",
      "name": "Mujadara - part 1",
      "stepRange": [1, 3],
      "panels": [{"stepIndex": 0, "caption": "Rinse and boil lentils"}]
    }
  ],
  "notes": "Comics are drawn on save - leave them out when importing."
}
```

Each ingredient can carry a `step` object or `steps` array. Those ingredient
steps become the displayed recipe steps in ingredient order. Top-level `steps`
are optional extras after the ingredient steps. Imports also accept older
string arrays for `ingredients` and `steps`, plus `{recipe: ...}` or
`{recipes: [...]}` wrappers. Leave `comics` out of imported JSON - the app
draws them.

## GitHub Pages

The static site can still be hosted by the manual GitHub Pages workflow in
`.github/workflows/pages.yml`. In that case set the Comic Service URL in the
app's GitHub Access settings to the Render service URL.

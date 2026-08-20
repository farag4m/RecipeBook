# The Family Recipe Box

A recipe box with AI-drawn comic strips for the cooking steps. No sign-in, no
accounts, no tokens - recipes and their artwork live on the server.

Live: <https://family-recipe-box.onrender.com>

## Features

- Add, edit, delete, search, filter, import, and export recipes
- Draws comic strips for the steps when a recipe is saved
- Redraws the art for any recipe on demand
- Shares a recipe by link
- No login of any kind

## How the comics work

When a recipe is saved, the server:

1. Caps it at **12 steps**. Longer recipes are condensed by Groq (merging
   closely related consecutive steps), falling back to a local merge if the
   model over-condenses.
2. Splits the steps into **1-4 strips of about 3 steps each**:
   1-3 steps → 1 strip, 4-6 → 2, 7-9 → 3, 10-12 → 4.
3. Has the **text model** write one comic panel description per step, locked
   to the house art style (warm cream paper, watercolour over ink linework,
   hands only, orange action marks, no text).
4. Paints each strip as a single multi-panel comic page.
5. Stores the image in Postgres and serves it from `/api/images/:id`.

### One key, both halves

Everything runs through **OpenRouter**: a text model writes the panel scripts
and an image model on the same key paints them.

| Setting | Default |
| --- | --- |
| `OPENROUTER_TEXT_MODEL` | `google/gemini-2.5-flash` |
| `OPENROUTER_IMAGE_MODEL` | `google/gemini-3.1-flash-image` |

Text and image generation are separate capabilities, and not every provider
offers both - Groq, for instance, serves text, audio and vision-understanding
models but has no text-to-image endpoint at all. OpenRouter is used here
precisely because it fronts models for both.

Fallback renderers, tried in order when OpenRouter is unset or failing:

| Provider | Env var | Notes |
| --- | --- | --- |
| `openrouter` | `OPENROUTER_API_KEY` | Default. |
| `gemini` | `GEMINI_API_KEY` | Direct to Google. |
| `openai` | `OPENAI_API_KEY` | Direct to OpenAI. |
| `pollinations` | none | Keyless, low fidelity, opt-in only. |
| `svg` | none | Built-in storyboard fallback so saving never fails. |

`IMAGE_PROVIDER=auto` picks the first configured provider and always falls
back to `svg`.

## Storage

Everything durable is in Postgres - Render's free web services have no
persistent disk, so the filesystem cannot be used:

- `recipes` - one row per recipe, full document in a `jsonb` column
- `comic_images` - the strip artwork as `bytea`, cascading on recipe delete

> **Free Postgres expires 30 days after creation** and is deleted after a
> further 14-day grace period. Upgrade the database, or export regularly via
> `GET /api/export`, or the recipes will be lost.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Health check; reports model, image provider, and database status |
| `GET /api/config` | Public limits and categories |
| `GET /api/recipes` | List all recipes |
| `GET /api/recipes/:id` | One recipe |
| `POST /api/recipes` | Create; draws comics unless `generateComics: false` |
| `PUT /api/recipes/:id` | Update; redraws comics unless `generateComics: false` |
| `DELETE /api/recipes/:id` | Delete a recipe and its art |
| `POST /api/recipes/:id/comics` | Redraw the art for a stored recipe |
| `GET /api/images/:id` | Serve one comic strip |
| `GET /api/export` | Download every recipe as JSON |
| `POST /api/import` | Bulk import; pass `generateComics: true` to draw art |

## Running locally

```bash
cd server
npm install
cp .env.example .env      # fill in the keys and a DATABASE_URL
npm start
```

Then open <http://localhost:3000>. The service also serves `index.html`, so
the frontend and API share an origin.

## Deploying to Render

The repo ships a Blueprint (`render.yaml`): one free web service plus a free
Postgres database.

1. In Render, create a **Blueprint** from this repo.
2. Set `OPENROUTER_API_KEY` in the service environment.
   `DATABASE_URL` is wired from the database automatically.

Health checks hit `/api/health`. Free services sleep when idle, so the first
request after a quiet period takes about a minute.

## Recipe JSON Format

```json
{
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
  "notes": "Comics are drawn on save - leave them out when importing."
}
```

Each ingredient can carry a `step` object or `steps` array. Those ingredient
steps become the displayed recipe steps in ingredient order. Top-level `steps`
are optional extras after them. Imports also accept plain string arrays, plus
`{recipe: ...}` or `{recipes: [...]}` wrappers.

# The Family Recipe Box

A static recipe box for GitHub Pages, backed by JSON files in this GitHub repo.

## Features

- Reads recipes from the public `data` branch
- Writes recipes through the GitHub Contents API with each user's token
- Adds, edits, deletes, searches, filters, imports, and exports recipes
- Stores reusable PNG step photos in GitHub and matches them to recipe steps
- Shares individual recipes through browser share sheets or copyable links
- Opens shared recipe links for review and GitHub save
- Runs with no backend server, database, API key, or build step

## GitHub Data

Recipes live as files under:

```text
users/<github-username>/recipes/<recipe-slug>.json
```

Step photos live as PNG files under:

```text
photos/<photo-name>.png
```

Photo filenames are used for matching. For example, `cutting onions.png` can be matched to a step that mentions cutting onions.

Family members need collaborator access to the repo and a fine-grained GitHub token with `Contents: Read and write` for this repo. Public reads do not require a token.

## Recipe JSON Format

New saves use this format:

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
        "text": "Rinse lentils, then boil for 15 minutes until just tender.",
        "image": {"path": "photos/rinse lentiles.png", "name": "rinse lentiles"}
      }
    },
    {
      "text": "1 cup basmati rice",
      "step": {
        "title": "Wash rice",
        "text": "Rinse rice until the water runs clear.",
        "image": {"path": "photos/wash rice.png", "name": "wash rice"}
      }
    }
  ],
  "steps": [
    {"title": "Serve", "text": "Fluff everything together and serve warm."}
  ],
  "notes": "Ingredient steps display in ingredient order. Use existing photo paths from the Photos tab, or omit image to let the app match one."
}
```

Each ingredient can carry a `step` object or `steps` array. Those ingredient steps become the displayed recipe steps in ingredient order. Top-level `steps` are optional extras after the ingredient steps. Imports also accept older string arrays for `ingredients` and `steps`, plus `{recipe: ...}` or `{recipes: [...]}` wrappers.

## GitHub Pages

The site is deployed by the manual GitHub Pages workflow in `.github/workflows/pages.yml`.

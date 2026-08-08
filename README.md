# The Family Recipe Box

A static recipe box for GitHub Pages, backed by JSON files in this GitHub repo.

## Features

- Reads recipes from the public `data` branch
- Writes recipes through the GitHub Contents API with each user's token
- Adds, edits, deletes, searches, filters, imports, and exports recipes
- Shares individual recipes through browser share sheets or copyable links
- Opens shared recipe links for review and GitHub save
- Runs with no backend server, database, API key, or build step

## GitHub Data

Recipes live as files under:

```text
users/<github-username>/recipes/<recipe-slug>.json
```

Family members need collaborator access to the repo and a fine-grained GitHub token with `Contents: Read and write` for this repo. Public reads do not require a token.

## GitHub Pages

The site is deployed by the manual GitHub Pages workflow in `.github/workflows/pages.yml`.

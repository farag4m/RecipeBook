# The Family Recipe Box

A static, browser-only recipe box for GitHub Pages.

## Features

- Saves recipes in the visitor's browser with `localStorage`
- Adds, edits, deletes, searches, filters, imports, and exports recipes
- Shares individual recipes through browser share sheets or copyable links
- Imports shared recipe links directly into the recipient's local recipe box
- Optionally attempts a background backup POST to a user-provided endpoint
- Runs with no backend server, database, API key, or build step

## Optional Backup Endpoint

The app can try to POST the recipe box JSON to a configured URL about once per week, retrying at most once per day until the browser can send the request. This is optional and the app never depends on it.

Because the site is served over HTTPS, browsers may block backup URLs that are plain HTTP, local-network-only, missing CORS support, or unreachable while the laptop is off.

## GitHub Pages

This site is intended to be served from the repository root on the `main` branch.

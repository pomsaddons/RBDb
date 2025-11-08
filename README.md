# RBDb Browser Extension

RBDb adds a community-driven 5★ rating widget to Roblox experience pages and stores feedback through the companion Node.js backend.

## Features
- Injects a modern rating panel right below Roblox's voting interface
- Reads and writes data through the RBDb backend (`services/rbdb-backend`)
- Works with both light and dark Roblox themes
- Fully client-side content script – no background or popup UI required

## Prerequisites
- Node.js 18.18 or newer (matching the backend requirement)
- npm (ships with Node)

If you have not set up the backend yet, follow the instructions in the repository root README under **Backend API (Node.js)**.

## Project structure
```
rbdb-extension/
├── package.json          # npm scripts and dev dependencies
├── tsconfig.json         # TypeScript compilation config
├── src/content.ts        # Rating widget content script
├── public/
│   ├── manifest.json     # Chrome MV3 manifest
│   ├── content.css       # Widget styling
│   └── icons/icon.png    # Extension icon
└── scripts/copy-static.mjs # Copies static assets into dist/
```

## Build steps
Install dependencies once:

```bash
npm install
```

Build the extension bundle (outputs to `dist/`):

```bash
npm run build
```

### Firefox build
Generate a Firefox-friendly bundle (outputs to `dist-firefox/`):

```bash
npm run build:firefox
```

### Custom backend origin
By default the widget targets `http://localhost:4000`. To point it at a different API, define `RBDB_BACKEND_URL` before the Roblox page loads (for example through another content script or a snippet injected by your deployment).

## Load into Chrome/Edge
1. Run `npm run build`.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the generated `dist/` folder.
5. Navigate to any Roblox experience page (e.g. `https://www.roblox.com/games/<placeId>/...`).

A new "RBDb community" card will appear underneath the existing vote controls.

## Development tips
- `npm run type-check` runs TypeScript without emitting files.
- The build script copies everything under `public/` verbatim into `dist/`, so you can place additional assets there if needed.
- Roblox sometimes reuses the same document via AJAX navigation; if your widget disappears, refresh the page to rerun the content script.

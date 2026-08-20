# NVIS × Mapbox — Vegetation Map POC

A proof of concept for getting NVIS Major Vegetation Group (MVG) data onto an
interactive web map via Mapbox.

- **Vue 3 + Mapbox GL JS app** (`src`) — renders the map with a legend, layer
  toggle, opacity, base-map switch, and click-to-identify.
- **Node scripts** (`scripts`) — automate the Mapbox workflow: prep the data,
  upload, build the recipe, publish, poll the job.

Data is served as vector tiles: each feature carries only the integer `mvg`
code, and the app resolves names and colours locally from a legend table.

## Processing pipeline (source raster → vector tiles → Mapbox)

1. **Warp** the single-band categorical NVIS GeoTIFF to EPSG:3857
   (nearest-neighbour, to preserve class codes).
2. **Sieve** out salt-and-pepper speck clusters — the biggest lever on tile size.
3. **Polygonise** into features carrying a single integer `mvg` property.
4. **Simplify** polygons (Douglas-Peucker) and reproject to EPSG:4326, dropping
   no-data classes, out to line-delimited GeoJSON.
5. **Tile** with tippecanoe into `.mbtiles` (`--drop-densest-as-needed` keeps
   every tile under Mapbox's 500 KB limit).
6. **Upload & publish** to Mapbox Tiling Service — delete the old source, upload,
   apply the recipe, publish, and poll the job to completion.

## Tech used

Vue 3, Vite, Mapbox GL JS, Mapbox Tiling Service (MTS), Node.js (ES modules),
GDAL (via `gdal-async`, no system install), and tippecanoe.

---

## Getting it running

### You need

- **Node.js ≥ 20.12** — runs the app and all scripts.
- **A Mapbox account** (free tier is plenty) with two tokens:
  - a **public** token (`pk.…`) for the browser app,
  - a **secret** token (`sk.…`) with `tilesets:write`, `tilesets:read`,
    `tilesets:list` for the upload scripts.
- **No GDAL install needed** — the prep step uses
  [`gdal-async`](https://www.npmjs.com/package/gdal-async), which ships its own
  GDAL and is installed by `npm install`.

### Setup

```bash
npm install
cp .env.example .env      # then fill in your values
```

### Key `.env` values

- `VITE_MAPBOX_TOKEN` — public `pk.` token (browser).
- `VITE_NVIS_TILESET_ID` — the published tileset, `username.tileset_name`
  (printed at the end of upload).
- `MAPBOX_USERNAME` and `MAPBOX_SECRET_TOKEN` — for the upload scripts.
- Data paths (`PREP_INPUT_TIF`, etc.) and tuning knobs (target resolution, sieve
  area, simplify, zoom range) have sensible defaults.

### Run the app (against an existing tileset)

```bash
npm run dev        # http://localhost:5173
```

> No tileset published yet? The app still runs and shows the base map — add
> `VITE_NVIS_TILESET_ID` later and refresh.

### Rebuild and publish tiles (only if regenerating the data)

> `vec:build` tiles locally with **GDAL's MVT writer** (bundled in `gdal-async` —
> no tippecanoe, Docker or WSL needed).

```bash
npm run vec:prepare   # raster → simplified GeoJSON
npm run vec:build     # GeoJSON → .mbtiles (GDAL MVT writer)
npm run mb:upload     # upload + publish to Mapbox (Uploads API), poll the job
npm run mb:status     # check job status any time
```

### Good to know

- `mb:upload` uses the Mapbox **Uploads API** — it stages the `.mbtiles` and
  Mapbox publishes it as a new tileset version.
- Keep tiles under Mapbox's **500 KB** limit; that's what tippecanoe's
  `--drop-densest-as-needed` handles.
- **Never commit `.env`** — it holds your secret token (already in `.gitignore`).

---

## Project layout

```
mapbox-poc/
├─ index.html
├─ package.json
├─ vite.config.js
├─ .env.example            # copy to .env
├─ src/
│  ├─ main.js
│  ├─ App.vue              # layout, base-map state, token gate
│  ├─ style.css
│  ├─ components/
│  │  ├─ NvisVectorMap.vue # Mapbox GL JS map + NVIS vector layer
│  │  ├─ ControlsPanel.vue # opacity / visibility / base map
│  │  └─ LegendPanel.vue   # NVIS MVG legend
│  └─ data/
│     ├─ nvisMvgLegend.js       # MVG codes → names + colours
│     └─ nvisMvgExpressions.js  # data-driven fill paint expressions
└─ scripts/
   ├─ prepare-vector.mjs      # raster → sieve → polygonise → GeoJSON (gdal-async)
   ├─ build-mbtiles.mjs       # GeoJSON → .mbtiles (tippecanoe)
   ├─ upload-mbtiles.mjs      # .mbtiles → Mapbox Uploads API → publish → poll
   ├─ create-token.mjs        # Tokens API → public pk token
   ├─ delete-source.mjs       # remove an MTS source before re-upload
   └─ lib/
      ├─ env.mjs              # tiny .env loader
      └─ mapbox.mjs           # fetch wrapper for the Mapbox API
```

---

## Costs, limits & timing (for the POC conversation)

- **Free tier** covers a generous amount of MTS processing/hosting and map loads;
  a single continental vector tileset is well within it. See
  <https://www.mapbox.com/pricing/#tilesets>.
- **Billing is per map *load*, not per tile or per zoom** — keeping z13 does not
  inflate hosting cost. A "load" = each `new mapboxgl.Map()`.
- **Tile size limit:** no tile may exceed **500 KB** at any zoom. tippecanoe's
  `--drop-densest-as-needed` keeps low zooms under budget.
- **File limits:** each source file ≤ 20 GB, total source ≤ 50 GB.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| App shows **“Base map only”** | `VITE_NVIS_TILESET_ID` isn’t set (or the job isn’t finished). Run `npm run mb:status`. |
| **401 / 403** from a script | The `sk.` token is missing scopes (`tilesets:write/read/list`, `uploads:write/read`). |
| Job **failed** with *tile exceeds 500 KB* | Raise `--drop-densest-as-needed` aggressiveness or lower max zoom in `build-mbtiles.mjs`, then rebuild. |
| Tiles **misplaced** | CRS issue. Ensure the GeoJSON is reprojected to `EPSG:4326` before tiling. |

---

## Reference docs

- Mapbox Tiling Service API — <https://docs.mapbox.com/api/maps/mapbox-tiling-service/>
- Vector recipe spec — <https://docs.mapbox.com/mapbox-tiling-service/recipe-specification/>
- tippecanoe — <https://github.com/felt/tippecanoe>
- Tokens API — <https://docs.mapbox.com/api/accounts/tokens/>

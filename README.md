# NVIS × Mapbox — Vegetation Map POC

A proof of concept for getting NVIS Major Vegetation Group (MVG) data onto an
interactive web map via Mapbox.

- **Vue 3 + Mapbox GL JS app** (`src`) — renders the map with a legend, layer
  toggle, opacity, base-map switch, and click-to-identify.
- **tippecanoe toolchain** ([`tippecanoe/dcceew`](tippecanoe/dcceew)) — the build
  that produced the live vector tileset: convert the NVIS geodatabase, join the
  MVG codes, simplify, tile with tippecanoe, and publish.
- **Node scripts** (`scripts`) — a superseded, install-free GDAL-MVT build path
  plus small helpers (token creation, source cleanup).

Data is served as vector tiles: each feature carries only the integer `mvg`
code, and the app resolves names and colours locally from a legend table.

## Processing pipeline (NVIS geodatabase → vector tiles → Mapbox)

The published tileset (`kevinthiele.nvis_mvg_vector`, z9–13) was built with
**tippecanoe**. The full toolchain and its hard-won notes live in
[`tippecanoe/dcceew`](tippecanoe/dcceew) (`HANDOFF.md`, `LESSONS_AND_WORKFLOW.md`).

1. **Convert + join** — for each of the 8 state layers in the NVIS v7.0 vector
   geodatabase, `ogr2ogr` extracts `NVISDSC1` + geometry and reprojects to
   EPSG:4326; [`map_mvg.py`](tippecanoe/dcceew/SAFE_KEEP/map_mvg.py) joins
   `NVISDSC1 → MVG` (via `nvis_id_to_mvg.json`) and rewrites each feature to a
   single integer `{"mvg": <code>}`. **21,315,015** polygons total.
2. **Pre-simplify** — `ogr2ogr -simplify 0.0001` (~11 m, one z13 pixel; visually
   invisible), cutting the data ~79% (71 GB → 15 GB).
3. **Tile** — tippecanoe (`-l mvg --drop-densest-as-needed
   --coalesce-densest-as-needed --simplification=30`), in a few ID-split pieces so
   scratch space fits.
4. **Join** — `tile-join` the pieces into one national `.mbtiles`.
5. **Publish** — [`publish-to-mapbox.sh`](tippecanoe/dcceew/publish-to-mapbox.sh)
   uploads via the Mapbox **Uploads API** (staging creds → S3 → ingest → poll).

The app pairs this with a raster overview tileset (`kevinthiele.nvis_mvg`, z0–8):
it shows raster below z9 and vector at z9+.

## Tech used

Vue 3, Vite, Mapbox GL JS, Mapbox Uploads API, **tippecanoe** (via WSL2), GDAL /
`ogr2ogr`, Python 3, and Node.js (ES modules; `gdal-async` for the fallback build,
no system GDAL needed for the app).

---

## Getting it running

### You need

- **Node.js ≥ 20.12** — runs the app and the fallback scripts.
- **A Mapbox account** (free tier is plenty) with two tokens:
  - a **public** token (`pk.…`) for the browser app,
  - a **secret** token (`sk.…`) with `uploads:write` + `uploads:read` (and
    `tilesets:read/list`) for publishing.
- **To run the app / fallback build:** no GDAL install needed — the Node scripts
  use [`gdal-async`](https://www.npmjs.com/package/gdal-async), installed by
  `npm install`.
- **To run the canonical tippecanoe build:** a Linux/WSL2 environment with
  **tippecanoe**, **GDAL/`ogr2ogr`** and **Python 3** (see
  [`tippecanoe/dcceew/HANDOFF.md`](tippecanoe/dcceew/HANDOFF.md)).

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

The canonical build is the **tippecanoe** toolchain in
[`tippecanoe/dcceew`](tippecanoe/dcceew) — run on Linux/WSL2 with tippecanoe,
GDAL/`ogr2ogr` and Python 3. Start from its `HANDOFF.md`; the shape is:

```bash
# 1. convert + join each state (needs the NVIS geodatabase + SAFE_KEEP/*)
bash tippecanoe/dcceew/SAFE_KEEP/worker.sh <STATE> <LO_OBJECTID> <HI|->
# 2. pre-simplify: ogr2ogr -f GeoJSONSeq -simplify 0.0001 out.geojsonl in.geojsonl
# 3. tile with tippecanoe, then tile-join the pieces into one .mbtiles
# 4. publish (prompts for the sk. token at runtime)
bash tippecanoe/dcceew/publish-to-mapbox.sh nvis_mvg.mbtiles
```

> **Superseded fallback:** the Node `vec:prepare` → `vec:build` → `mb:upload`
> scripts tile locally with GDAL's MVT writer (no tippecanoe/WSL). They were the
> locked-down-machine attempt and did **not** ship the live tileset — kept only
> as an install-free fallback.
>
> ```bash
> npm run vec:prepare   # source → simplified GeoJSON
> npm run vec:build     # GeoJSON → .mbtiles (GDAL MVT writer)
> npm run mb:upload     # upload + publish (Uploads API), poll the job
> npm run mb:status     # check job status any time
> ```

### Good to know

- Publishing uses the Mapbox **Uploads API** — it stages the `.mbtiles` and
  Mapbox publishes it as a new tileset version.
- Keep tiles under Mapbox's **500 KB** limit; that's what tippecanoe's
  `--drop-densest-as-needed` handles.
- **Never commit `.env`** or `tippecanoe/dcceew/token.txt` — they hold secret
  tokens (`.env` is already in `.gitignore`).

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
├─ tippecanoe/dcceew/         # canonical build toolchain + notes (HANDOFF.md)
│  └─ SAFE_KEEP/              # worker.sh, map_mvg.py, nvis_id_to_mvg.json, palette
└─ scripts/                   # superseded GDAL-MVT fallback + helpers
   ├─ prepare-vector.mjs      # source → sieve → polygonise → GeoJSON (gdal-async)
   ├─ build-mbtiles.mjs       # GeoJSON → .mbtiles (GDAL MVT writer)
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
| Job **failed** with *tile exceeds 500 KB* | Rebuild with more aggressive `--drop-densest-as-needed` / higher `--simplification`, or narrow the zoom range, in the tippecanoe step. |
| Tiles **misplaced** | CRS issue. Ensure the GeoJSON is reprojected to `EPSG:4326` before tiling. |

---

## Reference docs

- Mapbox Uploads API — <https://docs.mapbox.com/api/maps/uploads/>
- tippecanoe — <https://github.com/felt/tippecanoe>
- NVIS v7.0 data — <https://fed.dcceew.gov.au/datasets/be9930d6de354ace93fd1aa5d34a71de/about>
- Tokens API — <https://docs.mapbox.com/api/accounts/tokens/>

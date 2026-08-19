# NVIS × Mapbox — Raster Tiling Proof of Concept

Upload the **NVIS v7.0 Major Vegetation Groups** GeoTIFF
(`NVIS7_0_AUST_EX_MVG.tif`, ~655 MB) to **Mapbox Tiling Service (MTS)** and view
it on an interactive **Vue 3 + Mapbox GL JS** map.

This repo gives you two things:

1. **A small Vue app** (`/src`) that renders the published raster tileset with
   opacity, layer‑toggle, base‑map switching and a full NVIS legend.
2. **Node scripts** (`/scripts`) that automate the Mapbox workflow end‑to‑end —
   create a token, upload the GeoTIFF, build the recipe, publish, and poll the
   job until the tiles are ready.

```
GeoTIFF  ──(GDAL: bake .clr → RGB)──▶  RGB GeoTIFF
   │
   └──(MTS: source → recipe → publish)──▶  Mapbox raster tileset  (username.nvis_mvg)
                                                    │
                                                    └──▶  Vue + Mapbox GL JS  (this app)
```

---

## ⭐ TL;DR (the 5‑minute demo path)

```bash
cd mapbox-poc
npm install
cp .env.example .env          # then paste your Mapbox tokens into .env

# 1. Colourise the raster → transparent-nodata RGBA COG (bundled GDAL, no install)
npm run mts:prepare
# 2. Upload + publish to Mapbox
npm run mts:upload
# 3. Run the app
npm run dev
```

> **Don’t have the tileset published yet?** No problem — the app still runs and
> shows the base map. Add `VITE_NVIS_TILESET_ID` later and refresh.

---

## Why a preprocessing step is required (read this!)

The raw `NVIS7_0_AUST_EX_MVG.tif` is a **single‑band, categorical raster**: each
pixel is an integer **MVG class** (1–32, plus 99 = no‑data). The colours live in
a **separate palette file**, `NVIS7_0_AUST_EX_MVG.clr`.

Mapbox’s `type: "raster"` tilesets expect an **8‑bit RGB(A) GeoTIFF** — the
recipe literally maps the *red / green / blue (/ alpha)* bands. So we first
**bake the `.clr` palette into the pixels** to produce an RGBA GeoTIFF (with the
ocean / no‑data made transparent), then upload that.

This is a one‑off step: **`npm run mts:prepare`**. It runs entirely in Node via
[`gdal-async`](https://www.npmjs.com/package/gdal-async) (which bundles GDAL), so
**no system GDAL install is required**. It also keeps the legend in this app
perfectly in sync with the map, because both use the same `.clr` values.

---

## Prerequisites

| Tool | Why | Notes |
| --- | --- | --- |
| **Node.js ≥ 20.12** | run the app + scripts | `node -v` |
| **A Mapbox account** | hosting the tiles | free tier is plenty for a POC |

> **No GDAL install needed.** The colourise step (`npm run mts:prepare`) uses
> [`gdal-async`](https://www.npmjs.com/package/gdal-async), which ships prebuilt
> GDAL binaries and is installed automatically by `npm install`. (If you prefer
> the classic GDAL CLI, the equivalent commands are in Step 3 below.)

---

## Mapbox tokens you’ll need

Mapbox uses two kinds of token (see
<https://docs.mapbox.com/api/accounts/tokens/>):

| Token | Starts with | Used by | Scopes |
| --- | --- | --- | --- |
| **Secret** | `sk.` | the upload scripts (server‑side) | `tilesets:write`, `tilesets:read`, `tilesets:list` (+ `tokens:write` if you use `token:create`) |
| **Public** | `pk.` | the browser app | default public scopes (`styles:tiles`, `styles:read`, `fonts:read`) |

Create them at <https://console.mapbox.com/account/access-tokens/>, or mint the
public one from the CLI:

```bash
npm run token:create     # prints a pk.… token to paste into .env
```

Put everything into `mapbox-poc/.env` (copied from `.env.example`). **Never
commit `.env`** — it’s already in `.gitignore`.

---

## Step‑by‑step

### Step 1 — Install

```bash
cd mapbox-poc
npm install
cp .env.example .env       # Windows: copy .env.example .env
```

### Step 2 — Fill in `.env`

At minimum set `MAPBOX_USERNAME`, `MAPBOX_SECRET_TOKEN`, and (for the app)
`VITE_MAPBOX_TOKEN`. The tileset/source IDs already have sensible defaults.

### Step 3 — Prepare the GeoTIFF (bake the palette → RGBA COG)

```bash
npm run mts:prepare
```

This runs `scripts/prepare-geotiff.mjs` (via the bundled GDAL in `gdal-async`) and:
1. parses `NVIS7_0_AUST_EX_MVG.clr` into per‑channel lookup tables,
2. expands the single categorical band into **4 RGBA bands** (no‑data `255` and
   any unlisted class → **transparent**), via an on‑the‑fly VRT,
3. reprojects to **EPSG:3857** with **nearest** resampling (crisp class edges),
4. writes a **Cloud‑Optimized GeoTIFF** with overviews to `MTS_GEOTIFF`.

By default it outputs at **150 m/px** (`PREP_TARGET_RES` in `.env`) — about 4×
finer than zoom 8 needs, so it’s small (~130 MB) and quick. Set
`PREP_TARGET_RES=native` if you ever raise `MTS_MAXZOOM` well above 8 and want
full ~30 m detail (much larger/slower).

<details>
<summary>Prefer the classic GDAL CLI? (optional, equivalent)</summary>

If you have a system GDAL install, the equivalent of the script is:

```bash
cd ../NVIS_V7_30m/NVIS_V7_30m_Revised

# 1) Bake the palette → RGBA (nv entry makes no-data transparent).
gdaldem color-relief NVIS7_0_AUST_EX_MVG.tif NVIS7_0_AUST_EX_MVG.clr \
  nvis_rgba.tif -alpha -nearest_color_entry

# 2) Reproject to Web Mercator + write a COG.
gdalwarp -t_srs EPSG:3857 -r near nvis_rgba.tif nvis_rgba_3857.tif
gdal_translate nvis_rgba_3857.tif nvis_rgba_cog.tif \
  -of COG -co COMPRESS=DEFLATE -co BLOCKSIZE=512
```
</details>

### Step 4 — Upload + publish to Mapbox

```bash
cd ../../mapbox-poc
npm run mts:upload
```

This will, in order:
1. **Create a tileset source** from your RGB GeoTIFF.
2. **Validate** the raster recipe (written to `recipe.generated.json`).
3. **Create the tileset** (or update its recipe if it already exists).
4. **Publish** and **poll the job** until it reports `success`.

When it finishes it prints the line to add to `.env`:

```
VITE_NVIS_TILESET_ID=your_username.nvis_mvg
```

Check status any time with:

```bash
npm run mts:status
```

### Step 5 — Run the app

```bash
npm run dev
```

Open <http://localhost:5173>. You’ll get:
- the NVIS raster over a switchable base map (Light / Satellite / Streets / Dark),
- an **opacity** slider and a **layer toggle**,
- a **legend** generated from the `.clr` palette + standard MVG names,
- a “Reset view to Australia” button.

Build a static bundle for sharing with `npm run build` (output in `dist/`).

---

## How the app references the tileset

A Mapbox‑hosted tileset is added with the `mapbox://` protocol; GL JS fetches its
TileJSON automatically using your public token (`src/components/MapView.vue`):

```js
map.addSource('nvis-mvg', { type: 'raster', url: `mapbox://${tilesetId}` })
map.addLayer({
  id: 'nvis-mvg-raster',
  type: 'raster',
  source: 'nvis-mvg',
  paint: { 'raster-opacity': 0.85, 'raster-resampling': 'nearest' }
})
```

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
│  │  ├─ MapView.vue       # Mapbox GL JS map + NVIS raster layer
│  │  ├─ ControlsPanel.vue # opacity / visibility / base map
│  │  └─ LegendPanel.vue   # NVIS MVG legend
│  └─ data/
│     └─ nvisMvgLegend.js  # colours from the .clr + MVG names
└─ scripts/
   ├─ create-token.mjs     # Tokens API → public pk token
   ├─ prepare-geotiff.mjs  # .clr palette → transparent RGBA COG (gdal-async)
   ├─ upload-to-mts.mjs    # source → recipe → publish → poll
   └─ lib/
      ├─ env.mjs           # tiny .env loader
      └─ mapbox.mjs        # fetch wrapper for the Mapbox API
```

---

## Costs, limits & timing (for the POC conversation)

- **Free tier** covers a generous amount of MTS processing/hosting and map loads;
  a single continental raster at zoom 0–8 is well within it. See
  <https://www.mapbox.com/pricing/#tilesets>.
- **Processing time** grows ~4× per extra zoom level. Start at `maxzoom 8` for a
  fast demo; raise it later if you need more detail when zoomed in.
- **File limits:** each source file ≤ 20 GB, total source ≤ 50 GB. Our ~655 MB
  file is fine.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| App shows **“Base map only”** | `VITE_NVIS_TILESET_ID` isn’t set (or the job isn’t finished). Run `npm run mts:status`. |
| **401 / 403** from a script | The `sk.` token is missing scopes (`tilesets:write/read/list`). |
| Recipe **invalid** / job **failed** | The GeoTIFF isn’t 8‑bit RGBA. Re‑run `npm run mts:prepare`; the COG should be `uint8`, 4 bands (Red/Green/Blue/Alpha). |
| Tiles **misplaced** | CRS issue. Re‑warp to `EPSG:3857`, or set an optional `crs` on the recipe source. |
| Colours look **blurred / blended** | Use nearest resampling: `-nearest_color_entry` (GDAL) — already in Step 3; the layer also uses `raster-resampling: nearest`. |

---

## Reference docs

- Mapbox Tiling Service API — <https://docs.mapbox.com/api/maps/mapbox-tiling-service/>
- Raster recipe spec — <https://docs.mapbox.com/mapbox-tiling-service/recipe-specification/raster/>
- Supported raster formats — <https://docs.mapbox.com/mapbox-tiling-service/raster/supported-file-formats/>
- Tokens API — <https://docs.mapbox.com/api/accounts/tokens/>

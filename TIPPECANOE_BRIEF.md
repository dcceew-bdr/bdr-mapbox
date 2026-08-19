# Brief: Build the NVIS MVG vector tileset with tippecanoe (private machine)

**Audience:** an AI coding assistant on a machine that HAS tippecanoe, ogr2ogr/GDAL,
Node.js, and internet access.
**Goal:** produce a Mapbox vector tileset of Australia's NVIS Major Vegetation
Groups (MVG) and publish it, so a Vue + Mapbox GL JS app can render it as a
data-driven `fill` layer with a dynamic legend and click-to-identify.

This brief bakes in lessons from a prior attempt that used GDAL's MVT writer on a
locked-down government machine (no Docker/WSL/tippecanoe). That attempt worked but
was painfully slow and hit a hard wall on Mapbox ingest. tippecanoe solves the
wall cleanly. Read the "Lessons learned" section — it will save you days.

---

## 1. What to build (the deliverable)

A single Mapbox **vector** tileset:

- **One layer**, named exactly **`mvg`** (this is the source-layer the client
  references — do not rename it).
- Each feature carries **one integer property**, also named **`mvg`** = the MVG
  class code (1–33). NOTHING else is needed in the tiles (no names, no colours —
  the client resolves those locally from a legend table, keeping tiles tiny).
- **Zoom range z0–z13** (national overview through regional detail). z11+ is where
  the genuine 30 m boundary detail becomes visible.
- Must ingest into Mapbox with **no tile exceeding 500 KB at any zoom** (Mapbox's
  hard limit — see Lessons).

Publish it under a tileset id like `USERNAME.nvis_mvg_vector` (keep it separate
from any existing raster tileset such as `USERNAME.nvis_mvg`).

---

## 2. Where to get the source data

NVIS is fundamentally a **vector** product (polygons), rasterised to 100 m for the
public raster download. **Prefer the vector** — feed polygons straight to
tippecanoe for native fidelity (better than any raster resample).

**Australian Government — DCCEEW / "Find Environmental Data" (FED) portal:**

- NVIS data products landing page:
  https://www.dcceew.gov.au/environment/environment-information-australia/national-vegetation-information-system/data-products
- **Extant Vectors (USE THIS)** — NVIS v7.0 extant vector geodatabase:
  https://fed.dcceew.gov.au/datasets/be9930d6de354ace93fd1aa5d34a71de/about
- Extant Rasters (100 m, fallback only):
  https://fed.dcceew.gov.au/datasets/5e70b5afc36a4c458a2cceb313eb3889/about
- Live MVG service (authoritative attribute schema / sanity check):
  https://gis.environment.gov.au/gispubmap/rest/services/ogc_services/NVIS_ext_mvg/MapServer

**Attribute schema (from the live service):** the class code lives in a field the
raster calls `VALUE` (1–33); `MVG_NAME` is the full name, `MVG_COMMON_DESC` a
description, `SORT_ORDER` legend order. In the vector geodatabase the geometry may
be split into **per-state/territory feature classes** with an **NVIS attribute
table** — you may need to merge states and confirm the MVG code field name on the
polygons (it may be `MVG`, `MVG_NUMBER`, or require a join to the NVIS table).
**Verify with `ogrinfo` before tiling.**

**Licence:** confirm the FED dataset's licence (NVIS is typically **CC BY 4.0**).
If publishing publicly, include the required attribution. Verify on the FED page.
DCCEEW's default licence is **CC BY 4.0**; required credit:
"© DCCEEW — NVIS v7.0 (CC BY 4.0); incl. data © Australian State/Territory
Governments." Acknowledge the state/territory custodians on an About page. See
`LICENSING.md` for the full attribution text and custodian list.

> If for any reason you must use the raster instead: it's a single-band categorical
> GeoTIFF; polygonise it (`gdal_polygonize`) into a `mvg` integer field, then treat
> it exactly like the vector path below. But the vector is strongly preferred.

---

## 3. Recommended pipeline

```
NVIS Extant Vector geodatabase (.gdb, per-state feature classes + NVIS table)
      │  ogrinfo — inspect layers + find the MVG code field
      ▼
ogr2ogr  — merge states, keep ONE integer field renamed to `mvg`,
           reproject to EPSG:4326, output line-delimited GeoJSON
      ▼
tippecanoe — build .mbtiles, z0–z13, layer `mvg`, drop-densest as needed
      ▼
Mapbox — upload/publish (tilesets upload via mapbox-tile-copy / Uploads API,
         or the MTS tilesets CLI)
      ▼
Vue + Mapbox GL JS client (contract in section 5)
```

### 3a. Inspect + normalise with ogr2ogr

```bash
# 1. See what's inside the geodatabase (layer names, field names, geometry).
ogrinfo -so NVIS_Extant.gdb
ogrinfo -so NVIS_Extant.gdb <a_state_layer_name>   # find the MVG code field

# 2. Merge all state feature classes into one GeoJSONL with a single integer
#    field `mvg`, in EPSG:4326. Adjust <MVG_FIELD> and layer names to reality.
#    (-sql lets us SELECT + rename the field; repeat/append per layer, or use
#    ogrmerge.py, or a VRT — whatever the assistant finds cleanest.)
ogr2ogr -f GeoJSONSeq -t_srs EPSG:4326 \
  -sql "SELECT CAST(<MVG_FIELD> AS integer) AS mvg FROM <layer>" \
  -nln mvg nvis_mvg.geojsonl NVIS_Extant.gdb

# Drop no-data / non-vegetation if desired, e.g. exclude code 99:
#   add:  -where "<MVG_FIELD> <> 99"
```

Confirm the result:
```bash
ogrinfo -so nvis_mvg.geojsonl mvg      # geometry type, feature count
head -c 300 nvis_mvg.geojsonl          # each line a Feature with {"mvg": <int>}
```

### 3b. Tile with tippecanoe (the whole point)

```bash
tippecanoe -o nvis_mvg.mbtiles \
  -l mvg \                         # layer name MUST be "mvg"
  --minimum-zoom=0 --maximum-zoom=13 \
  --drop-densest-as-needed \       # <-- the feature that makes low zoom fit 500 KB
  --coalesce-densely \             # merge same-attribute polygons in dense tiles
  --coalesce --reorder \           # helps coalescing across adjacent features
  --simplification=10 \            # generalise low zooms (tune 5–12)
  --detect-shared-borders \        # cleaner shared polygon edges when simplifying
  --no-tiny-polygon-reduction=false \
  --extend-zooms-if-still-dropping \
  --force nvis_mvg.geojsonl
```

Notes:
- **`--drop-densest-as-needed` is the key.** It removes the least-visible features
  per tile to stay under budget — GDAL's MVT writer cannot do this, which is why
  the earlier attempt failed at z7.
- If you want same-class polygons visually merged (recommended for a categorical
  choropleth), `--coalesce-densely` + `--reorder` + `--coalesce` do that; consider
  also pre-dissolving by `mvg` with `ogr2ogr`/`ST_Union` if you want hard merges.
- Keep only the `mvg` attribute so tiles stay small. If tippecanoe warns about
  tile size, raise `--drop-densest-as-needed` aggressiveness or lower max zoom for
  the densest classes; do NOT ship tiles > 500 KB.

Inspect the result:
```bash
tippecanoe-decode nvis_mvg.mbtiles 7 <x> <y> | head   # spot-check a z7 tile
```

### 3c. Publish to Mapbox

Any ONE of these (assistant picks based on tooling available):

- **mapbox-tile-copy** (simplest for an .mbtiles):
  `mapbox-tile-copy nvis_mvg.mbtiles mapbox://tileset/USERNAME.nvis_mvg_vector`
  (needs a secret token with `uploads:write`; see Lessons on scopes).
- **Uploads API** (manual): request S3 staging credentials → PUT the .mbtiles →
  POST `{url, tileset, name}` to `/uploads/v1/USERNAME` → poll status.
- **MTS tilesets CLI**: `tilesets upload-source`, add a recipe, `tilesets publish`.

Token scopes required (create a **secret** `sk.` token in the Mapbox console):
`uploads:write`, `uploads:read` (and `tilesets:read` to verify). See Lessons.

---

## 4. Lessons learned (do NOT relearn these the hard way)

1. **Mapbox rejects any tile > 500 KB, at any zoom.** The prior GDAL build failed
   ingest with *"Tile exceeds maximum size of 500k at z7."* Low-zoom tiles cover
   enormous areas; thousands of small polygons pile into one tile.
   → tippecanoe's **`--drop-densest-as-needed`** is the correct fix. Use it.

2. **Simplifying geometry is NOT enough.** Tile size at low zoom is driven by
   FEATURE COUNT, not vertex count. GDAL only simplifies geometry and never drops
   features, so it can't meet the budget. tippecanoe drops/coalesces features per
   zoom — that's the whole reason to use it.

3. **File size is driven by feature count, not vertices.** In the earlier work,
   simplifying to 400 m produced essentially the same multi-GB size as 100 m. Only
   reducing feature count (sieve/area-filter/coalesce) actually shrinks things.

4. **Keep attributes minimal.** Put only the integer `mvg` code in the tiles.
   Names/colours live in the client legend. Smaller tiles = fewer size-limit
   fights and faster loads.

5. **Layer + property names are a contract.** The client expects source-layer
   **`mvg`** and feature property **`mvg`** (integer). Renaming breaks the app.

6. **Mapbox token scopes are separate doors.** `tilesets:*` (MTS) is DIFFERENT
   from `uploads:*` (Uploads API / mapbox-tile-copy). A token with only
   `tilesets:*` returns a confusing **404** on `/uploads/v1/...`. If you publish
   via Uploads/mapbox-tile-copy, the secret token needs **`uploads:write` +
   `uploads:read`**.

7. **The public raster is only 100 m; the underlying vector is finer.** Use the
   **vector** download for true fidelity. (A separate 30 m raster exists in the
   full NVIS package; its detail is genuine vector-rasterised boundaries, not an
   upsample — but the vector itself is the best tiling input.)

8. **Billing is per map *load*, not per tile or per zoom.** Extra zoom levels do
   NOT inflate routine hosting cost. A "load" = each `new mapboxgl.Map()`. Keeping
   z13 is fine. (Processing/append operations on MTS can incur one-off costs;
   building locally with tippecanoe and uploading a finished .mbtiles avoids
   repeated server-side processing.)

9. **Verify the geodatabase structure first.** NVIS vector ships as per-state
   feature classes plus an NVIS attribute table. Confirm the MVG code field (and
   whether a table join is needed) with `ogrinfo` BEFORE tiling.

10. **Sanity-check before a long run.** Decode a z7 tile and check sizes early;
    don't discover a size failure only at Mapbox ingest after hours of tiling.

---

## 5. Client contract (so the tileset matches the existing app)

The Vue app expects:

- **Source:** `{ type: 'vector', url: 'mapbox://USERNAME.nvis_mvg_vector' }`
- **Source-layer:** `mvg`
- **Feature property:** `mvg` (integer 1–33)
- **Styling:** a data-driven `fill-color` built as a Mapbox `match` expression on
  `['get','mvg']`, mapping each code to an RGB colour from the local legend.
- **Legend:** viewport-aware — on `moveend`, `queryRenderedFeatures({layers:[fill]})`,
  collect distinct `mvg` codes on screen, show name+swatch for each.
- **Identify:** on `click` of the fill layer, read `feature.properties.mvg`, show a
  popup with the code + name + colour.

### MVG code → name → colour table (authoritative; copy verbatim)

The client uses this legend; the tileset only needs to carry the integer `value`.

```
value  name                                                        rgb
1      Rainforests and Vine Thickets                               255,0,0
2      Eucalypt Tall Open Forests                                  3,77,0
3      Eucalypt Open Forests                                       0,130,0
4      Eucalypt Low Open Forests                                   76,230,0
5      Eucalypt Woodlands                                          193,214,200
6      Acacia Forests and Woodlands                                146,173,47
7      Callitris Forests and Woodlands                             144,186,141
8      Casuarina Forests and Woodlands                             0,214,168
9      Melaleuca Forests and Woodlands                             178,235,178
10     Other Forests and Woodlands                                 115,255,222
11     Eucalypt Open Woodlands                                     224,255,235
12     Tropical Eucalypt Woodlands / Grasslands                    200,194,255
13     Acacia Open Woodlands                                       240,228,141
14     Mallee Woodlands and Shrublands                             189,182,106
15     Low Closed Forests and Tall Closed Shrublands               138,114,19
16     Acacia Shrublands                                           250,190,190
17     Other Shrublands                                            138,114,101
18     Heathlands                                                  255,160,122
19     Tussock Grasslands                                          184,171,141
20     Hummock Grasslands                                          255,248,219
21     Other Grasslands, Herblands, Sedgelands and Rushlands       252,228,167
22     Chenopod Shrublands, Samphire Shrublands and Forblands      252,228,220
23     Mangroves                                                   21,163,171
24     Inland Aquatic — freshwater, salt lakes, lagoons            0,111,255
25     Cleared, non-native vegetation, buildings                   255,255,255
26     Unclassified native vegetation                              79,79,79
27     Naturally bare — sand, rock, claypan, mudflat               204,204,204
28     Sea and estuaries                                           150,219,242
29     Regrowth, modified native vegetation                        156,156,156
30     Unclassified Forest (not present in this dataset)           —
31     Other Open Woodlands                                        214,157,188
32     Mallee Open Woodlands and Sparse Mallee Shrublands          224,217,136
99     Unknown / No data                                           235,235,235
```

(Colours are the standard NVIS MVG palette. Code 30 is absent in this dataset;
code 99 is no-data and may be dropped from the tiles.)

---

## 6. Definition of done

- [ ] `ogrinfo` confirms one `mvg` layer, integer `mvg` field, EPSG:4326, sensible
      feature count.
- [ ] tippecanoe builds `nvis_mvg.mbtiles`, z0–13, layer `mvg`.
- [ ] `tippecanoe-decode` shows NO tile > 500 KB (spot-check dense z6–z8 tiles).
- [ ] Tileset uploads/publishes to `USERNAME.nvis_mvg_vector` without ingest errors.
- [ ] A quick Mapbox GL JS test page renders the fill with the `match` palette,
      shows a viewport legend, and pops up code+name on click.
- [ ] Licence/attribution confirmed for public publishing.

---

## 7. One-paragraph summary to paste at the top of the LLM chat

> Build a Mapbox vector tileset of Australia's NVIS v7.0 Major Vegetation Groups.
> Download the **Extant Vector** geodatabase from the DCCEEW FED portal
> (https://fed.dcceew.gov.au/datasets/be9930d6de354ace93fd1aa5d34a71de/about).
> With `ogrinfo`, find the MVG class-code field; with `ogr2ogr`, merge the
> per-state feature classes into one EPSG:4326 line-delimited GeoJSON carrying a
> single integer property named `mvg` (1–33). Tile with **tippecanoe** to
> `nvis_mvg.mbtiles`, layer name `mvg`, zoom 0–13, using
> `--drop-densest-as-needed` and `--coalesce-densely` so NO tile exceeds Mapbox's
> 500 KB limit (a prior GDAL-only build failed at z7 for exactly this reason —
> GDAL can't drop features, tippecanoe can). Publish to
> `USERNAME.nvis_mvg_vector` with a secret token that has `uploads:write` +
> `uploads:read`. Keep only the integer `mvg` in the tiles; the web client maps
> codes to names/colours locally (table provided). Verify with `tippecanoe-decode`
> that dense low-zoom tiles are under 500 KB before publishing.

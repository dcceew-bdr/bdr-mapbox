# NVIS MVG Vector Tileset — Build Settings

Reference for the settings used to build the Australia NVIS v7.0 Major Vegetation
Groups vector tileset (21,315,015 polygons; layer + property both named `mvg`;
zoom 0–13; every tile under Mapbox's 500 KB limit).

Two stages: (1) prepare the data with GDAL/ogr2ogr, (2) tile it with tippecanoe.

---

## ⭐ THE VALIDATED RECIPE (what actually works — found 2026-07-27)

After many failures, this is the exact formula that builds cleanly on the laptop:

> **4 pieces · 120 KB per-piece budget · tippecanoe `--simplification=30` · `--drop-densest` · zoom 0–13**
> (script: `national_split2.sh`; runs ~4–6 h; every joined tile ends up < 500 KB)

**Every number is forced by the "low-zoom mega-tile" problem:** at zoomed-out levels the
whole continent lands in one (or a few) tiles crammed with millions of polygons. That one
fact drives everything:

- **`--simplification=30`** (tippecanoe's *low-zoom* thinning — distinct from the ~11 m
  geometry pre-simplify in stage 1). At light values the zoom-2 "all of Australia" tile
  makes tippecanoe **thrash and hang for hours**. Heavier low-zoom simplification shrinks
  that tile so it tiles cleanly. Invisible when zoomed out; z13 detail untouched.
  *Tested: 30 clears zoom 2; 10 hangs on big pieces.*
- **budget = 120 KB.** One monster polygon's zoom-8 tile is **103 KB** even at simp=30
  (117 KB at simp=10). It's a single feature, so no dropping goes below that — the budget
  **must exceed it**. 120 KB clears it with 17 KB to spare.
- **4 pieces (not 5, not 2).** Fewer pieces → bigger slices → zoom-2 tile thrashes/hangs.
  More pieces → budget must drop ≤ 100 KB (to keep the join < 500 KB) → below the 103 KB
  floor → abort at zoom 8. **4 is the only count that satisfies both** (5.3 M polygons each
  tiles cleanly; 4 × 120 KB = 480 KB < 500 KB).
- **`--drop-densest` (not `--drop-smallest`).** "Keep biggest zones" re-sorts millions of
  polygons per low-zoom tile and hangs. Density-based dropping is fast.

**The core tension:** low zoom wants *small* pieces; the zoom-8 floor wants a *high* budget
(which forces *few* pieces). 4 pieces + simp=30 is the single point that satisfies both.
Validated with quick zoom-0–4 and 0–8 tests before committing to the full run.

---

## Plain-English overview (what the build does, start to finish)

- **Join** — each polygon carries only a code (NVISDSC1); look it up in a 19,434-row table to get its vegetation group number.
- **Merge** — combine 8 separate state/territory files into one national layer.
- **Reproject** — Australian Albers coordinates → web-standard lat/long.
- **Strip** — discard every attribute except that one integer (no names, no colours).
- **Tile** — cut into small square tiles across 14 zoom levels (0–13).
- **Thin, per zoom level** — merge touching polygons of the same type, simplify outlines, and drop features from the most crowded areas as needed, so no tile exceeds Mapbox's 500 KB limit. (We tried a "keep the biggest zones" variant but it hung the build on the huge zoomed-out tiles, so we use the standard density-based method.)
- **Result** — ~21.3 million polygons (~15 GB simplified) become a few hundred MB of tiles, where the browser downloads only the few hundred KB covering what's on screen.

Steps 1–4 are the data prep (done); steps 5–6 are the tiling build; step 7 is the output.

---

## 1. Data preparation (GDAL / ogr2ogr)

| Setting | Value | Plain explanation |
|---|---|---|
| Output format | `-f GeoJSONSeq` | One polygon per line, so the tiler can stream it without loading everything into memory. |
| Property | `mvg` (integer) | Each polygon's vegetation code (NVISDSC1) was looked up and reduced to just its Major Vegetation Group number — nothing else carried through. |
| Geometry simplify | `-simplify 0.0001` | Thinned boundary points to ~11 m (just under one screen pixel at max zoom). Cut the data 71 GB → 15 GB with no visible change at z13. |
| Coordinate precision | `-lco COORDINATE_PRECISION=6` | Rounds coordinates to 6 decimals (~10 cm) — trims file size, no visible loss. |

Command shape:
```
ogr2ogr -f GeoJSONSeq -simplify 0.0001 -lco COORDINATE_PRECISION=6 <out>.geojsonl <in>
```

**Simplification decision (2026-07-27):** kept at ~11 m. At zoom 13 this already matches
screen resolution, so finer detail would render identically; finer would only show when
zooming *past* 13, at the cost of ~2 h reprocessing + more disk. 11 m = full visible
quality with no waste.

---

## 2. Tiling (tippecanoe)

| Flag | Value | Plain explanation |
|---|---|---|
| `-l` | `mvg` | Names the map layer "mvg" (required). |
| `--minimum-zoom` | `0` | Build from the whole-country view. |
| `--maximum-zoom` | `13` | …down to ~15 m detail (deepest zoom-in). |
| `--maximum-tile-bytes` | `120000` per piece | Size cap per tile. Mapbox's hard limit is 500 KB; 120 KB per piece keeps 4 joined pieces under it (4×120=480) while still clearing the 103 KB zoom-8 floor. |
| `--drop-densest-as-needed` | on | In over-full tiles, drop features from the most densely-packed areas to fit the size cap (standard density-based thinning). |
| `--coalesce-densest-as-needed` | on | Merge touching same-vegetation polygons in crowded tiles instead of dropping them, so there are no colour holes. |
| `--drop-fraction-as-needed` | on | Last-resort fallback: if a tile is still too big, drop a rising fraction of features until it fits — guarantees a tile never aborts the build (the fix for our earlier failures). |

**Drop-strategy decision (2026-07-27):** we first tried `--drop-smallest-as-needed`
("keep the biggest zones") but it HUNG the build on the huge low-zoom tiles (repeated
area-sorting of millions of features — no progress for an hour). Reverted to
`--drop-densest-as-needed`, the standard reliable method. Same-type neighbours still merge
(`--coalesce-densest-as-needed`), so full colour coverage is preserved; thinning in
crowded tiles is by density, not by size.
| `--simplification` | `30` | How hard to thin shapes at zoomed-*out* levels. Set to 30 (heavy) because it shrinks the zoom-2 "whole continent" mega-tile enough that tippecanoe stops hanging on it. Invisible when zoomed out; z13 untouched. |
| `--no-simplification-of-shared-nodes` | on | Keeps borders between neighbouring polygons aligned — stops gaps/slivers appearing. |
| `--read-parallel` | on | Ingest input using multiple threads (faster). |
| `--temporary-directory` | native ext4 | Scratch goes on the fast Linux disk, never the Windows bridge (that bridge runs ~1 MB/s — unusable). |
| `--force` | on | Overwrite an existing output file without prompting. |

Command shape (per piece):
```
tippecanoe -l mvg --minimum-zoom=0 --maximum-zoom=13 \
  --drop-densest-as-needed --drop-fraction-as-needed --coalesce-densest-as-needed \
  --simplification=30 --no-simplification-of-shared-nodes --read-parallel --force \
  --maximum-tile-bytes=120000 --temporary-directory=<native ext4 dir> \
  -o piece.mbtiles piece.geojsonl
```

---

## 3. Build structure & safety (our harness, not tippecanoe)

| Setting | Value | Plain explanation |
|---|---|---|
| Split into pieces | 4 | Build random subsets separately so temp space stays small, then join. 4 is the sweet spot: fewer pieces thrash at low zoom, more pieces can't clear the zoom-8 floor. (Also avoids the single-pass temp blow-up that doesn't fit the laptop disk.) |
| Per-piece byte budget | 120 KB | Clears the 103 KB zoom-8 floor (17 KB margin); 4×120 = 480 KB keeps joined tiles under Mapbox's 500 KB. |
| Join | `tile-join` | Stitches the pieces into one national tileset. Fast and reliable — never a failure source. |
| Disk self-guard | stop at ~165 GB used | Halts the build if the Linux disk grows too far — protects C: even if the chat is closed. |
| Windows-side guard | stop at C: < 50 GB free | Second layer of brick protection. |
| Resumable | `.done` markers | Re-running continues from the last finished piece. |
| Error logging | per-piece `tip_N.log` | tippecanoe's output is saved so any error can be diagnosed instantly. |

---

## Fixed (cannot change)
- **500 KB per-tile limit** — Mapbox's hard limit.
- **Layer + property name `mvg`** — required by the brief.
- **21,315,015 polygons** — the source data.
- **Laptop scratch-disk capacity** — the binding hardware constraint; only a bigger/faster disk or freeing space changes it.

# NVIS × Mapbox POC — Conclusions & Decisions

_Last updated: 20 August 2026_

This document records what we learned getting the NVIS Major Vegetation Groups
(MVG) data into Mapbox, the decisions made, and the reasoning — so the next
person (or future you) doesn't have to rediscover it.

> **Update (Aug 2026):** the vector approach in §§3–10 (GDAL's MVT writer, built
> in-repo via `prepare-vector.mjs`/`build-mbtiles.mjs`) was an install-free
> attempt on a locked-down machine. The tileset that actually **shipped**
> (`kevinthiele.nvis_mvg_vector`, z9–13) was built with **tippecanoe** from the
> NVIS v7.0 **vector** geodatabase — that toolchain and its own lessons live in
> [`tippecanoe/dcceew`](tippecanoe/dcceew) (`HANDOFF.md`,
> `LESSONS_AND_WORKFLOW.md`). Treat the GDAL-MVT scripts as a superseded fallback.

---

## 1. The core problem

The raw NVIS raster is a **single-band categorical GeoTIFF** (MVG class codes
1–32, 99; nodata 255) covering the **whole of Australia** at 30 m. We needed it
in Mapbox for a web app, ideally with a dynamic legend and click-to-identify.

Two paths exist: **raster tiles** (quick, image-based) and **vector tiles**
(geometry-based, interactive). We tried raster first, then moved to vector.

---

## 2. Raster pipeline — what happened

### What worked
- **150 m resolution, maxzoom 11** published successfully
  (job `cmru04bli001a0gju3xmk15cx`). Local COG ~134–141 MB.
- This is a perfectly good **continental** vegetation map at normal zoom levels.

### What failed — and the real reason
Every attempt finer than 150 m failed Mapbox processing with the generic error
_"An error occurred during the processing of this job."_ We initially blamed
source resolution, but the **actual root cause** was discovered in the job list:

> **The MTS "create source" endpoint _appends_ each uploaded file to the source —
> it does not replace it.**

Re-running the upload pipeline repeatedly **stacked copies** of the GeoTIFF onto
the same source. Mapbox's reported source size grew every run:

| Run | Local file | Mapbox source size | Result |
|-----|-----------|--------------------|--------|
| 1 (150 m) | 141 MB | **141 MB** | ✅ success |
| later (90 m) | 282 MB | 723 MB | ❌ failed |
| later (120 m) | 175 MB | 865 MB | ❌ failed |
| later (150 m again) | 134 MB | **999 MB → 1,047 MB** | ❌ failed |

The last row is the smoking gun: the **same 150 m file that worked the first
time** failed later — because the source had ballooned to ~1 GB of stacked
uploads. It was never purely a resolution limit.

### Fix
`scripts/delete-source.mjs` deletes the source before uploading, so each upload
is **clean, not appended**. **Always run delete-source before an upload.**
(The vector upload script now does this automatically.)

### Raster conclusions
- For **whole-of-Australia raster**, 150 m / maxzoom 11 is the proven, working
  configuration.
- Lowering **maxzoom** does **not** help fit a larger source — the failures were
  source-size driven, and maxzoom only affects the output tileset. (A 90 m source
  failed at both maxzoom 10 and 11.)
- Finer continental raster detail would require **splitting into regional
  tilesets** or a **Mapbox limit increase** — not a zoom change.

---

## 3. Why we moved to vector

Vector tiles store **polygon geometry**, not pixels. This sidesteps the raster
size wall and adds the features we actually wanted:

- **Dynamic legend** — show only the MVG classes visible in the current viewport
  (`queryRenderedFeatures` on `moveend`).
- **Click-to-identify** — click a polygon, read `properties.mvg`, look up the
  name/colour locally.
- **Crisp overzoom** — because vectors are redrawn (not stretched), you can zoom
  **past** the tileset's maxzoom and boundaries stay sharp. You do **not** need a
  fine tiling depth just to zoom in.

### Key decision: store the ID only, not the name
Tiles carry a **single integer `mvg`** per feature. The Mapbox client does the
rest locally from `src/data/nvisMvgLegend.js`:
- popup text ← lookup by `mvg`
- fill colour ← data-driven `match` on `mvg`
- legend ← the set of visible `mvg` values

Benefits: smallest possible tiles, and you can **rename/recolour without
re-tiling**.

### The two limits are different
- **Raster limit** = source pixel count / uncompressed size (Mapbox expanded our
  COG to ~1 GB → failure).
- **Vector limit** = **per-tile byte size** (~500 KB soft / ~1 MB hard), driven
  by vertex count per tile. Managed by sieving specks, simplifying geometry, and
  the MTS recipe (union + per-zoom simplification + drop-densest).

---

## 4. The vector pipeline — design & the 4.5-hour lesson

### What went wrong first
The first `prepare-vector.mjs` at **60 m** ran for **4.5 hours** and was killed.
A code critique (correct) identified why:

1. **In-memory layer** — polygonising continental Australia at 60 m yields
   **millions** of features; holding them in the GDAL Memory driver is heavy.
2. **Synchronous per-feature JS loop** — `simplify()` + `transform()` +
   `JSON.stringify()` per feature **blocked the event loop** and ran for hours
   with no progress output.
3. **Naive `geom.simplify()`** (Douglas-Peucker per feature) can create
   **slivers/gaps** — shared borders between neighbouring polygons drift apart.
4. **Single simplify tolerance for all zooms** — low-zoom tiles kept more
   vertices than needed (per-tile overflow risk).

### The rewrite (current `prepare-vector.mjs`)
- **Polygonise → GPKG on disk** (not Memory) with a `progress_cb` percentage bar
  → RAM no longer scales with feature count; you see progress.
- **Simplify/filter/reproject in C++ via `gdal.vectorTranslate`** instead of a JS
  loop → orders of magnitude faster, non-blocking.
- **Topology-preserving simplification** (`ogr2ogr -simplify` uses
  `SimplifyPreserveTopology`) → avoids slivers/gaps.
- Simplify stays in **EPSG:3857** so the tolerance is in **metres**, then a
  second pass reprojects to **EPSG:4326 GeoJSONSeq** for upload.
- **Class 99 dropped** at the filter step (kept 24 Inland Aquatic, 28 Sea).

### Per-zoom generalisation — originally server-side, now done locally

> **Superseded:** the raw-GeoJSON → MTS recipe route (`upload-vector-to-mts.mjs`)
> has been **retired**. Per-zoom generalisation now happens during the **local
> tile build** (see §10). The notes below are kept as background on why the MTS
> recipe looked attractive before the raw file hit the ingest wall.

The retired MTS recipe did the "gold standard" per-zoom work server-side:
- `union: [{ group_by: ['mvg'] }]` — coalesces adjacent same-class polygons.
- `simplification: ['case', ['<', ['zoom'], 6], 8, 4]` — simplify harder at low
  zoom.
- `remove_small_polygons` at low zoom + `limit: [['tile', 2500,
  'drop_densest_as_needed']]` — respect the per-tile budget.

The local MVT build (§10) reproduces the important parts via `SIMPLIFICATION`
(per-zoom) and `MAX_SIZE` (drop-densest), so the single light local simplify in
`prepare-vector.mjs` is still all that's needed up front.

---

## 5. Chosen configuration (120 m / zoom 10)

| Setting | Value | Why |
|---------|-------|-----|
| `PREPV_TARGET_RES` | **120 m** | ~¼ the polygons of 60 m → minutes not hours; matches zoom 10 (~138 m/px). |
| `PREPV_SIEVE_AREA_KM2` | **0.02** | Gentle cleaning (most detail); sieve is area-based so it's consistent across resolutions. |
| `PREPV_SIMPLIFY_M` | **100** | ~one 120 m pixel; strips stair-steps without moving real boundaries. |
| `PREPV_DROP_CLASSES` | **99** | No-data/unknown removed; all real classes kept. |
| `MTSV_MAXZOOM` | **10** | Matches 120 m data; vector still overzooms crisply beyond it. |

Separate IDs (`nvis_mvg_vec_src`, `kevinthiele.nvis_mvg_vector`) ensure the
**existing raster tileset `nvis_mvg` is never touched.**

---

## 6. Is 60 m viable now?

**Yes for building; still the heavier option for tiling.**

- The rewrite fixes the two things that killed 60 m — **memory** (disk GPKG) and
  **speed/blocking** (C++ `vectorTranslate`). What hung for 4.5 h would now
  finish in minutes with visible progress.
- **But** 60 m still produces ~4× the vertices of 120 m, so low-zoom **per-tile
  size** is closer to Mapbox's limit. The recipe (union + per-zoom simplify +
  drop-densest) handles this, but 60 m leans on it harder and risks MTS dropping
  small features at low zoom.
- At the zoom levels you actually view, 120 m and 60 m look essentially the same;
  60 m mainly sharpens **boundary shape**, and most tiny extra patches get sieved
  or simplified away anyway.

**Recommendation:** prove the pipeline at **120 m** first. The code now supports
60 m cheaply, so a follow-up 60 m run for comparison is low-cost if maximum
boundary faithfulness is wanted.

---

## 7. Operational checklist

1. **Prepare:** `node scripts/prepare-vector.mjs` (local only; review size +
   feature count before building).
2. **Build tiles locally:** `node scripts/build-mbtiles.mjs` — GDAL MVT writer
   slices the GeoJSON into per-zoom vector tiles → compact `.mbtiles`.
3. **Upload + publish:** `node scripts/upload-mbtiles.mjs` (classic Uploads API)
   — watch the job; note any per-tile warnings.
4. If low-zoom tiles overflow: increase `PREPV_SIEVE_AREA_KM2` and/or
   `PREPV_SIMPLIFY_M`, raise `MVT_SIMPLIFICATION`, or lower `MVT_MAXZOOM`, and
   re-run.

> The retired MTS route needed a **delete-source-before-every-upload** step
> (appended sources were the raster failure — see §2). The Uploads API route
> stages a fresh `.mbtiles` each time, so that footgun is gone; `delete-source.mjs`
> remains only for cleaning up any leftover MTS sources.

---

## 8. Vector file size & the gzip dead-end

- The 120 m / simplify-100 m / sieve-0.1 run produced **2,591,708 features** and a
  **2.5 GB** line-delimited GeoJSON — far too big (my ~500 MB estimate was 5× low).
- **Gzip does NOT help for MTS upload.** MTS rejects compressed sources:
  `415: MTS source must not be gzip compressed`. The RAW `.geojsonl` must itself
  fit under any gateway limit. (2.4 GB → 267 MB gzipped, 11% — proof the data is
  full of redundant vertices, but Mapbox won't accept the compressed form.)
- **The real lever is `PREPV_SIMPLIFY_M`.** At z10 (~138 m/px) detail below
  ~140 m is invisible, so simplifying to 300–400 m is visually free yet slashes
  vertex count and file size. Sieve harder (`PREPV_SIEVE_AREA_KM2` 0.2+) too.
- Run variants under **separate source/tileset IDs** (e.g. `..._s400`, `..._s200`)
  so a later attempt can't clobber an in-flight one.

---

## 9. Feature count is the wall — simplify doesn't help, sieve does

We proved the raw-GeoJSON→MTS path cannot be rescued by tuning geometry:

| Run | Res | Sieve | Simplify | Features | Raw GeoJSON |
|-----|-----|-------|----------|----------|-------------|
| baseline | 120 m | 0.1 km² | 100 m | 2,591,708 | 2.5 GB |
| s400 | 120 m | 0.2 km² | 400 m | 3,379,879 | 2.47 GB |
| 90 m | 90 m | 0.05 km² | 45 m | 4,490,584 | 4.0 GB |

- **File size tracks FEATURE COUNT, not vertices.** simplify-400 (2.47 GB) vs
  simplify-100 (2.5 GB) is proof — each polygon carries ~700 B of GeoJSON
  structural overhead, so millions of tiny polygons = GB regardless of simplify.
- The only geometry lever that shrinks the raw file is the **sieve** (drops whole
  small polygons), but sieving hard enough to fit the gateway throws away real
  vegetation the user wants to keep.
- **Conclusion:** stop trying to fit a raw file through MTS. Do the tiling
  locally (§10).

---

## 10. THE FIX — build vector tiles LOCALLY (no tippecanoe, no admin)

**Problem:** MTS rejects our multi-GB raw GeoJSON (and rejects gzip). Tippecanoe
(the usual answer) needs Linux/Docker/WSL — none available on a locked-down
GOV machine.

**Solution:** GDAL's built-in **MVT writer** does the same job as tippecanoe —
slices polygons into per-zoom vector tiles and packs them into a single
`.mbtiles` — and it ships inside the `gdal-async` we already use. Verified:
`gdal.drivers.get('MVT')` → `DCAP_CREATE: YES`.

### New pipeline

```
prepare-vector.mjs → nvis_mvg_vector_90m.geojsonl  (4 GB, LOCAL intermediate — fine)
build-mbtiles.mjs  → nvis_mvg_90m.mbtiles          (GDAL MVT, per-zoom tiling, LOCAL)
upload-mbtiles.mjs → Mapbox Uploads API            (accepts .mbtiles; SigV4 S3 stage)
```

- `scripts/build-mbtiles.mjs` — `vectorTranslate` to `-f MVT` with
  `MINZOOM/MAXZOOM`, `SIMPLIFICATION` (per-zoom, in tile px), `MAX_SIZE`
  (per-tile byte budget → auto drop-densest), `COMPRESS=YES`, `FORMAT=MBTILES`.
- `scripts/upload-mbtiles.mjs` — uses the **classic Uploads API** (not MTS):
  1. GET `/uploads/v1/{user}/credentials` → temporary S3 creds
  2. PUT the `.mbtiles` to S3 (**hand-rolled AWS SigV4**, zero deps — uses Node
     `crypto`; no `aws-sdk` needed on the locked-down box)
  3. POST `/uploads/v1/{user}` → ingest staged file into the tileset
  4. poll until `complete`
- npm: `vec:build`, `mb:upload`, `mb:status`.

### Behaviour notes / gotchas
- GDAL's MVT writer **buffers all features into `*.mbtiles.temp.db` first**, then
  generates tiles. So the final `.mbtiles` stays a 16 KB header until near the
  end — watch the **temp.db size** for real progress, not the output file.
- `progress_cb` only starts reporting in the tile-generation phase (after the
  buffering), so early logs look idle even though it's working.
- **Build time scales with feature count × zoom levels and is single-threaded.**
  90 m / 4.49 M features / z0–11 ran at ~5%/15 min → **~4–5 h ETA**. Options to
  cut it: sieve harder (fewer features), lower `MVT_MAXZOOM`, or accept the wait.

---

## 11. Cost of hosting & extra zoom (does z11 blow up the bill?)

**Short answer: adding z11 does NOT inflate routine cost.** Mapbox bills for
tiles *actually requested by users*, and a client only fetches tiles for the
**current viewport at the current zoom**. Someone looking at Australia at z5
downloads a handful of z5 tiles whether the tileset stops at z10 or z11 — the
deeper levels cost nothing until a user zooms in there.

What actually drives cost:

| Driver | Effect on cost | Notes |
|--------|----------------|-------|
| **Map loads / tile requests by real users** | **Primary cost** | Billed per map load (GL JS) or per tile request. Scales with *traffic*, not tileset depth. |
| Tileset **max zoom** | ~Neutral for routine use | Only costs when users zoom to that level; most sessions never reach z11. |
| Viewport size / panning | Moderate | Bigger screens + lots of panning = more tiles, but tiles are **cached** client- and edge-side. |
| **Tileset hosting/storage** | Minor, flat-ish | Free tier is generous; a compact `.mbtiles` is small. |
| Tileset **processing** (Uploads API) | One-off | Charged per processing, not per view. Uploads API is cheap/free within limits. |

Practical guidance:
- **z11 is safe to keep** — it improves the zoomed-in experience for the few who
  go there, at ~no cost to the majority who don't.
- The real budget lever is **map loads** (how many users load the map how often),
  addressed with Mapbox's free monthly allowance + caching, not by cutting zoom.
- If you ever want to hard-cap spend, set a lower `MVT_MAXZOOM` (e.g. 9–10) — but
  do it for *performance/build-time* reasons, not to control per-view cost.
- Because we store **only the `mvg` id** (colour/name are client-side), tiles are
  as small as possible → fewer bytes per request → lower cost and faster loads.

**Bottom line:** the extra zoom is a build-time cost (hours to tile), not a
runtime money pit. Routine expense is governed by *user traffic*, which is the
same whether the tileset ends at z10 or z11.

---

## 12. Key takeaways (one-liners)

- **The raster "resolution limit" was really an append bug** — sources accumulate
  uploads; always delete first.
- **maxzoom ≠ source size** — lowering zoom never fixed the raster failures.
- **Vector beats raster here** — sidesteps the pixel limit, adds interactivity,
  and overzooms crisply.
- **File size = feature COUNT, not vertices** — simplify barely helps; only the
  sieve (dropping whole polygons) shrinks the raw file.
- **Gzip won't rescue an oversized source** — MTS rejects compressed uploads.
- **When MTS won't take the raw file, tile it LOCALLY** — GDAL's MVT writer is a
  tippecanoe substitute that needs no admin rights / Docker / WSL.
- **GDAL MVT buffers to `*.temp.db` first** — watch that file for progress; the
  final `.mbtiles` fills only at the end.
- **Upload `.mbtiles` via the classic Uploads API** — SigV4 S3 stage can be
  hand-rolled with Node `crypto`; no `aws-sdk` needed.
- **Extra zoom ≠ extra routine cost** — clients fetch only the current viewport;
  cost tracks user traffic (map loads), not tileset depth.
- **Store the class id only** — name/colour are a client-side lookup; smallest
  tiles, restyle without re-tiling.
- **Do heavy geo work in C++/on disk, not a JS loop** — that was the 4.5-hour
  lesson.

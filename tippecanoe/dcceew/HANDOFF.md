# NVIS MVG Tileset — Project Handoff

Written 2026-08-20 as context for picking this work up elsewhere (e.g. a PoC in another
repo, or another assistant with no history here). Distilled from `BUILD_SETTINGS.md`,
`LESSONS_AND_WORKFLOW.md`, `CLOUD_BUILD.md`, and `BUILD_DONE.txt`.

---

## 1. What this project is

Turn Australia's **NVIS v7.0 Major Vegetation Groups** (21,315,015 polygons) into a
Mapbox **vector tileset** that renders the whole continent's vegetation classes in a
browser.

| Thing | Value |
|---|---|
| Source | DCCEEW NVIS v7.0 state vector geodatabase, `NVIS_V7_0_VECTOR_STATE_FILES_EXT.gdb` (~13.97 GB download) |
| Source page | https://fed.dcceew.gov.au/datasets/be9930d6de354ace93fd1aa5d34a71de/about |
| Licence | CC BY 4.0 — Commonwealth of Australia (DCCEEW) 2024 |
| Feature count | **21,315,015** (verified; 0 unmatched, 0 null on the join) |
| Layers in gdb | 8, one per state/territory: `NVIS7_0_AUST_EXT_{ACT,NSW,NT,QLD,SA,TAS,VIC,WA}` |
| Tileset id | `kevinthiele.nvis_mvg_vector` |
| Layer name & property | both `mvg` (a single integer, nothing else) |
| Hard limit | Mapbox rejects any tile > **500 KB** |

**Design decision that shapes everything:** tiles carry *only* the integer `mvg` code.
Names and colours are resolved client-side from [mvg-legend.json](mvg-legend.json). This
keeps tiles tiny and makes re-styling a static-file edit, not a rebuild.

---

## 2. The one non-obvious data problem (read this first)

The polygons carry only `NVISDSC1`. The `MVG_NUMBER` you actually want lives in a
separate lookup table, `NVIS7_0_LUT_AUST_DETAIL` (19,434 rows), joined on
`NVISDSC1 -> NVIS_ID`.

**GDAL < 3.9 cannot read that table at all** — it uses an Esri BigInteger column and GDAL
errors with *"field type 13"*. The workaround, already done:

> The lookup was pre-extracted **once** using a GDAL 3.12 build and frozen to JSON as
> [SAFE_KEEP/nvis_id_to_mvg.json](SAFE_KEEP/nvis_id_to_mvg.json).

That file is why `SAFE_KEEP/` exists. See §4.

---

## 3. The pipeline

### Stage 1 — convert + join (per state)

[SAFE_KEEP/worker.sh](SAFE_KEEP/worker.sh) does one state (optionally one OBJECTID range):

```
ogr2ogr -f GeoJSONSeq /vsistdout/ "$GDB" "NVIS7_0_AUST_EXT_${ST}" \
    -t_srs EPSG:4326 -dim XY -select NVISDSC1 -nlt MULTIPOLYGON \
    -lco COORDINATE_PRECISION=6 -where "$WHERE" \
  | python3 map_mvg.py nvis_id_to_mvg.json > out/${TAG}.geojsonl
```

- reprojects Australian Albers -> EPSG:4326
- keeps geometry + `NVISDSC1` only
- [SAFE_KEEP/map_mvg.py](SAFE_KEEP/map_mvg.py) streams the GeoJSONSeq line-by-line and
  regex-replaces the whole properties bag with `{"mvg": <int>}`; unmatched/null becomes
  `99` ("Unknown/no data"). It prints a `MAPSTATS` JSON line to stderr — **use it as the
  integrity check** (we got `unmatched=0, null=0`).
- Override `GDB=`, `MAP=`, `MAPPY=`, `OUT=` as env vars — the defaults are hardcoded
  laptop paths ([worker.sh:9-13](SAFE_KEEP/worker.sh#L9-L13)).

Result: 71 GB of GeoJSONSeq. **NSW is 62 GB of that** (14.3 M of the 21.3 M features) and
dominates every timing in this project — 84 min just to convert.

### Stage 2 — geometry pre-simplify

```
ogr2ogr -f GeoJSONSeq -simplify 0.0001 -lco COORDINATE_PRECISION=6 out.geojsonl in.geojsonl
```

`0.0001°` ≈ **11 m** ≈ one z13 pixel, so it is invisible on the rendered map. Cuts the
data **71 GB -> 15 GB (79%)**. Takes ~2 h, NSW alone 1 h 42 m.

Caveat: it's *non-topological*, so it can open sub-pixel sliver gaps between neighbouring
polygons. Fine for a visual map; not fine if anyone needs precise vectors for GIS
analysis.

### Stage 3 — tile with tippecanoe

Base flags that are correct regardless of machine:

```
-l mvg --drop-densest-as-needed --coalesce-densest-as-needed \
--drop-fraction-as-needed --no-simplification-of-shared-nodes \
--read-parallel --force --temporary-directory=<native ext4>
```

Zoom range, `--maximum-tile-bytes`, `--simplification` and the piece count are all
machine-dependent — see §5 and §6.

### Stage 4 — join and publish

`tile-join` the pieces, then [publish-to-mapbox.sh](publish-to-mapbox.sh) (Mapbox Uploads
API: staging creds -> S3 -> ingest job -> poll). It **prompts for the secret token at run
time** rather than reading it from disk — keep that property in any port.

Gotcha already encoded in that script: a token with only `tilesets:*` scopes returns a
misleading **404** on `/uploads/v1/`, not a permission error. It needs `uploads:write` +
`uploads:read`.

---

## 4. What `SAFE_KEEP/` is

250 KB of hard-to-regenerate artefacts, deliberately parked on the Windows side (outside
WSL) after an earlier data-loss incident. With these four files plus a fresh download of
the geodatabase you can rebuild the entire dataset anywhere:

| File | Why it matters |
|---|---|
| `nvis_id_to_mvg.json` | The 240 KB lookup. Regenerating needs a GDAL 3.12 build (see §2). **This is the irreplaceable one.** |
| `map_mvg.py` | The streaming NVISDSC1 -> mvg rewriter + integrity stats |
| `worker.sh` | Per-state ogr2ogr conversion driver |
| `mvg_palette.json` | Authoritative MVG code -> name + RGB, for the legend and for visual validation against the official NVIS map |

**Take all four to any new project.** They are the whole data-prep story in a few hundred
KB, versus 15–71 GB of derived GeoJSON.

---

## 5. Tiling constraints that carry to any machine

tippecanoe lessons that apply regardless of hardware:

1. **Keep `--maximum-tile-bytes` above ~110 KB.** Some NVIS polygons have 100+ parts; a
   *single* feature's z8 tile is **103 KB** at `--simplification=30`. No dropping goes
   below one feature, so a budget under that floor aborts with *"Can't increase feature
   gap threshold further."*
2. **`--simplification=30`, not 10.** At light values the z2 "whole continent" mega-tile
   makes tippecanoe thrash for hours. 30 clears it and is invisible when zoomed out.
3. **`--drop-densest-as-needed`, never `--drop-smallest-as-needed`.** "Keep the biggest
   zones" re-sorts millions of features per low-zoom tile and hangs the build.
4. **Avoid** `--extend-zooms-if-still-dropping` (breaks a fixed zoom contract) and global
   `--coalesce`/`--reorder` (lock-bound, ~3× slower, cosmetic only).

On an undersized disk there's a second, machine-specific fight — tippecanoe scratch space
(~300–500 GB for a full pass), the WSL `/mnt/c` I/O bridge, `ext4.vhdx` creep, and
splitting the build into pieces. A high-spec build (§8) sidesteps all of it. If you must
build on a constrained machine, [LESSONS_AND_WORKFLOW.md](LESSONS_AND_WORKFLOW.md) has the
full account.

---

## 6. What actually shipped

The build that completed and passed ([BUILD_DONE.txt](BUILD_DONE.txt), 2026-07-28):

> **3 pieces · 165 KB budget · zoom 9–13** → `nvis_mvg_hi3.mbtiles` (2.9 GB),
> 549,746 tiles; biggest **374 KB**; tiles over 500 KB: **0** — PASS

Zoom stops at **9 because the raster tileset `kevinthiele.nvis_mvg` owns z0–8** (the app
crosses over via `VITE_NVIS_TILESET_ID` / `VITE_VEG_VECTOR_MIN_ZOOM`). To build the full
range instead, see §9.

> `BUILD_SETTINGS.md` documents an earlier, superseded laptop split (4 pieces / 120 KB /
> z0–13) — **trust `BUILD_DONE.txt` over it.**

---

## 7. ⚠ Secrets

The original `token.txt` in this folder held a **live Mapbox secret (`sk.`) token in
plaintext** — it was **not** copied into the PoC repo. Rotate it at
https://account.mapbox.com/access-tokens/ — it has upload scopes. The standalone
viewer (`viewer_config.js` and its `pk.` token) was also trimmed during the port;
the PoC app uses a public `pk.` token via `VITE_MAPBOX_TOKEN` in `.env`.

---

## 8. Building on a well-specced machine

The laptop-era constraints in §5 only bite on an undersized disk. On a machine with the
headroom — roughly **≥128 GB RAM** and **≥500 GB free fast (NVMe/SSD) scratch** — you do
**one full-detail pass**: no splitting, no pre-simplify, no `--simplification=30`, full
500 KB budget. That removes every constraint in §5 at once.

[cloud_build.sh](cloud_build.sh) is that single-pass build — it's a plain Ubuntu script
(installs tippecanoe + GDAL, tiles, self-verifies), so it runs the same on a **local
Ubuntu/WSL2 box** as on a cloud VM. Just point it at the converted `out/*.geojsonl` and
run. See [CLOUD_BUILD.md](CLOUD_BUILD.md) for the step-by-step.

**No machine big enough?** Rent a ~128 GB-RAM / 1 TB-SSD Ubuntu VM hourly (~$3–8/h, job
3–6 h, **~$20–50 total**), build, publish, destroy it. An external ≥500 GB USB-3 SSD fixes
the *disk* half locally, but you still need the RAM and the toolchain.

---

## 9. Full-range build + the app switch (two knobs)

The shipped build stops at **z9** only because a raster tileset owned z0–8. To build the
vector across the **full range**, there are two independent knobs — one on the build, one
on the app — and they should match:

1. **Build (tippecanoe zoom range)** — already parameterised in
   [cloud_build.sh](cloud_build.sh) as env vars:
   ```bash
   MINZOOM=0 MAXZOOM=13 bash cloud_build.sh   # full range instead of the z9 default
   ```
   `MINZOOM`/`MAXZOOM` map straight to `--minimum-zoom`/`--maximum-zoom`. Nothing else
   needs changing for a wider range; on a high-spec VM the single full-detail pass at the
   full 500 KB budget clears the low-zoom mega-tile problem that forced the laptop
   compromises (§5).

2. **App (raster→vector crossover)** — set in the PoC's `.env`:
   ```bash
   VITE_VEG_VECTOR_MIN_ZOOM=0   # show vector all the way down; 9 = keep raster below z9
   ```
   This drives the `vectorMinZoom` prop in `src/components/NvisVectorMap.vue` (raster
   `maxzoom` + vector `minzoom`). If the vector covers z0–13 you can also drop the raster
   overview entirely by leaving `VITE_NVIS_TILESET_ID` unset.

**Rule of thumb:** set `VITE_VEG_VECTOR_MIN_ZOOM` to whatever `MINZOOM` the team built the
vector with, so the app never asks for vector tiles below the tileset's minimum zoom.

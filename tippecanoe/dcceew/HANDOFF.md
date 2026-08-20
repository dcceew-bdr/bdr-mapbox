# NVIS MVG Tileset — Project Handoff

Written 2026-08-20 as context for picking this work up elsewhere (e.g. a PoC in another
repo, or another assistant with no history here). Distilled from `BUILD_SETTINGS.md`,
`LESSONS_AND_WORKFLOW.md`, `CLOUD_BUILD.md`, `RECOVERY_STATUS.txt`, `BUILD_DONE.txt` and
the logs in `NVIS_SOURCE/`, plus a live check of the machine state.

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

## 5. Constraints learned the hard way (numbers, not vibes)

All measured on the laptop. They are the reason the build settings look odd.

1. **Scratch space is the binding constraint.** A single full-detail national pass needs
   **~300–500 GB** of tippecanoe scratch. The laptop's C: had ~170 GB. Nearly every
   failure traces to this.
2. **There is a minimum viable `--maximum-tile-bytes`.** Some NVIS polygons have 100+
   parts; a *single* feature's z8 tile is **103 KB** at `--simplification=30` (117 KB at
   10). No amount of dropping goes below one feature, so a budget under that floor aborts
   with *"Can't increase feature gap threshold further."* Early attempts at 55 KB died
   this way.
3. **Low zoom wants small pieces; the z8 floor wants a high budget (= few pieces).** These
   pull opposite ways, and the piece count is whatever satisfies both.
4. **`--simplification=30`, not 10.** At light values the z2 "whole continent" mega-tile
   makes tippecanoe thrash for hours. 30 clears it and is invisible when zoomed out.
5. **`--drop-densest-as-needed`, never `--drop-smallest-as-needed`.** "Keep the biggest
   zones" re-sorts millions of features per low-zoom tile and hangs the build.
6. **Never put `--temporary-directory` on `/mnt/c` or `/mnt/d`.** The Windows<->Linux
   bridge runs at **~1 MB/s** for tippecanoe's random I/O — effectively a hang.
7. **WSL's virtual disk creeps.** `ext4.vhdx` grows with scratch and never auto-shrinks;
   deleting scratch frees space *inside* the file, not on C:. Reclaiming needs `fstrim`
   then an admin `diskpart compact` with WSL shut down (see [compact_now.txt](compact_now.txt),
   [reclaim-disk.ps1](reclaim-disk.ps1)). Cannot be automated — UAC.
8. **Detached `nohup ... &` loops inside WSL silently die.** Use a tracked/managed
   background task for anything unattended.
9. **Never run fsck on a faulted filesystem before copying the readable data off.** Doing
   so cost 71 GB of converted data early in this project.

Avoid `--extend-zooms-if-still-dropping` (breaks a fixed zoom contract) and global
`--coalesce`/`--reorder` (lock-bound, ~3x slower, cosmetic only).

---

## 6. ⚠ Doc drift — what actually shipped

**`BUILD_SETTINGS.md` describes a build that was superseded.** It documents
*4 pieces / 120 KB budget / zoom 0–13*. The build that actually completed and passed
([BUILD_DONE.txt](BUILD_DONE.txt), 2026-07-28) was:

> **3 pieces · 165 KB budget · zoom 9–13** -> `nvis_mvg_hi3.mbtiles` (2.9 GB)
> 549,746 tiles; biggest **374 KB**; tiles over 500 KB: **0** — PASS

The zoom range narrowed to **9–13 because a separate raster tileset owns z0–8**
(`kevinthiele.nvis_mvg`; in this PoC the app sets it via `VITE_NVIS_TILESET_ID`
and crosses over to vector at z9). Dropping z0–8 removes the low-zoom mega-tile
problem entirely, which is what allowed 3 pieces at a higher budget. There is also a
`simp5m/` dataset in WSL (~19 GB, a 5 m simplify) distinct from the 11 m `out/` — the
final build used the 5 m one.

**If you port this: trust `BUILD_DONE.txt` over `BUILD_SETTINGS.md`.** The build scripts
themselves (`national_split2.sh` and friends) lived inside WSL and are **not recoverable
from disk** — they are no longer in `/root/nvis`. The settings above are the record.

---

## 7. Current machine state (checked 2026-08-20)

- The **default WSL distro `Ubuntu` is broken** — it points at `D:\WSL\ext4.vhdx` and D:
  is not attached, so plain `wsl` fails with `ERROR_PATH_NOT_FOUND`.
- The real work is in **`Ubuntu-24.04`** (130 GB vhdx on C:). Reach it explicitly with
  `wsl -d Ubuntu-24.04`.
- Surviving artefacts there: `/root/nvis/out/` (71 GB raw), `/root/nvis/simp5m/` (19 GB),
  `/root/nvis/national_hi/nvis_mvg_hi3.mbtiles` (2.9 GB, the finished tileset).
- Nothing has been published to Mapbox — publishing was always left to a human.

---

## 8. ⚠ Secrets

The original `token.txt` in this folder held a **live Mapbox secret (`sk.`) token in
plaintext** — it was **not** copied into the PoC repo. Rotate it at
https://account.mapbox.com/access-tokens/ — it has upload scopes. The standalone
viewer (`viewer_config.js` and its `pk.` token) was also trimmed during the port;
the PoC app uses a public `pk.` token via `VITE_MAPBOX_TOKEN` in `.env`.

---

## 9. If the PoC has a real budget

The laptop fight was entirely about undersized scratch. [CLOUD_BUILD.md](CLOUD_BUILD.md)
has the clean path: rent a ~128 GB-RAM / 1 TB-SSD Ubuntu VM hourly (~$3–8/h, job is 3–6 h,
**~$20–50 total**), do **one full-detail pass** — no splitting, no pre-simplify, no
`--simplification=30`, full 500 KB budget — publish, destroy the VM. That removes every
compromise in §5 at once. A dedicated external SSD (≥500 GB, USB 3) does the same thing
locally.

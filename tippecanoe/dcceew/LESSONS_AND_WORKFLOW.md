# NVIS MVG Tileset — Lessons Learned & Robust Workflow

Building a Mapbox vector tileset of Australia's NVIS v7.0 Major Vegetation Groups
(**21,315,015 polygons**, tileset `kevinthiele.nvis_mvg_vector`, layer + property both
named `mvg`, zooms 0–13, no tile > 500 KB) with **tippecanoe** on a Windows laptop via
**WSL2**. This documents what went wrong, why, and the workflow we now trust.

---

## The core constraint (why this was hard)

tippecanoe needs a large **scratch/temp** area while it sorts and tiles. For the full
21.3M-polygon dataset at full geometry detail that peaks at **~300–500 GB**. The build
machine's C: drive only has **~170 GB free**. So the whole job never fit, and almost
every failure below traces back to that one mismatch.

The external 7.45 TB drive was **off-limits** — it holds irreplaceable family photos, it's
a slow SMR USB disk, and it had already faulted once under sustained write load.

---

## What killed the processing (in order)

1. **USB drive fault → data loss.** An early attempt ran the build on the external USB
   drive. Under 27 h of sustained writes its filesystem went read-only. **A repair (fsck)
   was run before copying the still-readable data off — which freed the 71 GB of converted
   data.** Root lesson: *never run a destructive repair on a faulted filesystem before
   copying the readable data to safety first.*

2. **Scratch estimate too low → C: nearly filled.** Split builds used pieces of ~4.3M
   polygons; each needed **~90–120 GB scratch**, not the ~60 GB estimated. C: dropped to
   40 GB before a guard caught it.

3. **The virtual disk "creeps."** WSL's Linux disk is one big dynamically-expanding file
   on C:. It **grows with scratch and never auto-shrinks.** Deleting scratch frees space
   *inside* the file but not on C:. Reclaiming needs an **admin `diskpart compact`** with
   WSL shut down. So each big piece permanently ate C: until a manual compaction.

4. **Scratch "outside the disk file" = 1 MB/s.** Moving tippecanoe's temp to C: directly
   (via the `/mnt/c` bridge) avoided the creep but ran at **~1 MB/s** — effectively
   stalled (2 h and piece 0 hadn't started tiling). The Windows↔Linux file bridge is
   unusable for tippecanoe's heavy random I/O.

5. **Budget floor error.** To fit many small pieces we used `--maximum-tile-bytes=55000`.
   Some NVIS polygons are absurdly complex (100+ parts); a *single* one exceeds 55 KB, so
   tippecanoe aborted with *"Can't increase feature gap threshold further."* There is a
   **minimum tile size set by the most complex polygon** — the budget can't go below it.

6. **Detached background loops kept dying.** Overnight orchestration launched as
   `nohup ... &` inside WSL silently vanished more than once. Managed/tracked background
   tasks are far more reliable for anything that must persist.

7. **Waiter timeout too short.** An overnight script waited only 90 min for the geometry
   simplification — but **NSW alone took 1 h 42 m** to simplify. It gave up prematurely.

---

## The key breakthrough: geometry simplification

Blanket-simplifying the polygon geometry with GDAL —
`ogr2ogr -f GeoJSONSeq -simplify 0.0001 ...` (≈ 11 m, about one z13 pixel) — **cut the data
by 79 %** (71 GB → 15 GB; NSW 59 GB → 8.6 GB). That collapses the scratch requirement so
the build fits C: comfortably and fast.

- **Visually invisible** at these zooms: the simplification tolerance is smaller than a
  z13 pixel, so nothing changes on the rendered map. The vegetation codes (`mvg`) are
  untouched — only boundary vertices are thinned.
- **Caveat:** it's non-topology simplification, so it can open sub-pixel sliver-gaps
  between adjacent polygons. Irrelevant for a *visual* map; only matters if someone needs
  the *precise vectors* for GIS analysis — that's the full-detail / SSD path.
- **It's slow:** ~2 h total, NSW dominating. Budget for it.

---

## The robust workflow (what we now trust)

1. **Convert** the source geodatabase to per-state GeoJSONSeq with a single integer `mvg`
   property (join NVISDSC1 → MVG via the lookup; verify total = 21,315,015, 0 unmatched).
   Keep the converted data in **two places** before any heavy build.
2. **Simplify** the geometry (`ogr2ogr -simplify 0.0001`). Allow ≥ 3 h.
3. **Build in a few ID-split pieces** (e.g. 4), one at a time, **scratch INSIDE the WSL
   ext4** (native speed), wiping scratch between pieces. Each piece is a nationwide random
   sample so the join reconstructs full coverage.
4. **`tile-join`** the pieces into one national `.mbtiles`.
5. **Verify**: no tile > 500 KB, zooms 0–13 present, feature/coverage sanity.

### Hard rules
- **Never** put tippecanoe `--temporary-directory` on `/mnt/c` or `/mnt/d` (1 MB/s).
- Keep `--maximum-tile-bytes` **above ~90 KB** (the complex-polygon floor).
- Keep each piece **small enough that its scratch fits C:** with margin; a guard should
  halt the build if C: free drops below ~55 GB.
- To reclaim C: after builds: `fstrim` inside WSL, then admin `diskpart compact` (WSL
  shut down). Requires the user — cannot be automated (UAC).
- For anything that must run unattended, use a **managed/tracked** background task, not a
  detached WSL `nohup` loop.
- The correct tippecanoe flags here: `-l mvg --minimum-zoom=0 --maximum-zoom=13
  --drop-densest-as-needed --coalesce-densest-as-needed --simplification=10
  --no-simplification-of-shared-nodes --read-parallel`. Avoid global `--coalesce`/
  `--reorder` (lock-bound, ~3× slower, only cosmetic) and `--extend-zooms-if-still-dropping`
  (breaks the z0–13 contract).

### The clean alternative
A **dedicated external SSD** (≥ 500 GB free, USB 3, not the photo drive) removes the whole
disk fight: one full-detail build, no simplification, no splitting, no compactions. If the
simplified demo isn't adequate, that's the recommended path.

---

*Written 2026-07-26 during the build. The disk saga cost ~2 days; the data work
(conversion, the MVG join, verification) was sound throughout — the fight was entirely
scratch-space mechanics on an undersized drive.*

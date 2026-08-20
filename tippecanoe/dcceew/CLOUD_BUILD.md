# NVIS — Flawless Build on a Cloud Machine

The laptop can't produce a perfectly clean vector because NSW alone is **58 GB** of
geometry and there isn't enough RAM to process it whole. A rented cloud machine with lots
of RAM removes every compromise: **one full-detail pass, no splitting, no simplification,
no dropping, no slivers.** Rent it for an afternoon, build, publish, delete it.

---

## 1. What to rent

An **Ubuntu 22.04 or 24.04** virtual machine, billed **hourly**:

| Spec | Target | Why |
|---|---|---|
| RAM | **≥ 128 GB** (256 GB for comfort) | The whole-country geometry sort — this is the wall the laptop hits. |
| CPU | **16–32 vCPUs** | Tiling is CPU-bound; more cores = faster. |
| Disk | **~1 TB SSD** | Scratch for a full-detail build is ~300–500 GB, plus data + output. |

**Cost:** roughly **$3–8/hour**; the whole job is ~3–6 h, so **~$20–50 total**, then you
destroy it. Nothing ongoing.

**Where (easiest first):**
- **DigitalOcean** — simplest interface, "Memory-Optimized" droplet, hourly. Good for a first-timer.
- **Hetzner Cloud** — cheapest; "CCX" dedicated-vCPU plans have lots of RAM.
- **AWS / GCP / Azure** — if you already have an account: pick a memory-optimized instance
  (AWS `r7i.4xlarge` = 16 vCPU/128 GB, or `r7i.8xlarge` = 32/256; GCP `n2-highmem-32`;
  Azure `E32as_v5`) + a 1 TB SSD volume.

---

## 2. Get the data onto it

You need the 8 converted files in `/root/nvis/out` (71 GB total). Two ways:

**A. Upload from the laptop (simplest).** Compress first — GeoJSON shrinks a lot:
```
# on the laptop (WSL):
cd /root/nvis && tar czf out.tar.gz out            # ~71 GB -> ~15-20 GB
# then copy to the cloud VM (replace IP):
scp out.tar.gz root@CLOUD_IP:/root/
# on the cloud VM:
cd /root && tar xzf out.tar.gz
```
(If your home upload is slow, this is the bottleneck — a few hours. Option B avoids it.)

**B. Rebuild the data on the cloud (fast internet there).** Re-download the NVIS v7.0
geodatabase from the DCCEEW source, upload the small lookup + scripts from the project's
`SAFE_KEEP/` folder (a few hundred KB), and re-run the conversion there. Ask me and I'll
give you the exact conversion commands for the cloud.

---

## 3. Install the tools (on the cloud VM)

```
apt-get update
apt-get install -y build-essential libsqlite3-dev zlib1g-dev gdal-bin git
# tippecanoe:
git clone https://github.com/felt/tippecanoe.git
cd tippecanoe && make -j && make install && cd ..
```

---

## 4. Build — one clean full-detail pass

No splitting, no pre-simplify. tippecanoe's own simplification keeps shared borders aligned
(no slivers), and the full 500 KB budget means nothing gets dropped.

```
tippecanoe -o nvis_mvg.mbtiles -l mvg \
  --minimum-zoom=9 --maximum-zoom=13 \
  --maximum-tile-bytes=500000 \
  --drop-densest-as-needed --coalesce-densest-as-needed \
  --no-simplification-of-shared-nodes \
  --read-parallel --force \
  /root/nvis/out/*.geojsonl
```
Notes:
- `--minimum-zoom=9` because your raster owns z0–8. Change to `0` if you also want the
  vector to cover low zooms.
- With 128 GB+ RAM this runs in one pass; no 4-piece split, no `--simplification=30`,
  no 5 m pre-simplify — **that's why it comes out clean.**
- Verify: `sqlite3 nvis_mvg.mbtiles "select max(length(tile_data)),min(zoom_level),max(zoom_level) from tiles;"`
  (biggest tile should be < 500000).

---

## 5. Publish, then delete the machine

Publish the same way we did from the laptop (needs the Mapbox **secret** upload token):
```
apt-get install -y awscli jq curl
bash publish-to-mapbox.sh nvis_mvg.mbtiles   # prompts for the sk. token at runtime
```
…or just download `nvis_mvg.mbtiles` to your laptop and publish/host from there.

**Then destroy the instance** in the provider's console so billing stops.

---

## My recommendation
DigitalOcean, a 128 GB Memory-Optimized droplet, Option A (compressed upload) if your home
upload is decent, else Option B. Ping me when you spin it up and I'll give you the exact
copy-paste commands for your provider + the data step. Total spend ~$20–50 for a genuinely
flawless national tileset.

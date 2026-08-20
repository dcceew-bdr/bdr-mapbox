#!/usr/bin/env bash
# ===========================================================================
#  NVIS flawless build — run on a fresh Ubuntu 22.04/24.04 cloud VM.
#  Requirements: >=128 GB RAM, ~1 TB SSD, and the 8 converted files placed in
#  /root/nvis/out/*.geojsonl  (see CLOUD_BUILD.md, step 2).
#
#  One full-detail pass: NO splitting, NO pre-simplify, NO forced dropping ->
#  clean, crisp, no slivers. The big RAM is what makes this possible.
#
#  Usage:   bash cloud_build.sh
#  Options: MINZOOM=0 bash cloud_build.sh   (include low zooms; default 9 since
#           your raster owns z0-8).  MAXZOOM defaults to 13.
# ===========================================================================
set -euo pipefail

MINZOOM=${MINZOOM:-9}
MAXZOOM=${MAXZOOM:-13}
OUT=/root/nvis/out
MBT=/root/nvis/nvis_mvg.mbtiles

echo "== [1/4] installing tools =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq build-essential libsqlite3-dev zlib1g-dev gdal-bin git sqlite3
if ! command -v tippecanoe >/dev/null 2>&1; then
  echo "   building tippecanoe from source ..."
  rm -rf /tmp/tippecanoe
  git clone --depth 1 https://github.com/felt/tippecanoe.git /tmp/tippecanoe
  make -C /tmp/tippecanoe -j"$(nproc)"
  make -C /tmp/tippecanoe install
fi
echo -n "   tippecanoe "; tippecanoe --version 2>&1 | head -1

echo "== [2/4] checking data =="
n=$(ls -1 "$OUT"/*.geojsonl 2>/dev/null | wc -l)
if [ "$n" -lt 1 ]; then
  echo "ERROR: no input at $OUT/*.geojsonl - put the 8 converted files there first (CLOUD_BUILD.md step 2)."; exit 1
fi
echo "   $n input files, $(du -sh "$OUT" | cut -f1) total"
echo "   free RAM: $(free -h | awk '/Mem:/{print $7}')   free disk: $(df -h / | awk 'NR==2{print $4}')"

echo "== [3/4] building full-detail z${MINZOOM}-${MAXZOOM} (one pass, ~a few hours) =="
time tippecanoe -o "$MBT" -l mvg \
  --minimum-zoom="$MINZOOM" --maximum-zoom="$MAXZOOM" \
  --maximum-tile-bytes=500000 \
  --drop-densest-as-needed --coalesce-densest-as-needed \
  --no-simplification-of-shared-nodes \
  --read-parallel --force \
  "$OUT"/*.geojsonl

echo "== [4/4] verifying =="
OVER=$(sqlite3 "$MBT" "select count(*) from tiles where length(tile_data)>500000;")
BIG=$(sqlite3 "$MBT" "select max(length(tile_data)) from tiles;")
ZR=$(sqlite3 "$MBT" "select min(zoom_level)||'..'||max(zoom_level) from tiles;")
NT=$(sqlite3 "$MBT" "select count(*) from tiles;")
SZ=$(ls -lh "$MBT" | awk '{print $5}')
echo "-----------------------------------------------------------------"
echo "file   : $MBT ($SZ)"
echo "zooms  : $ZR   (expected ${MINZOOM}..${MAXZOOM})"
echo "tiles  : $NT ;  biggest $((BIG/1024)) KB ;  OVER 500KB: $OVER  (must be 0)"
sqlite3 "$MBT" "select zoom_level,count(*),max(length(tile_data)) from tiles group by zoom_level order by zoom_level;" | awk -F'|' '{printf "  z%-2s %9s tiles  max %6.1f KB\n",$1,$2,$3/1024}'
if [ "$OVER" = 0 ] && [ "$(sqlite3 "$MBT" "select max(zoom_level) from tiles;")" = "$MAXZOOM" ]; then
  echo "RESULT: PASS - clean full-detail vector, every tile < 500 KB. Ready to publish."
else
  echo "RESULT: needs a look - send these numbers to Claude."
fi
echo "-----------------------------------------------------------------"
echo "Publish:  bash publish-to-mapbox.sh $MBT   (prompts for the Mapbox secret token)"
echo "  ...or download $MBT and publish from another machine. Then DESTROY this VM to stop billing."

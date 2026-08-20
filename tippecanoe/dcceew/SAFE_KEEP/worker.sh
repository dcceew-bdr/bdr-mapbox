#!/usr/bin/env bash
# Conversion worker (recreated from the original, adapted for the fresh C: distro).
# For each state feature class: extract NVISDSC1 + geometry, reproject to 4326,
# pipe through map_mvg.py (NVISDSC1 -> mvg via the surviving lookup).
#
# Usage: worker.sh <STATE> <LO_OBJECTID> <HI_OBJECTID|->
set -uo pipefail
ST=$1; LO=$2; HI=$3
GDB=${GDB:-/root/nvis/gdb/NVIS_V7_0_VECTOR_STATE_FILES_EXT.gdb}
MAP=${MAP:-/mnt/c/Users/tourn/Documents/TECH_PROJECTS/dcceew/tippecanoe/SAFE_KEEP/nvis_id_to_mvg.json}
MAPPY=${MAPPY:-/mnt/c/Users/tourn/Documents/TECH_PROJECTS/dcceew/tippecanoe/SAFE_KEEP/map_mvg.py}
OUT=${OUT:-/root/nvis/out}
LAYER_PREFIX=${LAYER_PREFIX:-NVIS7_0_AUST_EXT_}
mkdir -p "$OUT/logs"

if [ "$HI" = "-" ]; then
  WHERE="OBJECTID >= $LO"; TAG="${ST}_${LO}_end"
else
  WHERE="OBJECTID >= $LO AND OBJECTID < $HI"; TAG="${ST}_${LO}"
fi

ogr2ogr -f GeoJSONSeq /vsistdout/ "$GDB" "${LAYER_PREFIX}${ST}" \
    -t_srs EPSG:4326 -dim XY -select NVISDSC1 -nlt MULTIPOLYGON \
    -lco COORDINATE_PRECISION=6 \
    -where "$WHERE" 2>"$OUT/logs/$TAG.ogr.log" \
  | python3 "$MAPPY" "$MAP" > "$OUT/$TAG.geojsonl" 2>"$OUT/logs/$TAG.map.log"
echo "done $TAG $(wc -l < "$OUT/$TAG.geojsonl")"

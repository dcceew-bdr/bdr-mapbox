#!/usr/bin/env python3
"""Stream GeoJSONSeq on stdin, replace the NVISDSC1 property with the integer
MVG code from the NVIS lookup, write GeoJSONSeq on stdout.

The polygons carry only NVISDSC1; MVG_NUMBER lives in NVIS7_0_LUT_AUST_DETAIL
(join NVISDSC1 -> NVIS_ID). GDAL <3.9 cannot read that table at all (Esri
BigInteger / "field type 13"), so the mapping is pre-extracted to JSON with a
GDAL 3.12 build and applied here.

Emits one property only: {"mvg": <int>}.
"""
import json
import re
import sys

MAPPING_PATH = sys.argv[1]
UNKNOWN = 99  # NVIS "Unknown/no data"

with open(MAPPING_PATH) as fh:
    mapping = {int(k): int(v) for k, v in json.load(fh).items()}

pat = re.compile(rb'"properties"\s*:\s*\{[^}]*\}')
num = re.compile(rb'"NVISDSC1"\s*:\s*(-?\d+)')

stats = {"total": 0, "mapped": 0, "unmatched": 0, "null": 0}
counts = {}
out = sys.stdout.buffer

for line in sys.stdin.buffer:
    if not line.strip():
        continue
    stats["total"] += 1
    m = num.search(line)
    if m is None:
        code = UNKNOWN
        stats["null"] += 1
    else:
        key = int(m.group(1))
        code = mapping.get(key)
        if code is None:
            code = UNKNOWN
            stats["unmatched"] += 1
        else:
            stats["mapped"] += 1
    counts[code] = counts.get(code, 0) + 1
    out.write(pat.sub(b'"properties":{"mvg":%d}' % code, line, count=1))

sys.stderr.write("MAPSTATS " + json.dumps({**stats, "by_mvg": counts}) + "\n")

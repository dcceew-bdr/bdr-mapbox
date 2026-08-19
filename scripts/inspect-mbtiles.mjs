#!/usr/bin/env node
// -----------------------------------------------------------------------------
//  Report per-zoom tile statistics for an .mbtiles file so we can tell, BEFORE
//  uploading, whether any tile busts Mapbox's 500 KB-per-tile ingest limit.
//
//  Opens the .mbtiles with GDAL's SQLite vector driver (not the MBTiles raster
//  driver) so we can run plain SQL against the `tiles` table. tile_data is the
//  gzip-compressed MVT blob — the same bytes Mapbox ingests — so LENGTH() is the
//  size that matters.
//
//  Usage:  node scripts/inspect-mbtiles.mjs [--file <path>]
// -----------------------------------------------------------------------------

import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { projectRoot } from './lib/env.mjs'
import gdal from 'gdal-async'

const argv = process.argv.slice(2)
const getArg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const rp = (p) => (isAbsolute(p) ? p : resolve(projectRoot, p))

const file = rp(getArg('file', '../NVIS_V7_30m/NVIS_V7_30m_Revised/nvis_mvg_ov500.mbtiles'))
const LIMIT = 500 * 1024 // Mapbox hard limit: 500 KB per tile

const kb = (n) => `${(n / 1024).toFixed(1)} KB`

console.log('— Inspect .mbtiles tile sizes —————————————————————————————')
console.log(`   file: ${file}  (${(statSync(file).size / 1048576).toFixed(0)} MB)`)
console.log('———————————————————————————————————————————————————————————')

// Force the SQLite driver so the `tiles` table is exposed as a queryable layer.
const ds = gdal.open(file, 'r', 'SQLite')

const sql = `
  SELECT zoom_level AS z,
         COUNT(*)            AS tiles,
         MAX(LENGTH(tile_data)) AS max_bytes,
         AVG(LENGTH(tile_data)) AS avg_bytes,
         SUM(LENGTH(tile_data)) AS sum_bytes
  FROM tiles
  GROUP BY zoom_level
  ORDER BY zoom_level`

const layer = ds.executeSQL(sql)
let worst = 0
let anyOver = false
console.log('  z |  tiles |   max tile |   avg tile | total')
console.log(' ---+--------+------------+------------+--------')
layer.features.forEach((f) => {
  const z = f.fields.get('z')
  const tiles = f.fields.get('tiles')
  const max = f.fields.get('max_bytes')
  const avg = f.fields.get('avg_bytes')
  const sum = f.fields.get('sum_bytes')
  worst = Math.max(worst, max)
  const flag = max > LIMIT ? '  ❌ OVER 500K' : ''
  if (max > LIMIT) anyOver = true
  console.log(
    ` ${String(z).padStart(2)} | ${String(tiles).padStart(6)} | ` +
      `${kb(max).padStart(10)} | ${kb(avg).padStart(10)} | ${kb(sum).padStart(8)}${flag}`
  )
})
ds.close()

console.log('———————————————————————————————————————————————————————————')
console.log(`   worst tile: ${kb(worst)}  (limit ${kb(LIMIT)})`)
console.log(
  anyOver
    ? '   ❌ FAIL — at least one zoom exceeds 500 KB; Mapbox ingest will reject it.'
    : '   ✅ PASS — every tile is under 500 KB; safe to upload.'
)
process.exit(anyOver ? 1 : 0)

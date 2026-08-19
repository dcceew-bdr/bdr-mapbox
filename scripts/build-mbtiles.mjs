#!/usr/bin/env node
// -----------------------------------------------------------------------------
//  Build a vector-tile .mbtiles LOCALLY from the prepared GeoJSONSeq, using
//  GDAL's MVT writer (via gdal-async). This is the tippecanoe-free, install-free
//  equivalent of "tile it on your own machine, upload a compact tileset".
//
//  Why this exists:
//    The raw GeoJSON (2.5 GB) is rejected by Mapbox's MTS gateway. Instead we
//    do the tiling HERE — GDAL slices the polygons into per-zoom vector tiles,
//    simplifying and dropping detail appropriately at each zoom, and packs them
//    into a single .mbtiles container. That artifact is tens of MB and uploads
//    via Mapbox's classic Uploads API without hitting the size limit.
//
//  Key GDAL MVT dataset-creation options used:
//    MINZOOM / MAXZOOM  - zoom range to generate
//    SIMPLIFICATION     - Douglas-Peucker tolerance (in tile pixels) per zoom;
//                         higher = smaller tiles, less detail at low zoom
//    MAX_SIZE           - soft per-tile byte budget; features are dropped/merged
//                         to stay near it (the "drop densest" behaviour)
//    COMPRESS           - gzip the tile blobs inside the mbtiles (Mapbox-friendly)
//
//  Usage:   npm run vec:build   (or: node scripts/build-mbtiles.mjs)
//  Input:   PREPV_GEOJSON   Output: MBTILES_PATH   (both from .env)
// -----------------------------------------------------------------------------

import { existsSync, mkdirSync, rmSync, statSync, appendFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { loadEnv, getEnv, projectRoot } from './lib/env.mjs'
import gdal from 'gdal-async'

loadEnv()

function resolvePath(p) {
  return isAbsolute(p) ? p : resolve(projectRoot, p)
}

const DEFAULT_DIR = '../NVIS_V7_30m/NVIS_V7_30m_Revised'
const inGeojson = resolvePath(getEnv('PREPV_GEOJSON', `${DEFAULT_DIR}/nvis_mvg_vector.geojsonl`))
const outMbtiles = resolvePath(getEnv('MBTILES_PATH', `${DEFAULT_DIR}/nvis_mvg.mbtiles`))
const layerName = getEnv('MVT_LAYER_NAME', 'mvg')
const minZoom = Number(getEnv('MVT_MINZOOM', '0'))
const maxZoom = Number(getEnv('MVT_MAXZOOM', '11'))
const simplification = Number(getEnv('MVT_SIMPLIFICATION', '4'))
const maxSize = Number(getEnv('MVT_MAX_SIZE', '500000'))
const tilesetName = getEnv('MTSV_TILESET_NAME', 'nvis_mvg_vector')

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`
}

const statusFile = resolve(projectRoot, 'build-mbtiles.status.log')
function logLine(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`
  console.log(line)
  try {
    appendFileSync(statusFile, line + '\n')
  } catch {
    /* ignore */
  }
}

async function main() {
  if (!existsSync(inGeojson)) {
    throw new Error(
      `Input GeoJSON not found: ${inGeojson}\n   Run "node scripts/prepare-vector.mjs" first.`
    )
  }
  try {
    writeFileSync(statusFile, '')
  } catch {
    /* ignore */
  }

  const inSize = statSync(inGeojson).size
  console.log('— Build LOCAL vector tiles (GDAL MVT → .mbtiles) ————————————')
  console.log(`   gdal:          ${gdal.version}`)
  console.log(`   input:         ${inGeojson}  (${fmtBytes(inSize)})`)
  console.log(`   output:        ${outMbtiles}`)
  console.log(`   layer:         ${layerName}`)
  console.log(`   zoom:          ${minZoom}–${maxZoom}`)
  console.log(`   simplification:${simplification} px/zoom`)
  console.log(`   max tile size: ${fmtBytes(maxSize)}`)
  console.log('———————————————————————————————————————————————————————————')

  mkdirSync(dirname(outMbtiles), { recursive: true })
  try {
    rmSync(outMbtiles, { force: true })
  } catch {
    /* ignore */
  }

  // Progress: MVT tiling reports fractional completion. Log every 5%.
  const start = Date.now()
  let last = -1
  const progress = (complete) => {
    const pct = Math.floor(complete * 100)
    if (pct !== last && (pct % 5 === 0 || pct === 100) && pct !== 0) {
      last = pct
      const el = (Date.now() - start) / 1000
      const eta = complete > 0 ? el / complete - el : 0
      const mmss = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`
      logLine(
        `tiling: ${String(pct).padStart(3)}%  elapsed ${mmss(el)}` +
          (pct < 100 ? `  eta ~${mmss(eta)}` : '  ✅')
      )
    }
  }

  logLine(`🧩 Tiling ${layerName} z${minZoom}–${maxZoom} → MVT/.mbtiles…`)
  const args = [
    '-f', 'MVT',
    '-nln', layerName,
    '-dsco', `MINZOOM=${minZoom}`,
    '-dsco', `MAXZOOM=${maxZoom}`,
    '-dsco', 'FORMAT=MBTILES',
    '-dsco', `NAME=${tilesetName}`,
    '-dsco', `DESCRIPTION=${tilesetName}`,
    '-dsco', `SIMPLIFICATION=${simplification}`,
    '-dsco', `MAX_SIZE=${maxSize}`,
    '-dsco', 'COMPRESS=YES',
    '-dsco', 'TYPE=overlay'
  ]

  await gdal.vectorTranslateAsync(outMbtiles, gdal.open(inGeojson), args, { progress_cb: progress })

  const size = statSync(outMbtiles).size
  logLine('🎉 Local vector tileset ready.')
  logLine(`   file:  ${outMbtiles}`)
  logLine(`   size:  ${fmtBytes(size)}  (from ${fmtBytes(inSize)} of GeoJSON)`)
  logLine('DONE — next: node scripts/upload-vector-to-mts.mjs (Uploads API)')
}

main().catch((err) => {
  logLine(`❌ ${err.message}`)
  process.exit(1)
})

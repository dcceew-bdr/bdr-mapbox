#!/usr/bin/env node
// -----------------------------------------------------------------------------
//  Make a THINNED "overview" GeoJSONSeq from the detailed one by dropping
//  polygons whose area is too small to matter at low zoom. This is the GDAL-only
//  substitute for tippecanoe's per-zoom "drop-densest": fewer features per tile
//  => low-zoom (z0-8) tiles fit under Mapbox's 500 KB/tile limit.
//
//  The input GeoJSONSeq is EPSG:4326, so OGR_GEOM_AREA is in SQUARE DEGREES.
//  At ~-26° latitude, 1 deg² ≈ 11,130 km², so:
//     10 km² ≈ 0.00090 deg²      20 km² ≈ 0.00180 deg²      5 km² ≈ 0.00045 deg²
//
//  Usage:
//    node scripts/make-overview.mjs [--min-km2 10] [--in <path>] [--out <path>]
//
//  Reads defaults from .env: PREPV_GEOJSON (input), OVERVIEW_GEOJSON (output).
// -----------------------------------------------------------------------------

import { existsSync, statSync, rmSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { loadEnv, getEnv, projectRoot } from './lib/env.mjs'
import gdal from 'gdal-async'

loadEnv()

const argv = process.argv.slice(2)
const getArg = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const resolvePath = (p) => (isAbsolute(p) ? p : resolve(projectRoot, p))

const DEFAULT_DIR = '../NVIS_V7_30m/NVIS_V7_30m_Revised'
const inPath = resolvePath(getArg('in', getEnv('PREPV_GEOJSON', `${DEFAULT_DIR}/nvis_mvg_vector_90m.geojsonl`)))
const outPath = resolvePath(getArg('out', getEnv('OVERVIEW_GEOJSON', `${DEFAULT_DIR}/nvis_mvg_overview.geojsonl`)))
const minKm2 = Number(getArg('min-km2', getEnv('OVERVIEW_MIN_KM2', '10')))

// deg² per km² near -26° latitude (approx). 1 deg lat ≈ 110.57 km,
// 1 deg lon ≈ 111.32*cos(26°) ≈ 100.0 km → 1 deg² ≈ 11,057 km².
const KM2_PER_DEG2 = 110.57 * (111.32 * Math.cos((26 * Math.PI) / 180))
const minAreaDeg2 = minKm2 / KM2_PER_DEG2

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`
}

async function main() {
  if (!existsSync(inPath)) throw new Error(`Input not found: ${inPath}`)
  const inSize = statSync(inPath).size
  console.log('— Make overview (area-thin) ————————————————————————————————')
  console.log(`   in:       ${inPath}  (${fmtBytes(inSize)})`)
  console.log(`   out:      ${outPath}`)
  console.log(`   min area: ${minKm2} km²  ≈ ${minAreaDeg2.toExponential(3)} deg²`)
  console.log('———————————————————————————————————————————————————————————')

  try { rmSync(outPath, { force: true }) } catch { /* ignore */ }

  const args = [
    '-f', 'GeoJSONSeq',
    '-nlt', 'PROMOTE_TO_MULTI',
    '-lco', 'RS=NO',
    '-where', `OGR_GEOM_AREA > ${minAreaDeg2}`
  ]

  const start = Date.now()
  const ticker = setInterval(() => {
    let mb = 0
    try { mb = statSync(outPath).size / 1048576 } catch { /* not yet */ }
    const el = (Date.now() - start) / 1000
    console.log(`   writing: ${mb.toFixed(0)} MB  (elapsed ${Math.floor(el / 60)}m${String(Math.round(el % 60)).padStart(2, '0')}s)`)
  }, 3000)
  try {
    await gdal.vectorTranslateAsync(outPath, gdal.open(inPath), args)
  } finally {
    clearInterval(ticker)
  }

  let written = -1
  try {
    const ds = gdal.open(outPath)
    written = ds.layers.get(0).features.count()
    ds.close()
  } catch { /* ignore */ }

  const outSize = statSync(outPath).size
  console.log('🎉 Overview ready.')
  console.log(`   file:     ${outPath}`)
  console.log(`   size:     ${fmtBytes(outSize)}  (from ${fmtBytes(inSize)})`)
  console.log(`   features: ${written.toLocaleString()}`)
}

main().catch((e) => {
  console.error('\n❌', e.message)
  process.exit(1)
})

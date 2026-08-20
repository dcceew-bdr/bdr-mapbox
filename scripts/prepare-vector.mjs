#!/usr/bin/env node
// -----------------------------------------------------------------------------
//  Prepare a VECTOR source for Mapbox Tiling Service from the single-band
//  categorical NVIS MVG GeoTIFF, entirely via gdal-async (no tippecanoe).
//
//  Pipeline:
//    1. Warp the categorical raster to EPSG:3857 at PREPV_TARGET_RES metres
//       (nearest-neighbour — NEVER interpolate class codes), preserving the
//       255 nodata value.
//    2. SIEVE: merge speck clusters smaller than PREPV_SIEVE_AREA_KM2 into their
//       largest neighbour (GDALSieveFilter, 8-connected). This is the biggest
//       lever on output/tile size — it deletes salt-and-pepper noise BEFORE we
//       trace outlines around each colour.
//    3. POLYGONISE (GDALPolygonize) into features carrying a single integer
//       property `mvg` (the class code). The raster's nodata mask keeps the
//       ocean / outside-Australia area from becoming polygons.
//    4. SIMPLIFY each polygon (Douglas-Peucker, PREPV_SIMPLIFY_M metres) to strip
//       pixel stair-step vertices, then reproject to EPSG:4326.
//    5. Drop any class in PREPV_DROP_CLASSES (default 99 = no-data/unknown) and
//       stream the rest to a line-delimited GeoJSON (.geojsonl) for MTS upload.
//
//  Only the `mvg` id is stored — the Mapbox client looks up name + colour
//  locally from src/data/nvisMvgLegend.js.
//
//  Usage:   npm run vec:prepare   (or: node scripts/prepare-vector.mjs)
//  Output:  the file referenced by PREPV_GEOJSON in .env
// -----------------------------------------------------------------------------

import { existsSync, mkdirSync, rmSync, statSync, appendFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { loadEnv, getEnv, projectRoot } from './lib/env.mjs'
import gdal from 'gdal-async'

loadEnv()

// --- Config -----------------------------------------------------------------
function resolvePath(p) {
  return isAbsolute(p) ? p : resolve(projectRoot, p)
}

const DEFAULT_DIR = '../NVIS_V7_30m/NVIS_V7_30m_Revised'
const inputTif = resolvePath(getEnv('PREP_INPUT_TIF', `${DEFAULT_DIR}/NVIS7_0_AUST_EX_MVG.tif`))
const outGeojson = resolvePath(getEnv('PREPV_GEOJSON', `${DEFAULT_DIR}/nvis_mvg_vector.geojsonl`))
const targetSrs = getEnv('PREP_TARGET_SRS', 'EPSG:3857')
const targetRes = Number(getEnv('PREPV_TARGET_RES', '60'))
const sieveAreaKm2 = Number(getEnv('PREPV_SIEVE_AREA_KM2', '0.02'))
const simplifyM = Number(getEnv('PREPV_SIMPLIFY_M', '60'))
const dropClasses = new Set(
  String(getEnv('PREPV_DROP_CLASSES', '99'))
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Number.isFinite)
)
const NODATA = 255

if (!Number.isFinite(targetRes) || targetRes <= 0) {
  throw new Error(`PREPV_TARGET_RES must be a positive number (got "${getEnv('PREPV_TARGET_RES', '')}").`)
}
if (!Number.isFinite(sieveAreaKm2) || sieveAreaKm2 < 0) {
  throw new Error(`PREPV_SIEVE_AREA_KM2 must be a non-negative number.`)
}

// --- Helpers ----------------------------------------------------------------
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

// Status file written with UNBUFFERED appends so progress is visible live even
// when stdout is block-buffered by a pipe or the process runs in the background.
const statusFile = resolve(projectRoot, 'prepare-vector.status.log')
function logLine(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`
  console.log(line)
  try {
    appendFileSync(statusFile, line + '\n')
  } catch {
    /* ignore */
  }
}

// --- Main -------------------------------------------------------------------
async function main() {
  if (!existsSync(inputTif)) throw new Error(`Input GeoTIFF not found: ${inputTif}`)

  // Fresh status file each run.
  try {
    writeFileSync(statusFile, '')
  } catch {
    /* ignore */
  }

  // Sieve threshold in PIXELS derived from the requested real-world area, so the
  // cleaning strength is consistent regardless of working resolution.
  const pixelAreaM2 = targetRes * targetRes
  const sieveThresholdPx = Math.max(1, Math.round((sieveAreaKm2 * 1e6) / pixelAreaM2))

  // Guard: a threshold of 1 px means the sieve removes NOTHING (you can't have a
  // cluster smaller than one pixel). That silently produces tens of millions of
  // speck features. Warn loudly with a concrete fix.
  if (sieveThresholdPx <= 1) {
    const suggestKm2 = (7 * pixelAreaM2) / 1e6 // ~7 px = a balanced clean
    console.warn(
      `\n⚠️  Sieve is effectively DISABLED: PREPV_SIEVE_AREA_KM2=${sieveAreaKm2} km² ` +
        `maps to only ${sieveThresholdPx} px at ${targetRes} m (pixel = ${(pixelAreaM2 / 1e6).toFixed(4)} km²).\n` +
        `    Nothing will be despeckled → expect a huge feature count.\n` +
        `    Raise PREPV_SIEVE_AREA_KM2 to at least ~${suggestKm2.toFixed(3)} km² for a real clean.\n`
    )
  }

  console.log('— Prepare NVIS → VECTOR source (GeoJSONSeq) ————————————————')
  console.log(`   gdal:      ${gdal.version}`)
  console.log(`   input:     ${inputTif}`)
  console.log(`   output:    ${outGeojson}`)
  console.log(`   target:    ${targetSrs} @ ${targetRes} m/px`)
  console.log(`   sieve:     ${sieveAreaKm2} km² → ${sieveThresholdPx} px (8-connected)`)
  console.log(`   simplify:  ${simplifyM} m`)
  console.log(`   drop:      classes [${[...dropClasses].join(', ') || 'none'}]`)
  console.log('———————————————————————————————————————————————————————————')

  mkdirSync(dirname(outGeojson), { recursive: true })
  const tmpTif = resolve(dirname(outGeojson), 'nvis_cat_3857.tmp.tif')

  // 1. Warp categorical band to target CRS + resolution (nearest keeps codes).
  console.log(`🌐 Warping to ${targetSrs} @ ${targetRes} m (nearest)…`)
  const srcDs = gdal.open(inputTif)
  const warped = gdal.warp(tmpTif, null, [srcDs], [
    '-overwrite',
    '-t_srs', targetSrs,
    '-tr', String(targetRes), String(targetRes),
    '-r', 'near',
    '-srcnodata', String(NODATA),
    '-dstnodata', String(NODATA),
    '-of', 'GTiff',
    '-co', 'TILED=YES',
    '-co', 'COMPRESS=DEFLATE',
    '-co', 'BIGTIFF=IF_SAFER',
    '-co', 'NUM_THREADS=ALL_CPUS',
    '-multi'
  ])
  const { x: wx, y: wy } = warped.rasterSize
  logLine(`✅ Warped raster: ${wx} × ${wy} px`)
  srcDs.close()
  warped.close()

  // 2. Sieve specks in place.
  logLine(`🧹 Sieving speck clusters < ${sieveThresholdPx} px…`)
  const ds = gdal.open(tmpTif, 'r+')
  const band = ds.bands.get(1)
  await gdal.sieveFilterAsync({ src: band, dst: band, threshold: sieveThresholdPx, connectedness: 8 })
  logLine('✅ Sieve complete.')

  // Progress logger for GDAL algorithms (polygonise/translate). Writes each
  // step to the status file (unbuffered) with elapsed time + ETA so progress is
  // visible even when stdout is buffered or the process runs in the background.
  function progressCb(label, everyPct = 5) {
    const start = Date.now()
    let last = -1
    return (complete) => {
      const pct = Math.floor(complete * 100)
      if (pct !== last && (pct % everyPct === 0 || pct === 100) && pct !== 0) {
        last = pct
        const elapsed = (Date.now() - start) / 1000
        const eta = complete > 0 ? elapsed / complete - elapsed : 0
        const mmss = (s) => `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`
        logLine(
          `${label}: ${String(pct).padStart(3)}%  ` +
            `elapsed ${mmss(elapsed)}${pct < 100 ? `  eta ~${mmss(eta)}` : '  ✅'}`
        )
      }
    }
  }

  // 3. Polygonise the cleaned raster to a GPKG ON DISK (not the Memory driver),
  //    so we never hold millions of continental features in RAM. C++ does the
  //    work; we just watch the progress bar.
  const rawGpkg = resolve(dirname(outGeojson), 'nvis_vec_raw.gpkg')
  try {
    rmSync(rawGpkg, { force: true })
  } catch {
    /* ignore */
  }

  logLine('🔷 Polygonising cleaned raster → GPKG (on disk)…')
  const srs3857 = gdal.SpatialReference.fromUserInput(targetSrs)
  const rawDs = gdal.drivers.get('GPKG').create(rawGpkg, 0, 0, 0)
  const layer = rawDs.layers.create('mvg', srs3857, gdal.Polygon)
  layer.fields.add(new gdal.FieldDefn('mvg', gdal.OFTInteger))
  await gdal.polygonizeAsync({
    src: band,
    dst: layer,
    pixValField: 0,
    connectedness: 8,
    mask: band.getMaskBand(),
    progress_cb: progressCb('polygonising')
  })
  const rawCount = layer.features.count()
  logLine(`✅ Polygonised: ${rawCount.toLocaleString()} raw features.`)
  rawDs.close()
  ds.close()

  // 4. ONE streaming pass: reproject to EPSG:4326 + simplify + drop classes,
  //    writing line-delimited GeoJSON DIRECTLY. This avoids the slow, memory-
  //    heavy intermediate "simplify → GPKG" pass (which held >1 GB RAM and gave
  //    no progress). Because -simplify runs in the TARGET SRS (degrees here), we
  //    convert the metre tolerance to degrees (~111,320 m per degree of lat).
  //    Topology is still preserved (ogr2ogr uses SimplifyPreserveTopology).
  const whereClause =
    dropClasses.size > 0 ? `mvg NOT IN (${[...dropClasses].join(',')})` : ''
  const simplifyDeg = simplifyM > 0 ? simplifyM / 111320 : 0
  logLine(
    `✂️  Simplify (${simplifyM} m ≈ ${simplifyDeg.toFixed(6)}°) + filter + reproject → GeoJSONSeq (streaming)…`
  )
  try {
    rmSync(outGeojson, { force: true })
  } catch {
    /* ignore */
  }
  const oneArgs = [
    '-t_srs', 'EPSG:4326',
    '-f', 'GeoJSONSeq',
    '-nlt', 'PROMOTE_TO_MULTI',
    '-lco', 'RS=NO'
  ]
  if (simplifyDeg > 0) oneArgs.push('-simplify', String(simplifyDeg))
  if (whereClause) oneArgs.push('-where', whereClause)

  // The write is a single GDAL call with no progress hook, but it streams to a
  // growing text file — so poll that file's size every 3 s and log it, giving
  // continuous visible progress (features written scale with bytes on disk).
  const writeStart = Date.now()
  const ticker = setInterval(() => {
    let mb = 0
    try {
      mb = statSync(outGeojson).size / 1048576
    } catch {
      /* not created yet */
    }
    const el = (Date.now() - writeStart) / 1000
    const mmss = `${Math.floor(el / 60)}m${String(Math.round(el % 60)).padStart(2, '0')}s`
    logLine(`   writing GeoJSONSeq: ${mb.toFixed(0)} MB  (elapsed ${mmss})`)
  }, 3000)
  try {
    await gdal.vectorTranslateAsync(outGeojson, gdal.open(rawGpkg), oneArgs)
  } finally {
    clearInterval(ticker)
  }
  logLine('✅ Simplify + filter + reproject + write complete.')

  // Feature count: count lines is O(n); instead reopen the GeoJSONSeq layer.
  let written = 0
  try {
    const outDs = gdal.open(outGeojson)
    written = outDs.layers.get(0).features.count()
    outDs.close()
  } catch {
    written = -1
  }

  // Tidy intermediates.
  for (const f of [tmpTif, rawGpkg]) {
    try {
      rmSync(f, { force: true })
    } catch {
      /* ignore */
    }
  }

  const size = statSync(outGeojson).size
  logLine('🎉 Vector source ready.')
  logLine(`   file:      ${outGeojson}`)
  logLine(`   size:      ${fmtBytes(size)}`)
  logLine(`   features:  ${written.toLocaleString()} written (${rawCount.toLocaleString()} raw before filter/simplify)`)
  logLine('DONE — next: node scripts/build-mbtiles.mjs')
}

main().catch((err) => {
  logLine(`❌ ${err.message}`)
  process.exit(1)
})

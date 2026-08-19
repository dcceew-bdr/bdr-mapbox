#!/usr/bin/env node
// -----------------------------------------------------------------------------
//  Colourise the single-band categorical NVIS GeoTIFF into an 8-bit RGBA
//  Cloud-Optimized GeoTIFF (COG) in Web Mercator (EPSG:3857), ready for upload
//  to Mapbox Tiling Service.
//
//  Why: the raw NVIS7_0_AUST_EX_MVG.tif is a single Byte band of MVG class
//  codes (1..32, 99) with nodata = 255. MTS "type: raster" tilesets expect an
//  8-bit RGB(A) image whose bands are mapped by colorinterp in the recipe, so
//  we must bake the .clr palette into pixels first. This mirrors the GDAL
//  pipeline in the README (gdaldem color-relief -> gdalwarp -> COG) but runs
//  entirely in Node via gdal-async, so no system GDAL install is required.
//
//  Pipeline:
//    1. Parse the .clr palette -> per-channel 0..255 lookup tables (LUTs).
//    2. Write an RGBA VRT that expands the categorical band into 4 bands
//       (Red/Green/Blue/Alpha) using <ComplexSource><LUT> (no color table or
//       gdaldem needed). nodata (255) and any unlisted value -> alpha 0.
//    3. warp the VRT to EPSG:3857 (nearest, to keep class edges crisp),
//       optionally downsampling to PREP_TARGET_RES metres.
//    4. translate the warped result to a COG (DEFLATE, 512 tiles, overviews).
//
//  Usage:   npm run mts:prepare
//  Output:  the file referenced by MTS_GEOTIFF in .env
// -----------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
const clrPath = resolvePath(getEnv('PREP_CLR', `${DEFAULT_DIR}/NVIS7_0_AUST_EX_MVG.clr`))
const outputCog = resolvePath(getEnv('MTS_GEOTIFF', `${DEFAULT_DIR}/nvis_rgba_cog.tif`))
const targetSrs = getEnv('PREP_TARGET_SRS', 'EPSG:3857')
// Target resolution in TARGET_SRS units (metres for 3857). "0", "native" or ""
// keeps the warp's native resolution. 150 m is ~4x finer than zoom 8 needs and
// keeps the file small + fast to process for a continental POC.
const targetResRaw = getEnv('PREP_TARGET_RES', '150').trim().toLowerCase()
const targetRes = targetResRaw === '' || targetResRaw === 'native' ? 0 : Number(targetResRaw)

if (!Number.isFinite(targetRes) || targetRes < 0) {
  throw new Error(`PREP_TARGET_RES must be a non-negative number, "native", or empty (got "${targetResRaw}").`)
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

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Parse a GDAL .clr colour file -> Map<classCode, [r, g, b]>. */
function parsePalette(file) {
  const text = readFileSync(file, 'utf8')
  const map = new Map()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/[\s,]+/).map(Number)
    const [code, r, g, b] = parts
    if (![code, r, g, b].every(Number.isFinite)) continue
    if (code < 0 || code > 255) continue
    map.set(code, [r & 255, g & 255, b & 255])
  }
  return map
}

/** Build a "0:out0,1:out1,...,255:out255" LUT string for one channel. */
function lut(valueFor) {
  const parts = new Array(256)
  for (let v = 0; v < 256; v++) parts[v] = `${v}:${valueFor(v)}`
  return parts.join(',')
}

// --- Main -------------------------------------------------------------------
function main() {
  if (!existsSync(inputTif)) throw new Error(`Input GeoTIFF not found: ${inputTif}`)
  if (!existsSync(clrPath)) throw new Error(`Palette (.clr) not found: ${clrPath}`)

  console.log('— Prepare NVIS GeoTIFF → RGBA COG ————————————————————————')
  console.log(`   gdal:    ${gdal.version}`)
  console.log(`   input:   ${inputTif}`)
  console.log(`   palette: ${clrPath}`)
  console.log(`   output:  ${outputCog}`)
  console.log(`   target:  ${targetSrs}${targetRes ? ` @ ${targetRes} m/px` : ' (native res)'}`)
  console.log('———————————————————————————————————————————————————————————')

  const palette = parsePalette(clrPath)
  console.log(`🎨 Parsed ${palette.size} palette entries (classes ${[...palette.keys()].sort((a, b) => a - b).join(', ')}).`)

  // 1. Inspect the source so the VRT carries correct georeferencing.
  const src = gdal.open(inputTif)
  const band = src.bands.get(1)
  const { x: xSize, y: ySize } = src.rasterSize
  const block = band.blockSize
  const gt = src.geoTransform
  let srsText = `${'EPSG'}:9473`
  try {
    if (src.srs) srsText = src.srs.toWKT()
  } catch {
    /* fall back to authority string */
  }
  src.close()

  // 2. Build the RGBA LUTs. Listed classes -> their colour, alpha 255.
  //    Everything else (incl. nodata 255 and 0) -> transparent black.
  const channel = (i) => (v) => (palette.has(v) ? palette.get(v)[i] : 0)
  const alpha = (v) => (palette.has(v) ? 255 : 0)
  const luts = [lut(channel(0)), lut(channel(1)), lut(channel(2)), lut(alpha)]
  const interps = ['Red', 'Green', 'Blue', 'Alpha']

  // 3. Write the RGBA VRT.
  const srcForVrt = inputTif.replace(/\\/g, '/')
  const bandXml = interps
    .map(
      (interp, i) => `  <VRTRasterBand dataType="Byte" band="${i + 1}">
    <ColorInterp>${interp}</ColorInterp>
    <ComplexSource>
      <SourceFilename relativeToVRT="0">${xmlEscape(srcForVrt)}</SourceFilename>
      <SourceBand>1</SourceBand>
      <SourceProperties RasterXSize="${xSize}" RasterYSize="${ySize}" DataType="Byte" BlockXSize="${block.x}" BlockYSize="${block.y}"/>
      <SrcRect xOff="0" yOff="0" xSize="${xSize}" ySize="${ySize}"/>
      <DstRect xOff="0" yOff="0" xSize="${xSize}" ySize="${ySize}"/>
      <LUT>${luts[i]}</LUT>
    </ComplexSource>
  </VRTRasterBand>`
    )
    .join('\n')

  const vrtXml = `<VRTDataset rasterXSize="${xSize}" rasterYSize="${ySize}">
  <SRS>${xmlEscape(srsText)}</SRS>
  <GeoTransform>${gt.map((n) => n.toString()).join(', ')}</GeoTransform>
${bandXml}
</VRTDataset>
`

  mkdirSync(dirname(outputCog), { recursive: true })
  const vrtPath = resolve(dirname(outputCog), 'nvis_rgba.vrt')
  const tmpTif = resolve(dirname(outputCog), 'nvis_rgba_3857.tmp.tif')
  writeFileSync(vrtPath, vrtXml)
  console.log(`📝 Wrote RGBA VRT: ${vrtPath}`)

  // 4. warp VRT -> temp GTiff in the target CRS (nearest keeps classes crisp).
  console.log('🌐 Reprojecting + colourising (warp)…')
  const warpArgs = [
    '-overwrite',
    '-t_srs', targetSrs,
    '-r', 'near',
    '-of', 'GTiff',
    '-co', 'TILED=YES',
    '-co', 'COMPRESS=DEFLATE',
    '-co', 'BIGTIFF=IF_SAFER',
    '-co', 'NUM_THREADS=ALL_CPUS',
    '-multi',
    '-wo', 'NUM_THREADS=ALL_CPUS',
    '-wo', 'INIT_DEST=0'
  ]
  if (targetRes > 0) warpArgs.push('-tr', String(targetRes), String(targetRes))

  const vrtDs = gdal.open(vrtPath)
  const warped = gdal.warp(tmpTif, null, [vrtDs], warpArgs)
  const warpedSize = warped.rasterSize
  warped.close()
  vrtDs.close()
  console.log(`   ✅ Warped raster: ${warpedSize.x} × ${warpedSize.y} px`)

  // 5. translate temp -> COG (overviews resampled nearest for categorical data).
  console.log('🧱 Writing Cloud-Optimized GeoTIFF…')
  const cogArgs = [
    '-of', 'COG',
    '-co', 'COMPRESS=DEFLATE',
    '-co', 'BLOCKSIZE=512',
    '-co', 'OVERVIEWS=AUTO',
    '-co', 'RESAMPLING=NEAREST',
    '-co', 'NUM_THREADS=ALL_CPUS'
  ]
  const tmpDs = gdal.open(tmpTif)
  const cog = gdal.translate(outputCog, tmpDs, cogArgs)
  cog.close()
  tmpDs.close()

  // 6. Tidy up intermediates.
  try {
    rmSync(tmpTif, { force: true })
  } catch {
    /* ignore */
  }

  const size = statSync(outputCog).size
  console.log(`\n🎉 Done. RGBA COG ready (${fmtBytes(size)}):`)
  console.log(`   ${outputCog}\n`)
  console.log('Next: ensure MTS_GEOTIFF in .env points here, then run `npm run mts:upload`.')
}

try {
  main()
} catch (err) {
  console.error('\n❌', err.message)
  process.exit(1)
}

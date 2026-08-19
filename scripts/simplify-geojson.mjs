#!/usr/bin/env node
// -----------------------------------------------------------------------------
//  Pre-simplify a GeoJSONSeq's geometry (Douglas-Peucker, topology-preserving)
//  to cut VERTEX count before tiling. GDAL's MVT writer is slow on vertex-heavy
//  polygons; generalising up front makes the z0-8 overview build fast.
//
//  Usage:
//    node scripts/simplify-geojson.mjs --in <path> --out <path> [--tol-m 250]
// -----------------------------------------------------------------------------

import { statSync, rmSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { projectRoot } from './lib/env.mjs'
import gdal from 'gdal-async'

const argv = process.argv.slice(2)
const getArg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const rp = (p) => (isAbsolute(p) ? p : resolve(projectRoot, p))

const DIR = '../NVIS_V7_30m/NVIS_V7_30m_Revised'
const inP = rp(getArg('in', `${DIR}/nvis_mvg_overview.geojsonl`))
const outP = rp(getArg('out', `${DIR}/nvis_mvg_overview_s250.geojsonl`))
const tolM = Number(getArg('tol-m', '250'))
const tolDeg = tolM / 111320

const mb = (n) => `${Math.round(n / 1048576)} MB`

console.log('— Pre-simplify GeoJSON —————————————————————————————————————')
console.log(`   in:   ${inP}  (${mb(statSync(inP).size)})`)
console.log(`   out:  ${outP}`)
console.log(`   tol:  ${tolM} m  ≈ ${tolDeg.toExponential(3)}°`)

try { rmSync(outP, { force: true }) } catch { /* ignore */ }

const start = Date.now()
const out = gdal.vectorTranslate(outP, gdal.open(inP), [
  '-f', 'GeoJSONSeq',
  '-nlt', 'PROMOTE_TO_MULTI',
  '-lco', 'RS=NO',
  '-simplify', String(tolDeg)
])
out.close()

let n = -1
try {
  const o = gdal.open(outP)
  n = o.layers.get(0).features.count()
  o.close()
} catch { /* ignore */ }

const el = Math.round((Date.now() - start) / 1000)
console.log(`✅ done in ${el}s — ${n.toLocaleString()} features, ${mb(statSync(outP).size)} (was ${mb(statSync(inP).size)})`)

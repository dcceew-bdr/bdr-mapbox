#!/usr/bin/env node
// -----------------------------------------------------------------------------
//  Upload + publish the NVIS MVG VECTOR source to Mapbox Tiling Service (MTS).
//  Mirrors upload-to-mts.mjs but uses SEPARATE ids so the existing raster
//  tileset (nvis_mvg) is never touched.
//
//  Recipe: one layer `mvg`, minzoom 0 / maxzoom 11. Adjacent same-class polygons
//  are unioned to shrink tiles; tiny features are dropped at low zoom to respect
//  Mapbox's per-tile size budget.
//
//  Usage:
//    node scripts/upload-vector-to-mts.mjs              # full pipeline
//    node scripts/upload-vector-to-mts.mjs --status-only
//    node scripts/upload-vector-to-mts.mjs --skip-source
// -----------------------------------------------------------------------------

import { openAsBlob, existsSync, writeFileSync, statSync, createReadStream, createWriteStream } from 'node:fs'
import { basename, resolve, isAbsolute } from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { loadEnv, requireEnv, getEnv, projectRoot } from './lib/env.mjs'
import { mapboxFetch } from './lib/mapbox.mjs'

loadEnv()

const statusOnly = process.argv.includes('--status-only')
const skipSource = process.argv.includes('--skip-source')

let username, token
try {
  username = requireEnv('MAPBOX_USERNAME')
  token = requireEnv('MAPBOX_SECRET_TOKEN')
} catch (err) {
  console.error('\n❌', err.message)
  process.exit(1)
}

const sourceId = getEnv('MTSV_SOURCE_ID', 'nvis_mvg_vec_src')
const tilesetName = getEnv('MTSV_TILESET_NAME', 'nvis_mvg_vector')
const minzoom = Number(getEnv('MTSV_MINZOOM', '0'))
const maxzoom = Number(getEnv('MTSV_MAXZOOM', '11'))
const tilesetId = `${username}.${tilesetName}`

function resolveGeojsonPath() {
  const raw = getEnv('PREPV_GEOJSON', '')
  if (!raw) return ''
  return isAbsolute(raw) ? raw : resolve(projectRoot, raw)
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- Vector recipe ----------------------------------------------------------
// One layer "mvg". `union` coalesces adjacent same-class polygons (huge tile
// savings). Zoom-dependent simplification + dropping tiny features keeps low
// zooms under Mapbox's per-tile byte budget.
function buildRecipe() {
  return {
    version: 1,
    layers: {
      mvg: {
        source: `mapbox://tileset-source/${username}/${sourceId}`,
        minzoom,
        maxzoom,
        features: {
          attributes: {
            allowed_output: ['mvg']
          }
        },
        tiles: {
          // Merge neighbouring polygons that share the same mvg code.
          union: [
            {
              group_by: ['mvg'],
              maintain_direction: false,
              simplification: ['case', ['<', ['zoom'], 6], 8, 4]
            }
          ],
          // At low zoom, remove features whose on-screen area is tiny.
          remove_small_polygons: ['case', ['<', ['zoom'], 6], 16, 4],
          limit: [['tile', 2500, 'drop_densest_as_needed']]
        }
      }
    }
  }
}

// --- Pipeline steps ---------------------------------------------------------
async function createSource() {
  const filePath = resolveGeojsonPath()
  if (!filePath || !existsSync(filePath)) {
    throw new Error(
      `Vector GeoJSON not found at PREPV_GEOJSON="${getEnv('PREPV_GEOJSON', '')}".\n` +
        '   Run `node scripts/prepare-vector.mjs` first.'
    )
  }

  console.log(`📤 Uploading vector source "${sourceId}" from ${basename(filePath)} …`)
  console.log('   (large files can take a while; there is no progress bar while it uploads)')

  // NOTE: MTS REJECTS gzipped sources (415 "must not be gzip compressed"), so
  // gzip is OFF by default. It only helps if you're staging the file elsewhere.
  // The RAW .geojsonl must itself be under any gateway limit — simplify harder
  // (PREPV_SIMPLIFY_M) if it's too big, rather than relying on compression.
  let uploadPath = filePath
  const useGzip = getEnv('MTSV_GZIP', 'false') === 'true'
  if (useGzip && !filePath.endsWith('.gz')) {
    const gzPath = filePath + '.gz'
    const src = statSync(filePath).size
    console.log(`   🗜️  Gzipping ${fmtBytes(src)} → ${basename(gzPath)} …`)
    await pipeline(
      createReadStream(filePath),
      createGzip({ level: 6 }),
      createWriteStream(gzPath)
    )
    const gz = statSync(gzPath).size
    console.log(`   ✅ Gzipped: ${fmtBytes(src)} → ${fmtBytes(gz)} (${(gz / src * 100).toFixed(0)}%).`)
    uploadPath = gzPath
  }

  const blob = await openAsBlob(uploadPath)
  const form = new FormData()
  form.append('file', blob, basename(uploadPath))

  const res = await mapboxFetch(`/tilesets/v1/sources/${username}/${sourceId}`, {
    token,
    method: 'POST',
    body: form
  })
  const localSize = statSync(uploadPath).size
  console.log(
    `   ✅ Source ready: ${res.id} ` +
      `(uploaded ${fmtBytes(localSize)} → ${fmtBytes(res.source_size)} on Mapbox)`
  )
  return res
}

async function deleteSource() {
  console.log(`🗑️  Deleting existing vector source "${sourceId}" (fresh upload)…`)
  try {
    await mapboxFetch(`/tilesets/v1/sources/${username}/${sourceId}`, { token, method: 'DELETE' })
    console.log('   ✅ Source deleted (or already gone).')
  } catch (err) {
    if (err.status === 404) console.log('   ℹ️  No existing source.')
    else throw err
  }
}

async function validateRecipe(recipe) {
  console.log('🧪 Validating recipe …')
  const res = await mapboxFetch('/tilesets/v1/validateRecipe', {
    token,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(recipe)
  })
  if (!res.valid) throw new Error(`Recipe invalid: ${JSON.stringify(res.errors)}`)
  console.log('   ✅ Recipe is valid.')
}

async function createOrUpdateTileset(recipe) {
  console.log(`🧱 Creating tileset "${tilesetId}" …`)
  try {
    await mapboxFetch(`/tilesets/v1/${tilesetId}`, {
      token,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipe,
        name: tilesetName.slice(0, 64),
        description: 'NVIS v7.0 Major Vegetation Groups — vector (POC)',
        attribution: [{ text: '© DCCEEW — NVIS', link: '' }]
      })
    })
    console.log('   ✅ Tileset created.')
  } catch (err) {
    if (err.status === 400 && /already exists/i.test(err.message)) {
      console.log('   ℹ️  Tileset already exists — updating its recipe instead.')
      await mapboxFetch(`/tilesets/v1/${tilesetId}/recipe`, {
        token,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recipe)
      })
      console.log('   ✅ Recipe updated.')
    } else {
      throw err
    }
  }
}

async function publish() {
  console.log('🚀 Publishing tileset …')
  const res = await mapboxFetch(`/tilesets/v1/${tilesetId}/publish`, { token, method: 'POST' })
  console.log(`   ✅ Publish job queued: ${res.jobId}`)
  return res.jobId
}

async function pollJob(jobId) {
  console.log('⏳ Processing…')
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let i = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await mapboxFetch(`/tilesets/v1/${tilesetId}/jobs/${jobId}`, { token })
    process.stdout.write(`\r   ${spinner[i++ % spinner.length]} stage: ${job.stage}        `)
    if (job.stage === 'success') {
      process.stdout.write('\n')
      console.log('   ✅ Tiles published successfully.')
      if (job.warnings?.length) console.log('   ⚠️  warnings:', job.warnings)
      return job
    }
    if (job.stage === 'failed') {
      process.stdout.write('\n')
      throw new Error(`Publish job failed: ${JSON.stringify(job.errors)}`)
    }
    await sleep(5000)
  }
}

async function printLatestStatus() {
  console.log(`🔎 Latest job for ${tilesetId}:`)
  const jobs = await mapboxFetch(`/tilesets/v1/${tilesetId}/jobs`, { token, query: { limit: 1 } })
  if (!jobs.length) {
    console.log('   No jobs found yet.')
    return
  }
  const job = jobs[0]
  console.log(`   stage:    ${job.stage}`)
  console.log(`   created:  ${job.created_nice ?? job.created}`)
  if (job.errors?.length) console.log('   errors:  ', job.errors)
  if (job.warnings?.length) console.log('   warnings:', job.warnings)
}

// --- Main -------------------------------------------------------------------
async function main() {
  if (!Number.isInteger(minzoom) || !Number.isInteger(maxzoom) || minzoom < 0 || maxzoom > 16 || minzoom > maxzoom) {
    throw new Error(`Invalid zoom range: minzoom=${minzoom}, maxzoom=${maxzoom}.`)
  }

  if (statusOnly) {
    await printLatestStatus()
    return
  }

  console.log('— Mapbox Tiling Service upload (VECTOR) ————————————————————')
  console.log(`   account:  ${username}`)
  console.log(`   tileset:  ${tilesetId}`)
  console.log(`   zoom:     ${minzoom}–${maxzoom}`)
  console.log('———————————————————————————————————————————————————————————')

  const recipe = buildRecipe()
  const recipePath = resolve(projectRoot, 'recipe.vector.generated.json')
  writeFileSync(recipePath, JSON.stringify(recipe, null, 2))
  console.log(`📝 Wrote recipe to ${recipePath}`)

  if (!skipSource) {
    await deleteSource()
    await createSource()
  } else {
    console.log('⏭️  Skipping source upload (--skip-source).')
  }

  await validateRecipe(recipe)
  await createOrUpdateTileset(recipe)
  const jobId = await publish()
  await pollJob(jobId)

  console.log('\n🎉 Done! Vector tileset published:\n')
  console.log(`   ${tilesetId}\n`)
}

main().catch((err) => {
  console.error('\n❌', err.message)
  if (err.status === 401 || err.status === 403) {
    console.error('   MAPBOX_SECRET_TOKEN needs scopes: tilesets:write, tilesets:read, tilesets:list.')
  }
  process.exit(1)
})

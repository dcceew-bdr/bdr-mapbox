#!/usr/bin/env node
// -----------------------------------------------------------------------------
//  Upload + publish the NVIS RGB GeoTIFF to Mapbox Tiling Service (MTS).
//
//  Pipeline (all via the MTS REST API):
//    1. Create a tileset SOURCE from the GeoTIFF      (POST /tilesets/v1/sources)
//    2. Validate the raster RECIPE                    (PUT  /tilesets/v1/validateRecipe)
//    3. Create the TILESET (or update its recipe)     (POST /tilesets/v1/{id})
//    4. PUBLISH the tileset                           (POST /tilesets/v1/{id}/publish)
//    5. Poll the JOB until it succeeds or fails       (GET  /tilesets/v1/{id}/jobs/{job})
//
//  Docs: https://docs.mapbox.com/api/maps/mapbox-tiling-service/
//        https://docs.mapbox.com/mapbox-tiling-service/recipe-specification/raster/
//
//  Usage:
//    npm run mts:upload            # run the full pipeline
//    npm run mts:status            # just print the latest publish-job status
//
//  IMPORTANT: type:"raster" needs an 8-bit RGB(A) GeoTIFF. The raw NVIS file is
//  single-band categorical data, so colourise it first with `npm run mts:prepare`
//  (produces a transparent-nodata RGBA COG in EPSG:3857).
// -----------------------------------------------------------------------------

import { openAsBlob, existsSync, writeFileSync, statSync } from 'node:fs'
import { basename, resolve, isAbsolute } from 'node:path'
import { loadEnv, requireEnv, getEnv, projectRoot } from './lib/env.mjs'
import { mapboxFetch } from './lib/mapbox.mjs'

loadEnv()

const statusOnly = process.argv.includes('--status-only')
const skipSource = process.argv.includes('--skip-source')

// --- Configuration ----------------------------------------------------------
let username, token
try {
  username = requireEnv('MAPBOX_USERNAME')
  token = requireEnv('MAPBOX_SECRET_TOKEN')
} catch (err) {
  console.error('\n❌', err.message)
  console.error('   Paste your Mapbox username + secret token (sk., scopes')
  console.error('   tilesets:write/read/list) into mapbox-poc/.env, then re-run.')
  process.exit(1)
}
const sourceId = getEnv('MTS_SOURCE_ID', 'nvis_mvg_src')
const tilesetName = getEnv('MTS_TILESET_NAME', 'nvis_mvg')
const minzoom = Number(getEnv('MTS_MINZOOM', '0'))
const maxzoom = Number(getEnv('MTS_MAXZOOM', '8'))

const tilesetId = `${username}.${tilesetName}`

function resolveGeotiffPath() {
  const raw = getEnv('MTS_GEOTIFF', '')
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

// --- The raster recipe ------------------------------------------------------
// For a 4-band RGBA GeoTIFF, MTS maps the red/green/blue/alpha bands by
// colorinterp. The alpha band makes the NVIS nodata (ocean / outside Australia)
// transparent so the base map shows through. See `npm run mts:prepare`.
function buildRecipe() {
  return {
    version: 1,
    type: 'raster',
    sources: [{ uri: `mapbox://tileset-source/${username}/${sourceId}` }],
    minzoom,
    maxzoom,
    layers: {
      RGBA: {
        source_rules: {
          filter: [
            ['==', ['get', 'colorinterp'], 'red'],
            ['==', ['get', 'colorinterp'], 'green'],
            ['==', ['get', 'colorinterp'], 'blue'],
            ['==', ['get', 'colorinterp'], 'alpha']
          ]
        }
      }
    }
  }
}

// --- Pipeline steps ---------------------------------------------------------
async function createSource() {
  const filePath = resolveGeotiffPath()
  if (!filePath || !existsSync(filePath)) {
    throw new Error(
      `GeoTIFF not found at MTS_GEOTIFF="${getEnv('MTS_GEOTIFF', '')}".\n` +
        '   Set it to your RGB GeoTIFF (see README step 3 – Prepare the GeoTIFF).'
    )
  }

  console.log(`📤 Uploading source "${sourceId}" from ${basename(filePath)} …`)
  console.log('   (large files can take a while; there is no progress bar while it uploads)')

  const blob = await openAsBlob(filePath)
  const form = new FormData()
  form.append('file', blob, basename(filePath))

  const res = await mapboxFetch(`/tilesets/v1/sources/${username}/${sourceId}`, {
    token,
    method: 'POST',
    body: form
  })
  const localSize = statSync(filePath).size
  console.log(
    `   ✅ Source ready: ${res.id} ` +
      `(uploaded ${fmtBytes(localSize)} compressed → ${fmtBytes(res.source_size)} on Mapbox)`
  )
  return res
}

async function validateRecipe(recipe) {
  console.log('🧪 Validating recipe …')
  const res = await mapboxFetch('/tilesets/v1/validateRecipe', {
    token,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(recipe)
  })
  if (!res.valid) {
    throw new Error(`Recipe invalid: ${JSON.stringify(res.errors)}`)
  }
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
        description: 'NVIS v7.0 Major Vegetation Groups (30 m) — POC',
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
  const res = await mapboxFetch(`/tilesets/v1/${tilesetId}/publish`, {
    token,
    method: 'POST'
  })
  console.log(`   ✅ Publish job queued: ${res.jobId}`)
  return res.jobId
}

async function pollJob(jobId) {
  console.log('⏳ Processing (this can take several minutes for large rasters)…')
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  let i = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await mapboxFetch(`/tilesets/v1/${tilesetId}/jobs/${jobId}`, { token })
    const stage = job.stage
    process.stdout.write(`\r   ${spinner[i++ % spinner.length]} stage: ${stage}        `)

    if (stage === 'success') {
      process.stdout.write('\n')
      console.log('   ✅ Tiles published successfully.')
      if (job.warnings?.length) console.log('   ⚠️  warnings:', job.warnings)
      return job
    }
    if (stage === 'failed') {
      process.stdout.write('\n')
      throw new Error(`Publish job failed: ${JSON.stringify(job.errors)}`)
    }
    await sleep(5000)
  }
}

async function printLatestStatus() {
  console.log(`🔎 Latest job for ${tilesetId}:`)
  const jobs = await mapboxFetch(`/tilesets/v1/${tilesetId}/jobs`, {
    token,
    query: { limit: 1 }
  })
  if (!jobs.length) {
    console.log('   No jobs found yet. Run `npm run mts:upload` first.')
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
    throw new Error(`Invalid zoom range: minzoom=${minzoom}, maxzoom=${maxzoom} (must be integers 0..16, min<=max).`)
  }

  if (statusOnly) {
    await printLatestStatus()
    return
  }

  console.log('— Mapbox Tiling Service upload ———————————————————————————')
  console.log(`   account:  ${username}`)
  console.log(`   tileset:  ${tilesetId}`)
  console.log(`   zoom:     ${minzoom}–${maxzoom}`)
  console.log('———————————————————————————————————————————————————————————')

  const recipe = buildRecipe()
  const recipePath = resolve(projectRoot, 'recipe.generated.json')
  writeFileSync(recipePath, JSON.stringify(recipe, null, 2))
  console.log(`📝 Wrote recipe to ${recipePath}`)

  if (!skipSource) {
    await createSource()
  } else {
    console.log('⏭️  Skipping source upload (--skip-source).')
  }

  await validateRecipe(recipe)
  await createOrUpdateTileset(recipe)
  const jobId = await publish()
  await pollJob(jobId)

  console.log('\n🎉 Done! Add this to mapbox-poc/.env and restart `npm run dev`:\n')
  console.log(`   VITE_NVIS_TILESET_ID=${tilesetId}\n`)
}

main().catch((err) => {
  console.error('\n❌', err.message)
  if (err.status === 401 || err.status === 403) {
    console.error(
      '   Your MAPBOX_SECRET_TOKEN needs scopes: tilesets:write, tilesets:read, tilesets:list.'
    )
  }
  process.exit(1)
})

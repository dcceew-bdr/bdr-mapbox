#!/usr/bin/env node
// Pull a snapshot of what's on the Mapbox account that could have driven cost:
//   - all tilesets (raster + vector) and their reported sizes
//   - all MTS tileset SOURCES and their byte sizes (the "append bug" evidence)
//   - recent processing jobs per tileset (each job = a billable processing run)
// Read-only. Uses MAPBOX_SECRET_TOKEN.
import { loadEnv, getEnv, requireEnv } from './lib/env.mjs'
import { mapboxFetch } from './lib/mapbox.mjs'

loadEnv()
const username = requireEnv('MAPBOX_USERNAME')
const token = requireEnv('MAPBOX_SECRET_TOKEN')

const fmt = (n) => {
  if (!Number.isFinite(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`
}

async function main() {
  console.log(`\n=== TILESETS for ${username} ===`)
  let tilesets = []
  try {
    tilesets = await mapboxFetch(`/tilesets/v1/${username}`, { token, query: { limit: 100 } })
    for (const t of tilesets) {
      console.log(
        `  • ${t.id}\n      type=${t.type}  status=${t.status || '—'}  ` +
        `filesize=${fmt(t.filesize)}  created=${t.created?.slice(0,10) || '—'}`
      )
    }
    if (!tilesets.length) console.log('  (none)')
  } catch (e) {
    console.log('  error:', e.message)
  }

  console.log(`\n=== MTS SOURCES (append-bug evidence) ===`)
  try {
    const sources = await mapboxFetch(`/tilesets/v1/sources/${username}`, { token, query: { limit: 100 } })
    if (!sources.length) console.log('  (none)')
    for (const s of sources) {
      console.log(`  • ${s.id}\n      size=${fmt(s.size)}  files=${s.files ?? '—'}`)
    }
  } catch (e) {
    console.log('  error:', e.message)
  }

  console.log(`\n=== RECENT PROCESSING JOBS (each = a billable run) ===`)
  for (const t of tilesets) {
    try {
      const jobs = await mapboxFetch(`/tilesets/v1/${t.id}/jobs`, { token, query: { limit: 20 } })
      if (!jobs.length) continue
      console.log(`  ${t.id}: ${jobs.length} job(s)`)
      for (const j of jobs) {
        console.log(
          `     - ${j.created?.slice(0,19).replace('T',' ') || '—'}  ` +
          `stage=${j.stage}  id=${j.id}`
        )
      }
    } catch (e) {
      // some tileset types have no jobs endpoint; ignore
    }
  }

  console.log(`\n=== UPLOADS (Uploads API history) ===`)
  try {
    const uploads = await mapboxFetch(`/uploads/v1/${username}`, { token, query: { limit: 30 } })
    if (!uploads.length) console.log('  (none)')
    for (const u of uploads) {
      console.log(
        `  • ${u.created?.slice(0,19).replace('T',' ') || '—'}  ${u.tileset}  ` +
        `${u.complete ? 'complete' : 'processing'}${u.error ? `  ERROR:${u.error}` : ''}`
      )
    }
  } catch (e) {
    console.log('  error:', e.message)
  }
  console.log('')
}

main().catch((e) => { console.error('❌', e.message); process.exit(1) })

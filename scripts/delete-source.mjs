#!/usr/bin/env node
// Delete the MTS tileset SOURCE so a fresh upload replaces (not appends to) it.
// The Mapbox "create source" POST APPENDS files to a source; re-running the
// upload pipeline repeatedly grows the source. Delete it, then re-upload clean.
import { loadEnv, getEnv, requireEnv } from './lib/env.mjs'
import { mapboxFetch } from './lib/mapbox.mjs'

loadEnv()

const username = requireEnv('MAPBOX_USERNAME')
const token = requireEnv('MAPBOX_SECRET_TOKEN')
const sourceId = getEnv('MTS_SOURCE_ID', 'nvis_mvg_src')

async function main() {
  console.log(`🗑️  Deleting source "${sourceId}" for ${username} …`)
  try {
    await mapboxFetch(`/tilesets/v1/sources/${username}/${sourceId}`, {
      token,
      method: 'DELETE'
    })
    console.log('   ✅ Source deleted (or already gone).')
  } catch (err) {
    if (err.status === 404) {
      console.log('   ℹ️  Source not found — nothing to delete.')
    } else {
      console.error('   ❌', err.message)
      process.exit(1)
    }
  }
}

main()

#!/usr/bin/env node
import { loadEnv, getEnv } from './lib/env.mjs'
import { mapboxFetch } from './lib/mapbox.mjs'

loadEnv()

const username = getEnv('MAPBOX_USERNAME')
const tilesetName = getEnv('MTS_TILESET_NAME', 'nvis_mvg')
const tilesetId = `${username}.${tilesetName}`

async function main() {
  try {
    const jobs = await mapboxFetch(`/tilesets/v1/${tilesetId}/jobs`, {
      token: getEnv('MAPBOX_SECRET_TOKEN'),
      query: { limit: 10 }
    })
    console.log(JSON.stringify(jobs, null, 2))
  } catch (err) {
    console.error('Error fetching jobs:', err.message)
    if (err.body) console.error('body:', JSON.stringify(err.body, null, 2))
    process.exit(1)
  }
}

main()

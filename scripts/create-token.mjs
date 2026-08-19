#!/usr/bin/env node
// -----------------------------------------------------------------------------
//  Creates a PUBLIC Mapbox access token (pk.…) suitable for the web app.
//  Docs: https://docs.mapbox.com/api/accounts/tokens/#create-a-token
//
//  Usage:   npm run token:create
//  Requires in .env:
//    MAPBOX_USERNAME
//    MAPBOX_TOKENS_WRITE_TOKEN   (a secret sk.… token with the tokens:write scope)
// -----------------------------------------------------------------------------

import { loadEnv, requireEnv } from './lib/env.mjs'
import { mapboxFetch } from './lib/mapbox.mjs'

loadEnv()

const username = requireEnv('MAPBOX_USERNAME')
const authToken = requireEnv('MAPBOX_TOKENS_WRITE_TOKEN')

// Public scopes that let the browser load styles, fonts and tiles (incl. your
// private tileset, because the token belongs to your account).
const scopes = ['styles:tiles', 'styles:read', 'fonts:read']

async function main() {
  console.log(`🔑 Creating a public token for "${username}"…`)
  const result = await mapboxFetch(`/tokens/v2/${username}`, {
    token: authToken,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      note: 'NVIS x Mapbox POC (frontend)',
      scopes
    })
  })

  console.log('\n✅ Public token created.\n')
  console.log('   Scopes:', result.scopes?.join(', '))
  console.log('\n   Add this line to mapbox-poc/.env:\n')
  console.log(`   VITE_MAPBOX_TOKEN=${result.token}\n`)
}

main().catch((err) => {
  console.error('\n❌', err.message)
  if (err.status === 403 || err.status === 401) {
    console.error(
      '   The authorizing token (MAPBOX_TOKENS_WRITE_TOKEN) needs the tokens:write scope,\n' +
        '   plus every scope you are requesting. Create one in the Mapbox console.'
    )
  }
  process.exit(1)
})

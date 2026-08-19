#!/usr/bin/env node
// -----------------------------------------------------------------------------
//  Upload a locally-built .mbtiles tileset to Mapbox via the classic UPLOADS API.
//
//  Unlike MTS (which rejected our 2.5 GB raw GeoJSON and refuses gzip), the
//  Uploads API accepts a pre-built .mbtiles. Flow:
//    1. GET temporary S3 staging credentials from Mapbox.
//    2. PUT the .mbtiles to that S3 bucket (AWS SigV4, hand-rolled — no deps).
//    3. POST an "upload" telling Mapbox to ingest the staged file into a tileset.
//    4. Poll the upload status until complete (or --status-only to just check).
//
//  Everything uses Node built-ins (fetch + crypto + fs). No aws-sdk required.
//
//  Usage:   node scripts/upload-mbtiles.mjs   [--status-only]
//  Reads:   MBTILES_PATH, MAPBOX_USERNAME, MAPBOX_SECRET_TOKEN, MTSV_TILESET_NAME
// -----------------------------------------------------------------------------

import { readFileSync, statSync, existsSync } from 'node:fs'
import { isAbsolute, resolve, basename } from 'node:path'
import { createHash, createHmac } from 'node:crypto'
import { loadEnv, getEnv, requireEnv, projectRoot } from './lib/env.mjs'
import { mapboxFetch } from './lib/mapbox.mjs'

loadEnv()

const statusOnly = process.argv.includes('--status-only')

function resolvePath(p) {
  return isAbsolute(p) ? p : resolve(projectRoot, p)
}

const username = requireEnv('MAPBOX_USERNAME')
const token = requireEnv('MAPBOX_SECRET_TOKEN')
const tilesetName = getEnv('MTSV_TILESET_NAME', 'nvis_mvg_vector')
const tilesetId = `${username}.${tilesetName}`
const mbtilesPath = resolvePath(getEnv('MBTILES_PATH', '../NVIS_V7_30m/NVIS_V7_30m_Revised/nvis_mvg.mbtiles'))

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

// --- Minimal AWS Signature V4 for a single S3 PUT ---------------------------
const sha256hex = (d) => createHash('sha256').update(d).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

function encodeS3Key(key) {
  // URI-encode each path segment but preserve the '/' separators.
  return key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

async function s3Put(creds, fileBuffer) {
  // creds: { accessKeyId, secretAccessKey, sessionToken, bucket, key, url }
  const region = 'us-east-1'
  const service = 's3'
  const host = `${creds.bucket}.s3.amazonaws.com`
  const canonicalUri = '/' + encodeS3Key(creds.key)

  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '') // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8)

  const payloadHash = sha256hex(fileBuffer)
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date;x-amz-security-token'
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-security-token:${creds.sessionToken}\n`

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '', // no query
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n')

  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256hex(canonicalRequest)
  ].join('\n')

  const kDate = hmac('AWS4' + creds.secretAccessKey, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  const res = await fetch(`https://${host}${canonicalUri}`, {
    method: 'PUT',
    headers: {
      Authorization: authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'x-amz-security-token': creds.sessionToken,
      'Content-Type': 'application/octet-stream'
    },
    body: fileBuffer
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`S3 PUT failed → ${res.status}: ${text.slice(0, 400)}`)
  }
}

// --- Mapbox Uploads API helpers ---------------------------------------------
function getCredentials() {
  return mapboxFetch(`/uploads/v1/${username}/credentials`, { token })
}

function createUpload(stagedUrl) {
  return mapboxFetch(`/uploads/v1/${username}`, {
    token,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: stagedUrl, tileset: tilesetId, name: tilesetName })
  })
}

function getUploadStatus(uploadId) {
  return mapboxFetch(`/uploads/v1/${username}/${uploadId}`, { token })
}

function listUploads() {
  return mapboxFetch(`/uploads/v1/${username}`, { token })
}

async function pollUntilDone(uploadId) {
  const start = Date.now()
  for (;;) {
    const s = await getUploadStatus(uploadId)
    const el = Math.round((Date.now() - start) / 1000)
    const pct = Math.round((s.progress || 0) * 100)
    console.log(
      `   [${el}s] progress ${String(pct).padStart(3)}%  ` +
        `${s.complete ? 'complete' : 'processing'}${s.error ? `  ERROR: ${s.error}` : ''}`
    )
    if (s.error) throw new Error(`Upload failed: ${s.error}`)
    if (s.complete) {
      console.log(`\n✅ Tileset published: ${tilesetId}`)
      console.log(`   Use it in the client as source tiles: mapbox://${tilesetId}`)
      return s
    }
    await new Promise((r) => setTimeout(r, 4000))
  }
}

async function main() {
  console.log('— Upload .mbtiles → Mapbox (Uploads API) —————————————————')
  console.log(`   tileset:  ${tilesetId}`)
  console.log(`   mbtiles:  ${mbtilesPath}`)

  if (statusOnly) {
    const uploads = await listUploads()
    if (!uploads.length) {
      console.log('   No uploads found for this account.')
      return
    }
    console.log(`   Recent uploads (${uploads.length}):`)
    for (const u of uploads.slice(0, 10)) {
      console.log(
        `    • ${u.id}  ${u.tileset}  ` +
          `${u.complete ? 'complete' : 'processing'}  ${Math.round((u.progress || 0) * 100)}%` +
          `${u.error ? `  ERROR: ${u.error}` : ''}`
      )
    }
    return
  }

  if (!existsSync(mbtilesPath)) {
    throw new Error(
      `.mbtiles not found: ${mbtilesPath}\n   Run "node scripts/build-mbtiles.mjs" first.`
    )
  }
  const size = statSync(mbtilesPath).size
  console.log(`   size:     ${fmtBytes(size)}`)
  console.log('———————————————————————————————————————————————————————————')

  console.log('🔑 Requesting S3 staging credentials…')
  const creds = await getCredentials()

  console.log(`⬆️  Uploading ${basename(mbtilesPath)} to staging bucket…`)
  const buf = readFileSync(mbtilesPath)
  await s3Put(creds, buf)
  console.log('✅ Staged on S3.')

  console.log('📦 Creating Mapbox upload (ingest → tileset)…')
  const upload = await createUpload(creds.url)
  console.log(`   upload id: ${upload.id}`)

  console.log('⏳ Processing on Mapbox…')
  await pollUntilDone(upload.id)
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`)
  process.exit(1)
})

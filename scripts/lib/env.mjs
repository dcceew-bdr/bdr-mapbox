// Tiny .env loader + helpers shared by the upload/token scripts.
// No external dependencies: works with plain Node >= 20.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Absolute path to the project root (the mapbox-poc folder). */
export const projectRoot = resolve(__dirname, '..', '..')

/**
 * Loads KEY=VALUE pairs from mapbox-poc/.env into process.env.
 * Existing process.env values win (so you can override via the shell).
 */
export function loadEnv() {
  const envPath = resolve(projectRoot, '.env')
  if (!existsSync(envPath)) {
    console.warn('⚠️  No .env file found. Copy .env.example to .env and fill it in.')
    return
  }
  const text = readFileSync(envPath, 'utf8')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

/** Returns an env var or a fallback (fallback used when unset/empty). */
export function getEnv(name, fallback) {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

/** Returns a required env var or throws a friendly error. */
export function requireEnv(name) {
  const value = process.env[name]
  if (!value || value.includes('your_')) {
    throw new Error(
      `Missing required env var "${name}". Set it in mapbox-poc/.env (see .env.example).`
    )
  }
  return value
}

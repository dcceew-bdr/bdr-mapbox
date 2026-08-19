#!/usr/bin/env node
// Launch prepare-vector.mjs detached with env overrides, so multiple variants
// (different PREPV_SIMPLIFY_M / PREPV_GEOJSON) can run without editing .env.
// Usage: node scripts/run-prepare-variant.mjs KEY=VALUE [KEY=VALUE ...] --log <file>
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const script = resolve(here, 'prepare-vector.mjs')

const args = process.argv.slice(2)
let logFile = 'prepare-variant.out.log'
const env = { ...process.env }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--log') {
    logFile = args[++i]
  } else if (args[i].includes('=')) {
    const idx = args[i].indexOf('=')
    env[args[i].slice(0, idx)] = args[i].slice(idx + 1)
  }
}

const out = openSync(resolve(root, logFile), 'a')
const child = spawn(process.execPath, [script], {
  cwd: root,
  detached: true,
  env,
  stdio: ['ignore', out, out]
})
child.unref()
console.log(`🚀 Launched prepare variant (pid ${child.pid}) → ${logFile}`)
for (const [k, v] of Object.entries(env)) {
  if (k.startsWith('PREPV_')) console.log(`   ${k}=${v}`)
}

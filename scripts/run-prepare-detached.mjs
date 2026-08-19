#!/usr/bin/env node
// Launch prepare-vector.mjs as a DETACHED background process so it is immune to
// terminal SIGINT/Ctrl-C (which was killing it mid-run). Output goes to
// prepare-vector.out.log; live progress is in prepare-vector.status.log.
// Monitor with:  Get-Content prepare-vector.status.log -Wait   (or just re-read)
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const script = resolve(here, 'prepare-vector.mjs')
const outLog = resolve(root, 'prepare-vector.out.log')

const out = openSync(outLog, 'a')
const child = spawn(process.execPath, [script], {
  cwd: root,
  detached: true,
  stdio: ['ignore', out, out]
})
child.unref()

console.log(`🚀 Launched prepare-vector.mjs detached (pid ${child.pid}).`)
console.log('   Live progress:  prepare-vector.status.log')
console.log('   Full output:    prepare-vector.out.log')

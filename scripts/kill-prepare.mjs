#!/usr/bin/env node
// Find and kill any lingering `prepare-vector.mjs` node process (Windows).
// Uses tasklist/wmic-free approach via the Windows `wmic` replacement:
// PowerShell is flaky in this shell, so we parse `tasklist /v` is unreliable —
// instead use the built-in process list via `wmic` through execFileSync, and
// fall back to noop if not found.
import { execSync } from 'node:child_process'

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' })
  } catch {
    return ''
  }
}

// Query PIDs via a .ps1 file (avoids all nested-quoting problems). PowerShell
// is spawned directly by Node, so the interactive shell's first-char bug and
// quote-mangling don't apply.
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const here = dirname(fileURLToPath(import.meta.url))
const ps1 = resolve(here, 'find-prepare.ps1')
let out = run(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`)
const targets = out
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter((s) => /^\d+$/.test(s))

if (targets.length === 0) {
  console.log('No lingering prepare-vector process found.')
} else {
  for (const pid of targets) {
    run(`taskkill /PID ${pid} /F /T`)
    console.log(`Killed prepare-vector node PID ${pid}.`)
  }
}

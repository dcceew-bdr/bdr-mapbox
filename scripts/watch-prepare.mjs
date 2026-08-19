#!/usr/bin/env node
// Passive watcher: every 30s, append a timestamped line with the simplify GPKG
// size, output GeoJSON size, and prepare process CPU/RAM. Stops when the output
// GeoJSON exists (reproject done) or after maxMinutes. Reads only — never
// signals the prepare process.
import { statSync, appendFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const dir = '../NVIS_V7_30m/NVIS_V7_30m_Revised'
const simp = `${dir}/nvis_vec_simplified.gpkg`
const out = `${dir}/nvis_mvg_vector.geojsonl`
const watchLog = 'prepare-watch.log'
const maxMinutes = 30
const startedAt = Date.now()

writeFileSync(watchLog, `watch started ${new Date().toLocaleTimeString()}\n`)

function sizeMB(p) {
  try {
    return (statSync(p).size / 1048576).toFixed(0) + 'MB'
  } catch {
    return '-'
  }
}

function prepCpu() {
  try {
    const o = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ' +
        "Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*prepare-vector*' } | " +
        'ForEach-Object { \\"$($_.ProcessId) $([math]::Round($_.WorkingSetSize/1MB))MB\\" }"',
      { encoding: 'utf8' }
    ).trim()
    return o || '(no prepare proc)'
  } catch {
    return '(cpu query failed)'
  }
}

const timer = setInterval(() => {
  const t = new Date().toLocaleTimeString()
  const line = `[${t}] simp=${sizeMB(simp)} out=${sizeMB(out)} proc=${prepCpu()}`
  appendFileSync(watchLog, line + '\n')

  let outExists = false
  try {
    statSync(out)
    outExists = true
  } catch {
    /* not yet */
  }
  const mins = (Date.now() - startedAt) / 60000
  if (outExists) {
    appendFileSync(watchLog, `[${t}] ✅ output GeoJSON exists — reproject underway/done.\n`)
    clearInterval(timer)
  } else if (mins >= maxMinutes) {
    appendFileSync(watchLog, `[${t}] ⏱️ watcher timed out after ${maxMinutes} min.\n`)
    clearInterval(timer)
  }
}, 30000)

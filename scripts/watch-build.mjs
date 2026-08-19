#!/usr/bin/env node
// Watches the GDAL MVT build to completion without touching the worker.
// Completion = the final .mbtiles leaves its 16 KB header size (real commit
// landed) OR the worker process disappears. Also flags when temp.db starts
// shrinking (SQLite compaction => near the end). Read-only: never kills.
//
// Usage:
//   node scripts/watch-build.mjs [--pid 6524] [--interval 120] [--max 720]
// Flags:
//   --pid        worker PID to watch for liveness (default: 6524)
//   --interval   seconds between samples (default: 120)
//   --max        max minutes to watch before giving up (default: 720 = 12h)

import { spawnSync } from 'node:child_process';
import { statSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const PID = parseInt(getArg('pid', '6524'), 10);
const INTERVAL_S = parseInt(getArg('interval', '120'), 10);
const MAX_MIN = parseInt(getArg('max', '720'), 10);

const BASE = 'c:/Scripts/Repos/mapbox_upload/NVIS_V7_30m/NVIS_V7_30m_Revised';
const MBTILES = `${BASE}/nvis_mvg_90m.mbtiles`;
const TEMPDB = `${BASE}/nvis_mvg_90m.mbtiles.temp.db`;
const LOG = 'c:/Scripts/Repos/mapbox_upload/mapbox-poc/watch-build.status.log';
const HEADER_SIZE = 16384; // 16 KB placeholder => not yet committed

const sizeOf = (p) => {
  try { return statSync(p).size; } catch { return -1; }
};

// Is the PID still alive? Use `ps -W` (MSYS) which lists Windows PIDs in col 4.
const pidAlive = (pid) => {
  const r = spawnSync('ps', ['-W'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) {
    // Fallback: tasklist
    const t = spawnSync('tasklist', ['/FI', `PID eq ${pid}`], { encoding: 'utf8' });
    return t.stdout ? t.stdout.includes(String(pid)) : false;
  }
  return r.stdout.split('\n').some((line) => {
    const cols = line.trim().split(/\s+/);
    return cols[3] === String(pid) || cols[0] === String(pid);
  });
};

const fmtBytes = (b) => {
  if (b < 0) return 'missing';
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
};

const stamp = () => new Date().toLocaleTimeString();
const log = (msg) => {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG, line + '\n'); } catch { /* ignore */ }
};

log(`watch start: pid=${PID} interval=${INTERVAL_S}s max=${MAX_MIN}min`);
log(`watching mbtiles=${MBTILES}`);

let prevTemp = sizeOf(TEMPDB);
let compactionSeen = false;
const startMs = Date.now();

const tick = () => {
  const elapsedMin = (Date.now() - startMs) / 60000;
  const mb = sizeOf(MBTILES);
  const temp = sizeOf(TEMPDB);
  const alive = pidAlive(PID);

  const dTemp = prevTemp >= 0 && temp >= 0 ? temp - prevTemp : 0;
  const trend = dTemp > 0 ? `+${fmtBytes(dTemp)}` : dTemp < 0 ? `-${fmtBytes(-dTemp)}` : 'flat';

  const tempGone = temp < 0;
  const draining = mb > HEADER_SIZE; // real tiles are landing in the final file
  log(`mbtiles=${fmtBytes(mb)}  temp.db=${tempGone ? 'GONE' : fmtBytes(temp)} (${trend})  pid=${alive ? 'RUNNING' : 'GONE'}${draining ? '  [flushing→mbtiles]' : ''}`);

  // TRUE completion: GDAL deletes temp.db after a successful commit,
  // OR the worker exits with a real (non-header) mbtiles in place.
  if (tempGone && mb > HEADER_SIZE) {
    log(`✅ DONE — temp.db removed, mbtiles=${fmtBytes(mb)}. Build committed. Ready to upload.`);
    process.exit(0);
  }
  if (!alive) {
    if (mb > HEADER_SIZE && tempGone) {
      log(`✅ DONE — worker exited cleanly, mbtiles=${fmtBytes(mb)}.`);
    } else if (mb > HEADER_SIZE) {
      log(`⚠️  worker GONE, mbtiles=${fmtBytes(mb)} but temp.db still present — verify the file opens before uploading.`);
    } else {
      log(`⚠️  worker GONE with mbtiles still header-only — build likely FAILED.`);
    }
    process.exit(0);
  }

  // Progress hint: mbtiles growing => final flush actively draining temp.db.
  if (draining && !compactionSeen) {
    compactionSeen = true;
    log('� final flush underway — tiles now writing into .mbtiles (last phase).');
  }

  if (elapsedMin >= MAX_MIN) {
    log(`⏱️  max watch time (${MAX_MIN} min) reached — still running. Re-launch to keep watching.`);
    process.exit(0);
  }

  prevTemp = temp;
  setTimeout(tick, INTERVAL_S * 1000);
};

tick();

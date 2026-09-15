#!/usr/bin/env node
// scripts/record-models.mjs
// Fetches the gateway /health endpoint and appends a sample for each worker
// into history/models-state.json. New workers are auto-discovered.
//
// State shape (kept compact; one file for all workers):
// {
//   "version": 1,
//   "updated_at": <unix-seconds>,
//   "workers": {
//     "<worker-key>": {
//       "first_seen": <unix-seconds>,
//       "last_seen":  <unix-seconds>,
//       "models":     ["..."],       // last-seen aliases
//       "buckets": {
//         "YYYY-MM-DD": {
//           "checks": N,              // total samples that day
//           "ok": N,
//           "suspended": N,
//           "down": N,
//           "lat_sum": <ms>,          // sum of latencies for ok samples
//           "lat_count": N            // number of ok samples (== ok)
//         }
//       }
//     }
//   }
// }
//
// Daily status derivation (consumed by build-site.mjs):
//   down       if any down sample
//   degraded   if no ok and any suspended (model never woke that day)
//   up         if any ok
//   none       otherwise

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const HISTORY_DIR = join(ROOT, "history");
const STATE_FILE = join(HISTORY_DIR, "models-state.json");
const ENDPOINT =
  process.env.HEALTH_ENDPOINT || "https://api.empiriolabs.ai/health";
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 90);
// Drop a tracked worker if /health hasn't surfaced it in this many seconds.
// Default 1800 (30 min) so renamed/removed services disappear from the
// status page within ~one scheduled run cycle. Tolerant of one transient
// /health hiccup at the default 5-min schedule, but immediate enough that
// stale entries don't linger for days. Set to 0 to disable auto-pruning.
const STALE_PRUNE_SECONDS = Math.max(0, Number(process.env.STALE_PRUNE_SECONDS || 1800));
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000);
const FETCH_RETRIES = Math.max(1, Number(process.env.FETCH_RETRIES || 3));
const FETCH_RETRY_DELAY_MS = Math.max(
  0,
  Number(process.env.FETCH_RETRY_DELAY_MS || 2000)
);
// Default to one sample per workflow run so the daily check count shown on the
// page matches the number of completed scheduled runs. Workflows can override
// SAMPLES_PER_RUN if a future self-hosted or externally triggered setup wants
// burst sampling inside a single run.
const SAMPLES_PER_RUN = Math.max(1, Number(process.env.SAMPLES_PER_RUN || 1));
const SAMPLE_INTERVAL_SECONDS = Math.max(
  5,
  Number(process.env.SAMPLE_INTERVAL_SECONDS || 30)
);

function utcDay(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { version: 1, updated_at: 0, workers: {} };
  }
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    if (!s || typeof s !== "object") throw new Error("not an object");
    s.workers = s.workers || {};
    return s;
  } catch (err) {
    console.error(`[record-models] state file unreadable, starting fresh: ${err.message}`);
    return { version: 1, updated_at: 0, workers: {} };
  }
}

function saveState(state) {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  // Stable key ordering for clean diffs
  const out = {
    version: 1,
    updated_at: state.updated_at,
    workers: {},
  };
  for (const key of Object.keys(state.workers).sort()) {
    const w = state.workers[key];
    const buckets = {};
    for (const day of Object.keys(w.buckets || {}).sort()) {
      buckets[day] = w.buckets[day];
    }
    out.workers[key] = {
      first_seen: w.first_seen,
      last_seen: w.last_seen,
      last_seen_in_health: w.last_seen_in_health || w.last_seen,
      models: w.models || [],
      buckets,
    };
  }
  writeFileSync(STATE_FILE, JSON.stringify(out, null, 2) + "\n");
}

function trimBuckets(workerEntry, todayUnix) {
  const cutoff = new Date((todayUnix - (HISTORY_DAYS - 1) * 86400) * 1000);
  const cutoffDay = utcDay(Math.floor(cutoff.getTime() / 1000));
  const buckets = workerEntry.buckets || {};
  for (const day of Object.keys(buckets)) {
    if (day < cutoffDay) delete buckets[day];
  }
  workerEntry.buckets = buckets;
}

async function fetchHealth() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      signal: ctrl.signal,
      headers: { "user-agent": "empiriolabs-status-recorder/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`timeout after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

async function fetchHealthWithRetries(sampleLabel) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      return await fetchHealth();
    } catch (err) {
      lastError = err;
      console.error(
        `[record-models] sample ${sampleLabel} fetch attempt ${attempt}/${FETCH_RETRIES} failed: ${errorMessage(err)}`
      );
      if (attempt < FETCH_RETRIES && FETCH_RETRY_DELAY_MS > 0) {
        await sleep(FETCH_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastError;
}

// Expand a worker entry from the gateway's /health response into one
// or more (key, alias-list) pairs for the status page.
//
// Today the only real "one Railway service hosts multiple distinct
// models" case is inworld-tts (serves both tts-1-5-mini and tts-1-5-max).
// runpod_media_proxy shares CODE across multiple Railway services but
// each has its own service URL, so the gateway already lists them as
// separate workers — no fan-out needed.
//
// Strategy: only fan out when the worker reports >1 model_slug. For
// the single-model case, keep the existing worker-keyed entry so its
// 90-day uptime history is preserved across deploys, even when the
// Railway service name and the canonical model slug differ slightly
// (e.g. ace-step-1-5-xl Railway service vs. ace-step-1.5-xl catalog
// slug — both refer to the same single model).
//
// Falls back to a single entry keyed by the worker name when
// model_slugs is missing/empty (older gateway response, network blip),
// so the page never goes blank just because a snapshot was partial.
function expandWorkerEntries(workerKey, w) {
  const slugs = Array.isArray(w.model_slugs)
    ? w.model_slugs.filter((s) => typeof s === "string" && s.length > 0)
    : [];
  if (slugs.length <= 1) {
    return [{ key: workerKey, models: Array.isArray(w.models) ? w.models : slugs }];
  }
  return slugs.map((slug) => ({
    key: slug,
    models: Array.isArray(w.models) ? w.models : [slug],
  }));
}

function recordSample(state, data, nowUnix) {
  const workers = data.workers || {};
  const day = utcDay(nowUnix);
  const seen = new Set();

  for (const [workerKey, w] of Object.entries(workers)) {
    const status =
      w.status === "ok" || w.status === "suspended" || w.status === "down"
        ? w.status
        : "down";
    const lat =
      typeof w.latency_ms === "number" && isFinite(w.latency_ms)
        ? w.latency_ms
        : null;

    for (const { key, models } of expandWorkerEntries(workerKey, w)) {
      seen.add(key);

      if (!state.workers[key]) {
        state.workers[key] = {
          first_seen: nowUnix,
          last_seen: nowUnix,
          last_seen_in_health: nowUnix,
          models,
          buckets: {},
        };
      }
      const entry = state.workers[key];
      entry.last_seen = nowUnix;
      entry.last_seen_in_health = nowUnix;
      if (Array.isArray(models) && models.length) entry.models = models;

      if (!entry.buckets[day]) {
        entry.buckets[day] = {
          checks: 0,
          ok: 0,
          suspended: 0,
          down: 0,
          lat_sum: 0,
          lat_count: 0,
        };
      }
      const b = entry.buckets[day];
      b.checks += 1;
      b[status] = (b[status] || 0) + 1;
      if (status === "ok" && lat != null) {
        b.lat_sum += lat;
        b.lat_count += 1;
      }
      trimBuckets(entry, nowUnix);
    }
  }

  // Workers we previously tracked but didn't see this run remain in state
  // so their historical bars persist for HISTORY_DAYS. They naturally stop
  // accumulating new buckets and will be evicted from the UI if their last
  // bucket falls outside the window.
  state.updated_at = nowUnix;
  return seen.size;
}

// An unreachable /health endpoint records NOTHING per model.
//
// This function used to add one `down` sample to every worker's bucket. That
// asserts something the recorder cannot actually observe: it cannot tell "the
// gateway is down" apart from "this runner cannot reach the gateway". On
// 2026-09-15 the second case happened (the API host answered 200 everywhere
// except GitHub's runners) and the recorder wrote 2184 false down samples
// across all 182 models in a few hours, showing 12.2% fabricated downtime on
// every 90-day bar against 0 on every prior day of the month.
//
// A failed inventory read is not zero stock. The honest signal for "/health
// itself is unreachable" is the `models` site row, which Upptime already
// checks against the same endpoint and which reports it without claiming
// anything about any individual model. A per-model `down` is only truthful
// when /health answered and named that worker down.
//
// `updated_at` is deliberately left alone so a run of pure failures leaves the
// state file byte-identical, which keeps the workflow from committing and
// racing a push for a sample that carries no information.
function noteEndpointUnreachable(state) {
  return Object.keys(state.workers || {}).length;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Prune worker entries whose /health visibility has expired. Only runs
// when the current run produced at least one SUCCESSFUL health sample —
// otherwise a transient gateway outage that lasts longer than
// STALE_PRUNE_SECONDS would delete every worker entry (including its
// historical buckets), which is exactly what happened on 2026-05-19:
// gateway/health was unreachable for ~30 min, the script kept logging
// "endpoint unavailable" failures, last_seen_in_health stayed stale on
// every worker, and the next pruning pass deleted all 113 entries plus
// 12 days of bucket history. Requiring a successful sample before
// pruning means renames/removals still get cleaned up at the next
// healthy check, but outages can never wipe history.
function pruneStaleWorkers(state, nowUnix, { hadSuccessfulSample }) {
  if (!STALE_PRUNE_SECONDS) return [];
  if (!hadSuccessfulSample) return [];
  const cutoff = nowUnix - STALE_PRUNE_SECONDS;
  const dropped = [];
  for (const key of Object.keys(state.workers)) {
    const entry = state.workers[key];
    const lastInHealth = entry.last_seen_in_health || entry.first_seen || 0;
    if (lastInHealth < cutoff) {
      dropped.push(key);
      delete state.workers[key];
    }
  }
  return dropped;
}

async function main() {
  const state = loadState();
  let totalSamples = 0;
  let lastSampleUnix = 0;
  let lastWorkerCount = 0;
  let hadSuccessfulSample = false;

  for (let i = 0; i < SAMPLES_PER_RUN; i++) {
    let data;
    try {
      data = await fetchHealthWithRetries(`${i + 1}/${SAMPLES_PER_RUN}`);
    } catch (err) {
      const failedAt = Math.floor(Date.now() / 1000);
      const untouched = noteEndpointUnreachable(state);
      lastSampleUnix = lastSampleUnix || failedAt;
      lastWorkerCount = untouched;
      console.error(
        `[record-models] sample ${i + 1}/${SAMPLES_PER_RUN}: health endpoint unavailable after ${FETCH_RETRIES} attempts; recorded no sample for ${untouched} workers (${errorMessage(err)})`
      );
      if (i < SAMPLES_PER_RUN - 1) await sleep(SAMPLE_INTERVAL_SECONDS * 1000);
      continue;
    }
    const checkedAt = typeof data.checked_at === "number" ? data.checked_at : null;
    const sampleUnix = checkedAt ?? Math.floor(Date.now() / 1000);
    const recorded = recordSample(state, data, sampleUnix);
    totalSamples += 1;
    lastSampleUnix = sampleUnix;
    lastWorkerCount = recorded;
    hadSuccessfulSample = true;
    console.log(
      `[record-models] sample ${i + 1}/${SAMPLES_PER_RUN}: ${recorded} workers @ ${utcDay(sampleUnix)} (${sampleUnix})`
    );
    if (i < SAMPLES_PER_RUN - 1) {
      await sleep(SAMPLE_INTERVAL_SECONDS * 1000);
    }
  }

  if (totalSamples === 0) {
    lastSampleUnix = lastSampleUnix || Math.floor(Date.now() / 1000);
    lastWorkerCount = noteEndpointUnreachable(state);
    console.error(
      `[record-models] no health samples succeeded; history left unchanged for ${lastWorkerCount} workers`
    );
  }

  const dropped = pruneStaleWorkers(
    state,
    lastSampleUnix || Math.floor(Date.now() / 1000),
    { hadSuccessfulSample },
  );
  if (dropped.length) {
    console.log(
      `[record-models] pruned ${dropped.length} stale workers (no /health entry for ${STALE_PRUNE_SECONDS}s): ${dropped.join(", ")}`
    );
  }

  saveState(state);
  console.log(
    `[record-models] recorded ${totalSamples} samples (${lastWorkerCount} workers in last sample) @ ${utcDay(lastSampleUnix)} (${lastSampleUnix})`
  );
}

main().catch((err) => {
  console.error(`[record-models] FAILED: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

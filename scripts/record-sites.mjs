#!/usr/bin/env node
// scripts/record-sites.mjs
// Pings every site in .upptimerc.yml and appends a sample to
// history/sites-state.json. Mirrors the pattern used by record-models.mjs.
//
// Why a custom recorder instead of relying on upptime/uptime-monitor?
// The upstream monitor commits a per-site YAML file every run, which is
// extremely noisy for git history and — in practice on this repo — runs
// far less frequently than its */5 cron suggests (only ~2 commits per day
// were landing). That left build-site.mjs with almost no data to chart, so
// the 90-day bars showed "No data" for nearly every day.
//
// This recorder collapses everything into one JSON state file (one commit
// per run, regardless of site count) so the cron is reliable and the bars
// reflect real check density.
//
// State shape:
// {
//   "version": 1,
//   "updated_at": <unix-seconds>,
//   "sites": {
//     "<slug>": {
//       "name": "...",
//       "url": "...",
//       "first_seen": <unix-seconds>,
//       "last_seen":  <unix-seconds>,
//       "last_status": "up" | "down",
//       "last_code":   <int>,
//       "last_latency_ms": <int>,
//       "last_error":  "..." | null,
//       "buckets": {
//         "YYYY-MM-DD": {
//           "checks":   N,
//           "up":       N,
//           "down":     N,
//           "lat_sum":  <ms>,
//           "lat_count": N
//         }
//       }
//     }
//   }
// }

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const HISTORY_DIR = join(ROOT, "history");
const STATE_FILE = join(HISTORY_DIR, "sites-state.json");
const CONFIG_FILE = join(ROOT, ".upptimerc.yml");
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 90);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000);
// One sample per run unless the workflow asks for more: Uptime CI takes four,
// a minute apart, so each five-minute run covers its own slot.
const SAMPLES_PER_RUN = Math.max(1, Number(process.env.SAMPLES_PER_RUN || 1));
const SAMPLE_INTERVAL_SECONDS = Math.max(
  5,
  Number(process.env.SAMPLE_INTERVAL_SECONDS || 30)
);
// A failed probe is tried once more after this delay before it counts as down,
// so a dropped connection on the runner is not recorded as an outage.
const RETRY_DELAY_SECONDS = Math.max(0, Number(process.env.RETRY_DELAY_SECONDS || 5));

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function utcDay(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function loadConfig() {
  const raw = readFileSync(CONFIG_FILE, "utf8");
  const cfg = yaml.load(raw);
  return cfg || {};
}

function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { version: 1, updated_at: 0, sites: {} };
  }
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!s || typeof s !== "object") throw new Error("not an object");
    s.sites = s.sites || {};
    return s;
  } catch (err) {
    console.error(
      `[record-sites] state file unreadable, starting fresh: ${err.message}`
    );
    return { version: 1, updated_at: 0, sites: {} };
  }
}

function saveState(state) {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  const out = {
    version: 1,
    updated_at: state.updated_at,
    sites: {},
  };
  for (const slug of Object.keys(state.sites).sort()) {
    const s = state.sites[slug];
    const buckets = {};
    for (const day of Object.keys(s.buckets || {}).sort()) {
      buckets[day] = s.buckets[day];
    }
    out.sites[slug] = {
      name: s.name,
      url: s.url,
      first_seen: s.first_seen,
      last_seen: s.last_seen,
      last_status: s.last_status,
      last_code: s.last_code,
      last_latency_ms: s.last_latency_ms,
      last_error: s.last_error || null,
      buckets,
    };
  }
  writeFileSync(STATE_FILE, JSON.stringify(out, null, 2) + "\n");
}

function trimBuckets(entry, todayUnix) {
  const cutoffUnix = todayUnix - (HISTORY_DAYS - 1) * 86400;
  const cutoffDay = utcDay(cutoffUnix);
  const buckets = entry.buckets || {};
  for (const day of Object.keys(buckets)) {
    if (day < cutoffDay) delete buckets[day];
  }
  entry.buckets = buckets;
}

// A site with `sinceParam` is asked about the time since its previous sample
// (unix seconds in that query parameter), so a failure between two samples is
// still recorded, and recorded once.
function probeUrl(site, sinceUnix, base = site.url, param = site.sinceParam) {
  if (!param || !Number.isFinite(sinceUnix)) return base;
  const url = new URL(base);
  url.searchParams.set(String(param), String(Math.floor(sinceUnix)));
  return url.toString();
}

// A site may also name a readiness probe (`readyUrl`), which answers
// {"status":"ok"}, or 503 while that service's requests are failing. The
// sample is down when either check fails. Readiness probes are always asked
// about the time since the previous sample.
const READY_SITE = { expectedStatusCodes: [200], __dangerous__body_down_if_text_missing: '"status":"ok"' };

async function probe(site, url = site.url) {
  const expected = Array.isArray(site.expectedStatusCodes) && site.expectedStatusCodes.length
    ? site.expectedStatusCodes
    : [200];
  const requireText = site.__dangerous__body_down_if_text_missing || null;
  // Some checks need the body to verify content; always GET.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      // Follow redirects to match the live status page's existing behavior:
      // some sites (e.g. the docs subdomain) issue a 307 to the canonical
      // host before returning 200; without follow we'd flag them as down.
      redirect: "follow",
      headers: { "user-agent": "empiriolabs-status-recorder/1.0" },
    });
    const code = res.status;
    let bodyOk = true;
    if (requireText) {
      try {
        const text = await res.text();
        bodyOk = text.includes(requireText);
      } catch {
        bodyOk = false;
      }
    }
    const latency = Date.now() - t0;
    const codeOk = expected.includes(code);
    return {
      status: codeOk && bodyOk ? "up" : "down",
      code,
      latency_ms: latency,
      error: codeOk && bodyOk
        ? null
        : !codeOk
        ? `Unexpected status ${code}`
        : "Required body text missing",
    };
  } catch (err) {
    return {
      status: "down",
      code: 0,
      latency_ms: Date.now() - t0,
      error: err && err.name === "AbortError" ? "Timeout" : (err && err.message) || "Fetch failed",
    };
  } finally {
    clearTimeout(t);
  }
}

function recordSample(state, slug, site, result, nowUnix) {
  if (!state.sites[slug]) {
    state.sites[slug] = {
      name: site.name,
      url: site.url,
      first_seen: nowUnix,
      last_seen: nowUnix,
      last_status: result.status,
      last_code: result.code,
      last_latency_ms: result.latency_ms,
      last_error: result.error,
      buckets: {},
    };
  }
  const entry = state.sites[slug];
  // Refresh display metadata in case .upptimerc.yml changed.
  entry.name = site.name;
  entry.url = site.url;
  entry.last_seen = nowUnix;
  entry.last_status = result.status;
  entry.last_code = result.code;
  entry.last_latency_ms = result.latency_ms;
  entry.last_error = result.error;

  const day = utcDay(nowUnix);
  if (!entry.buckets[day]) {
    entry.buckets[day] = {
      checks: 0,
      up: 0,
      down: 0,
      lat_sum: 0,
      lat_count: 0,
    };
  }
  const b = entry.buckets[day];
  b.checks += 1;
  b[result.status] = (b[result.status] || 0) + 1;
  if (result.status === "up" && Number.isFinite(result.latency_ms)) {
    b.lat_sum += result.latency_ms;
    b.lat_count += 1;
  }
  trimBuckets(entry, nowUnix);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeWithRetry(site, url) {
  let result = await probe(site, url);
  if (result.status === "down" && RETRY_DELAY_SECONDS > 0) {
    await sleep(RETRY_DELAY_SECONDS * 1000);
    result = await probe(site, url);
  }
  return result;
}

async function probeRound(sites, state) {
  // All sites in parallel — small N, all independent network calls.
  return Promise.all(
    sites.map(async (site) => {
      const slug = site.slug || slugify(site.name);
      const previous = state.sites[slug];
      const since = previous ? previous.last_seen : undefined;
      const [main, ready] = await Promise.all([
        probeWithRetry(site, probeUrl(site, since)),
        site.readyUrl
          ? probeWithRetry(READY_SITE, probeUrl(site, since, site.readyUrl, "since"))
          : null,
      ]);
      const result = main.status === "down" || !ready || ready.status === "up"
        ? main
        : { ...ready, latency_ms: main.latency_ms, error: `Readiness: ${ready.error}` };
      return { slug, site, result };
    })
  );
}

async function main() {
  const cfg = loadConfig();
  const sites = Array.isArray(cfg.sites) ? cfg.sites : [];
  if (!sites.length) {
    console.error("[record-sites] no sites configured in .upptimerc.yml");
    process.exit(1);
  }
  const state = loadState();
  // State is kept only for configured rows, so a row removed from
  // .upptimerc.yml takes its samples with it at the next run.
  const configured = new Set(sites.map((site) => site.slug || slugify(site.name)));
  for (const slug of Object.keys(state.sites)) {
    if (!configured.has(slug)) delete state.sites[slug];
  }
  let totalSamples = 0;

  for (let i = 0; i < SAMPLES_PER_RUN; i++) {
    const sampleUnix = Math.floor(Date.now() / 1000);
    const results = await probeRound(sites, state);
    for (const { slug, site, result } of results) {
      recordSample(state, slug, site, result, sampleUnix);
      console.log(
        `[record-sites] sample ${i + 1}/${SAMPLES_PER_RUN} ${slug}: ${result.status} (code=${result.code}, latency=${result.latency_ms}ms)${
          result.error ? ` err="${result.error}"` : ""
        }`
      );
    }
    totalSamples += results.length;
    state.updated_at = sampleUnix;
    if (i < SAMPLES_PER_RUN - 1) {
      await sleep(SAMPLE_INTERVAL_SECONDS * 1000);
    }
  }

  saveState(state);
  console.log(
    `[record-sites] recorded ${totalSamples} samples across ${sites.length} sites in ${SAMPLES_PER_RUN} rounds @ ${utcDay(state.updated_at)} (${state.updated_at})`
  );
}

main().catch((err) => {
  console.error(`[record-sites] FAILED: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});

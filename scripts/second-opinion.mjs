// scripts/second-opinion.mjs
// A second, independent look at an endpoint this runner could not connect to.
//
// A check that fails to CONNECT (DNS, TCP, TLS or a timeout, so no HTTP answer
// at all) can mean the endpoint is down, or that this one runner's network is
// having a bad few minutes. On 2026-11-12 a runner timed out against two
// unrelated hosts for five minutes while both were answering everyone else,
// and the page reported an outage that never happened.
//
// So before a connection failure counts, probes on other networks request the
// same URL:
//
//   - any of them gets the expected answer -> "up": the failure was ours;
//   - they all finish and none does         -> "down": it is confirmed;
//   - they cannot be asked or do not finish -> "unknown": the caller keeps its
//     own result, exactly as it did before this file existed.
//
// An HTTP answer that fails a check (a 5xx, a missing body marker) is the
// endpoint speaking for itself. It never comes here.
//
// The probes come from the public Globalping measurement network. No key is
// needed; its hourly allowance is shared by everything behind one address, so
// callers ask only on a connection failure and keep a budget per run.

const API = process.env.SECOND_OPINION_API || "https://api.globalping.io/v1/measurements";
// Probes give up on a dead endpoint after about 15 seconds, so wait a little longer.
const WAIT_MS = Math.max(1000, Number(process.env.SECOND_OPINION_WAIT_MS || 20000));
const POLL_MS = 1000;
const REQUEST_TIMEOUT_MS = 8000;
const USER_AGENT = "empiriolabs-status-recorder/1.0";
// Two networks on this continent and one across the ocean.
const LOCATIONS = [
  { magic: "north america", limit: 2 },
  { magic: "europe", limit: 1 },
];
// The recorder follows redirects, so a redirect seen by a probe (which does
// not follow them) still shows the endpoint answering.
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// The measurement that asks other networks for `url`.
export function measurementFor(url) {
  const u = new URL(url);
  const https = u.protocol === "https:";
  const request = { method: "GET", path: u.pathname || "/" };
  if (u.search.length > 1) request.query = u.search.slice(1);
  return {
    type: "http",
    target: u.hostname,
    locations: LOCATIONS,
    measurementOptions: {
      protocol: https ? "HTTPS" : "HTTP",
      port: u.port ? Number(u.port) : https ? 443 : 80,
      request,
    },
  };
}

function passes(result, expected, requireText) {
  const code = result.statusCode;
  if (REDIRECTS.has(code)) return true;
  if (!expected.includes(code)) return false;
  if (!requireText) return true;
  return typeof result.rawBody === "string" && result.rawBody.includes(requireText);
}

// Turns the probes' results into a verdict. `complete` says every probe has
// reported; without it nothing can be called down.
export function judge(results, { expectedStatusCodes, requireText } = {}, complete = true) {
  const expected =
    Array.isArray(expectedStatusCodes) && expectedStatusCodes.length ? expectedStatusCodes : [200];
  let reported = 0;
  let passed = 0;
  let code = 0;
  for (const entry of Array.isArray(results) ? results : []) {
    const result = (entry && entry.result) || {};
    if (result.status !== "finished" && result.status !== "failed") continue;
    reported += 1;
    const answered = result.status === "finished" && Number.isInteger(result.statusCode);
    if (answered && passes(result, expected, requireText || null)) {
      passed += 1;
      if (!code) code = result.statusCode;
    }
  }
  const detail = `${passed} of ${reported} other networks got the expected answer`;
  if (passed > 0) return { verdict: "up", code, detail };
  if (complete && reported >= 2) return { verdict: "down", code: 0, detail };
  return { verdict: "unknown", code: 0, detail: `${detail}; not enough of them reported` };
}

async function request(fetchImpl, url, init = {}) {
  const res = await fetchImpl(url, {
    ...init,
    headers: { "user-agent": USER_AGENT, accept: "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

// Asks other networks for `url`. Never throws: anything that goes wrong on the
// way is "unknown".
export async function secondOpinion(url, criteria = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;
  try {
    const created = await request(fetchImpl, API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(measurementFor(url)),
    });
    if (created.status !== 202 || !created.data || !created.data.id) {
      return { verdict: "unknown", code: 0, detail: `the probe network answered ${created.status}` };
    }
    const deadline = now() + WAIT_MS;
    let last = null;
    while (now() < deadline) {
      await sleep(POLL_MS);
      const read = await request(fetchImpl, `${API}/${encodeURIComponent(created.data.id)}`);
      if (read.status !== 200 || !read.data) continue;
      last = read.data;
      if (last.status === "finished") return judge(last.results, criteria, true);
    }
    // Out of time: an answer that already arrived still counts, a missing one
    // proves nothing.
    return judge(last ? last.results : [], criteria, false);
  } catch (err) {
    return {
      verdict: "unknown",
      code: 0,
      detail: `the probe network could not be asked (${(err && err.name) || "error"})`,
    };
  }
}

// One plain request from this runner, judged as the recorder judges it.
export async function directCheck(site, fetchImpl = fetch) {
  const expected =
    Array.isArray(site.expectedStatusCodes) && site.expectedStatusCodes.length
      ? site.expectedStatusCodes
      : [200];
  const requireText = site.__dangerous__body_down_if_text_missing || null;
  try {
    const res = await fetchImpl(site.url, {
      redirect: "follow",
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });
    let ok = expected.includes(res.status);
    if (ok && requireText) ok = (await res.text()).includes(requireText);
    return { answered: true, ok, code: res.status };
  } catch {
    return { answered: false, ok: false, code: 0 };
  }
}

// Whether a recorded "down" describes an endpoint that is really failing.
// `recordedCode` is the HTTP code the check stored. Anything but 0 is the
// endpoint's own answer, so the down stands. A 0 means that check could not
// connect, and a connection failure is confirmed only while this runner still
// cannot connect and other networks cannot either. When they cannot be asked
// the down stands, as it did before.
export async function confirmDown(site, recordedCode, deps = {}) {
  const direct = deps.directCheck || directCheck;
  const opinionOf = deps.secondOpinion || secondOpinion;
  const code = Number(recordedCode);
  if (Number.isFinite(code) && code !== 0) {
    return { confirmed: true, why: `the endpoint answered ${code}` };
  }
  const now = await direct(site);
  if (now.answered) {
    return now.ok
      ? { confirmed: false, why: "it answers this runner normally now" }
      : { confirmed: true, why: `the endpoint answers ${now.code}` };
  }
  const opinion = await opinionOf(site.url, {
    expectedStatusCodes: site.expectedStatusCodes,
    requireText: site.__dangerous__body_down_if_text_missing || null,
  });
  if (opinion.verdict === "up") {
    return { confirmed: false, why: `other networks reach it (${opinion.detail})` };
  }
  return {
    confirmed: true,
    why:
      opinion.verdict === "down"
        ? `other networks cannot reach it either (${opinion.detail})`
        : `no second check was possible (${opinion.detail})`,
  };
}

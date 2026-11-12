// scripts/second-opinion.mjs
// A second, independent look at an endpoint this runner could not connect to.
//
// A check that fails to CONNECT (DNS, TCP, TLS or a timeout, so no HTTP answer
// at all) can mean the endpoint is down, or that this one runner's network is
// having a bad few minutes. On 2026-11-12 a runner timed out against two
// unrelated hosts for five minutes while both were answering everyone else,
// and the page reported an outage that never happened.
//
// The rule: a connection failure is an outage only when other networks cannot
// reach the endpoint either. Probes on other networks request the same URL:
//
//   - any of them gets the expected answer     -> "up": the failure was ours;
//   - at least two finish, and none gets one   -> "down": it is confirmed;
//   - nobody could be asked, or too few answer -> "unknown".
//
// "unknown" is never treated as down. A runner that cannot connect and cannot
// get a second look knows nothing about the endpoint, so nothing is recorded
// and no incident is opened; the next run asks again.
//
// An HTTP answer that fails a check (a 5xx, a missing body marker) is the
// endpoint speaking for itself. It never comes here.
//
// Two public measurement networks are asked, the second only when the first
// cannot answer: Globalping, then check-host.net. Neither needs a key. Their
// allowances are shared by everything behind one address, so callers ask only
// on a connection failure and keep a budget per run.

const GLOBALPING = process.env.SECOND_OPINION_API || "https://api.globalping.io/v1/measurements";
const CHECK_HOST = process.env.SECOND_OPINION_BACKUP_API || "https://check-host.net";
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
const BACKUP_NODES = ["us1.node.check-host.net", "us5.node.check-host.net", "de4.node.check-host.net"];
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

// What one probe saw:
//   "pass"         the expected answer;
//   "fail"         no connection, or a server error: evidence of an outage;
//   "inconclusive" answered, but refused or not served (a 4xx): that probe was
//                  turned away, which says nothing about the endpoint for others.
// `body` is undefined when the probe cannot show it; the code then decides.
export function classify(code, body, { expectedStatusCodes, requireText } = {}) {
  const expected =
    Array.isArray(expectedStatusCodes) && expectedStatusCodes.length ? expectedStatusCodes : [200];
  if (!Number.isInteger(code)) return "fail";
  if (REDIRECTS.has(code)) return "pass";
  if (expected.includes(code)) {
    if (requireText && typeof body === "string" && !body.includes(requireText)) return "fail";
    return "pass";
  }
  return code >= 500 ? "fail" : "inconclusive";
}

// Turns what the probes saw into a verdict. `complete` says every probe has
// reported; without it nothing can be called down.
export function verdictOf(seen, complete = true) {
  const passed = seen.filter((s) => s.state === "pass");
  const failed = seen.filter((s) => s.state === "fail");
  const detail = `${passed.length} of ${seen.length} other networks got the expected answer`;
  if (passed.length > 0) return { verdict: "up", code: passed[0].code || 200, detail };
  if (complete && failed.length >= 2) return { verdict: "down", code: 0, detail };
  return { verdict: "unknown", code: 0, detail: `${detail}; not enough of them could tell` };
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

function unknown(detail) {
  return { verdict: "unknown", code: 0, detail };
}

async function askGlobalping(url, criteria, { fetchImpl, sleep, now }) {
  const created = await request(fetchImpl, GLOBALPING, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(measurementFor(url)),
  });
  if (created.status !== 202 || !created.data || !created.data.id) {
    return unknown(`the first probe network answered ${created.status}`);
  }
  const read = (results) =>
    (Array.isArray(results) ? results : [])
      .map((entry) => (entry && entry.result) || {})
      .filter((r) => r.status === "finished" || r.status === "failed")
      .map((r) => {
        const code = r.status === "finished" && Number.isInteger(r.statusCode) ? r.statusCode : null;
        return { state: classify(code, typeof r.rawBody === "string" ? r.rawBody : undefined, criteria), code };
      });
  const deadline = now() + WAIT_MS;
  let last = null;
  while (now() < deadline) {
    await sleep(POLL_MS);
    const got = await request(fetchImpl, `${GLOBALPING}/${encodeURIComponent(created.data.id)}`);
    if (got.status !== 200 || !got.data) continue;
    last = got.data;
    if (last.status === "finished") return verdictOf(read(last.results), true);
    // One expected answer settles it; no need to wait for the rest.
    const early = verdictOf(read(last.results), false);
    if (early.verdict === "up") return early;
  }
  // Out of time: an answer that already arrived still counts, a missing one
  // proves nothing.
  return verdictOf(read(last ? last.results : []), false);
}

async function askCheckHost(url, criteria, { fetchImpl, sleep, now }) {
  const query = new URLSearchParams({ host: url });
  for (const node of BACKUP_NODES) query.append("node", node);
  const created = await request(fetchImpl, `${CHECK_HOST}/check-http?${query}`);
  const id = created.data && created.data.request_id;
  const nodes = Object.keys((created.data && created.data.nodes) || {});
  if (created.status !== 200 || !id || nodes.length < 2) {
    return unknown(`the second probe network answered ${created.status}`);
  }
  // Each node reports [[ok, seconds, message, "code" or null, address or null]],
  // or null while it is still working.
  const read = (data) => {
    const seen = [];
    let pending = 0;
    for (const node of nodes) {
      const row = data && Array.isArray(data[node]) ? data[node][0] : null;
      if (!Array.isArray(row)) {
        pending += 1;
        continue;
      }
      const code = row[3] == null ? null : Number(row[3]);
      seen.push({ state: classify(Number.isInteger(code) ? code : null, undefined, criteria), code });
    }
    return { seen, pending };
  };
  const deadline = now() + WAIT_MS;
  let last = { seen: [], pending: nodes.length };
  while (now() < deadline) {
    await sleep(POLL_MS);
    const got = await request(fetchImpl, `${CHECK_HOST}/check-result/${encodeURIComponent(id)}`);
    if (got.status !== 200 || !got.data) continue;
    last = read(got.data);
    if (last.pending === 0) return verdictOf(last.seen, true);
    // One expected answer settles it; no need to wait for the rest.
    const early = verdictOf(last.seen, false);
    if (early.verdict === "up") return early;
  }
  return verdictOf(last.seen, false);
}

// Asks other networks for `url`. Never throws: anything that goes wrong on the
// way is "unknown".
export async function secondOpinion(url, criteria = {}, deps = {}) {
  const tools = {
    fetchImpl: deps.fetchImpl || fetch,
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now || Date.now,
  };
  const details = [];
  for (const ask of [askGlobalping, askCheckHost]) {
    try {
      const answer = await ask(url, criteria, tools);
      if (answer.verdict !== "unknown") return answer;
      details.push(answer.detail);
    } catch (err) {
      details.push(`a probe network could not be asked (${(err && err.name) || "error"})`);
    }
  }
  return unknown(details.join("; "));
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
// cannot connect AND other networks cannot either. When nobody can be asked,
// nothing is confirmed: the next run asks again.
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
  if (opinion.verdict === "down") {
    return { confirmed: true, why: `other networks cannot reach it either (${opinion.detail})` };
  }
  return {
    confirmed: false,
    why:
      opinion.verdict === "up"
        ? `other networks reach it (${opinion.detail})`
        : `no other network could tell (${opinion.detail})`,
  };
}

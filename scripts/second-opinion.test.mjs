// npm test
// No network: both probe networks and the direct check are replaced by fakes.
import test from "node:test";
import assert from "node:assert/strict";
import { classify, confirmDown, measurementFor, secondOpinion, verdictOf } from "./second-opinion.mjs";

const READY = { expectedStatusCodes: [200], requireText: '"status":"ok"' };
const pass = (code = 200) => ({ state: "pass", code });
const fail = () => ({ state: "fail", code: null });
const turnedAway = () => ({ state: "inconclusive", code: 403 });

test("the measurement carries the host, port, path and query of the URL", () => {
  const m = measurementFor("https://api.example.com/readyz?since=1700000000");
  assert.equal(m.type, "http");
  assert.equal(m.target, "api.example.com");
  assert.deepEqual(m.measurementOptions, {
    protocol: "HTTPS",
    port: 443,
    request: { method: "GET", path: "/readyz", query: "since=1700000000" },
  });
  const plain = measurementFor("http://example.com:8080");
  assert.equal(plain.measurementOptions.protocol, "HTTP");
  assert.equal(plain.measurementOptions.port, 8080);
  assert.deepEqual(plain.measurementOptions.request, { method: "GET", path: "/" });
});

test("what one probe saw", () => {
  assert.equal(classify(200, '{"status":"ok"}', READY), "pass");
  // The right code without the body marker is the endpoint answering wrongly.
  assert.equal(classify(200, "<html>", READY), "fail");
  // A probe that cannot show the body is judged on the code.
  assert.equal(classify(200, undefined, READY), "pass");
  assert.equal(classify(307, undefined, { expectedStatusCodes: [200] }), "pass");
  assert.equal(classify(null, undefined, READY), "fail");
  assert.equal(classify(503, '{"status":"degraded"}', READY), "fail");
  // Turned away: says nothing about the endpoint for everyone else.
  assert.equal(classify(403, undefined, READY), "inconclusive");
  assert.equal(classify(429, undefined, READY), "inconclusive");
});

test("one network getting the expected answer is enough for up", () => {
  const verdict = verdictOf([fail(), pass(200), fail()]);
  assert.equal(verdict.verdict, "up");
  assert.equal(verdict.code, 200);
  // Even before the others have reported.
  assert.equal(verdictOf([pass(200)], false).verdict, "up");
});

test("down needs every probe to have reported, and at least two to fail", () => {
  assert.equal(verdictOf([fail(), fail(), fail()]).verdict, "down");
  assert.equal(verdictOf([fail(), fail(), turnedAway()]).verdict, "down");
});

test("too little evidence is unknown, never down", () => {
  assert.equal(verdictOf([fail()]).verdict, "unknown");
  assert.equal(verdictOf([]).verdict, "unknown");
  assert.equal(verdictOf([fail(), fail()], false).verdict, "unknown");
  assert.equal(verdictOf([turnedAway(), turnedAway(), turnedAway()]).verdict, "unknown");
  assert.equal(verdictOf([fail(), turnedAway(), turnedAway()]).verdict, "unknown");
});

// A fake internet: each probe network answers from its own list of replies.
function fakeNetworks({ first = [], second = [] }) {
  const calls = { first: 0, second: 0 };
  const fetchImpl = async (url) => {
    const which = String(url).includes("check-host.net") ? "second" : "first";
    calls[which] += 1;
    const step = (which === "first" ? first : second).shift();
    if (!step) throw new Error("no more answers");
    if (step.throws) throw step.throws;
    return { status: step.status, json: async () => step.body };
  };
  return { fetchImpl, calls };
}

const quick = { sleep: async () => {} };
const gpFinished = (...results) => ({ status: 200, body: { status: "finished", results } });
const gpProbe = (statusCode, rawBody = "") => ({ result: { status: "finished", statusCode, rawBody } });
const gpDead = () => ({ result: { status: "failed", statusCode: null } });
const chCreated = {
  status: 200,
  body: { ok: 1, request_id: "r1", nodes: { "us1.node.check-host.net": [], "us5.node.check-host.net": [], "de4.node.check-host.net": [] } },
};
const chResult = (a, b, c) => ({
  status: 200,
  body: { "us1.node.check-host.net": a, "us5.node.check-host.net": b, "de4.node.check-host.net": c },
});
const chOk = [[1, 0.2, "OK", "200", "203.0.113.1"]];
const chDead = [[0, 3.0, "Connection timed out", null, null]];

test("the first network answers: the second is not asked", async () => {
  const net = fakeNetworks({
    first: [{ status: 202, body: { id: "abc" } }, gpFinished(gpProbe(200, '{"status":"ok"}'), gpDead())],
  });
  const out = await secondOpinion("https://api.example.com/readyz", READY, { ...quick, fetchImpl: net.fetchImpl });
  assert.equal(out.verdict, "up");
  assert.equal(net.calls.second, 0);
});

test("the first network confirms a down", async () => {
  const net = fakeNetworks({
    first: [{ status: 202, body: { id: "abc" } }, gpFinished(gpDead(), gpDead(), gpDead())],
  });
  const out = await secondOpinion("https://api.example.com/readyz", READY, { ...quick, fetchImpl: net.fetchImpl });
  assert.equal(out.verdict, "down");
  assert.equal(net.calls.second, 0);
});

test("the first network cannot be asked: the second decides", async () => {
  const up = fakeNetworks({ first: [{ status: 429, body: {} }], second: [chCreated, chResult(chOk, chDead, null)] });
  assert.equal(
    (await secondOpinion("https://api.example.com/", {}, { ...quick, fetchImpl: up.fetchImpl })).verdict,
    "up"
  );
  const down = fakeNetworks({
    first: [{ throws: new Error("offline") }],
    second: [chCreated, chResult(chDead, null, null), chResult(chDead, chDead, chDead)],
  });
  assert.equal(
    (await secondOpinion("https://api.example.com/", {}, { ...quick, fetchImpl: down.fetchImpl })).verdict,
    "down"
  );
});

test("nobody can be asked: unknown", async () => {
  const net = fakeNetworks({ first: [{ status: 429, body: {} }], second: [{ status: 503, body: null }] });
  const out = await secondOpinion("https://api.example.com/", {}, { ...quick, fetchImpl: net.fetchImpl });
  assert.equal(out.verdict, "unknown");
  const broken = fakeNetworks({ first: [{ throws: new Error("offline") }], second: [{ throws: new Error("offline") }] });
  assert.equal(
    (await secondOpinion("https://api.example.com/", {}, { ...quick, fetchImpl: broken.fetchImpl })).verdict,
    "unknown"
  );
});

test("a measurement that never finishes is unknown", async () => {
  let clock = 0;
  const pendingForever = Array.from({ length: 60 }, () => ({
    status: 200,
    body: { status: "in-progress", results: [{ result: { status: "in-progress" } }] },
  }));
  const net = fakeNetworks({
    first: [{ status: 202, body: { id: "slow" } }, ...pendingForever],
    second: [{ status: 500, body: null }],
  });
  const out = await secondOpinion("https://api.example.com/", {}, {
    fetchImpl: net.fetchImpl,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  assert.equal(out.verdict, "unknown");
});

const SITE = { name: "Example", url: "https://example.com/health", expectedStatusCodes: [200] };
const never = async () => {
  throw new Error("must not be asked");
};
const noConnection = async () => ({ answered: false, ok: false, code: 0 });

test("a recorded HTTP code is the endpoint's own answer: confirmed without asking anyone", async () => {
  const out = await confirmDown(SITE, 503, { directCheck: never, secondOpinion: never });
  assert.equal(out.confirmed, true);
});

test("a connection failure that is over is not confirmed", async () => {
  const out = await confirmDown(SITE, 0, {
    directCheck: async () => ({ answered: true, ok: true, code: 200 }),
    secondOpinion: never,
  });
  assert.equal(out.confirmed, false);
});

test("a connection failure that became an error answer is confirmed", async () => {
  const out = await confirmDown(SITE, 0, {
    directCheck: async () => ({ answered: true, ok: false, code: 502 }),
    secondOpinion: never,
  });
  assert.equal(out.confirmed, true);
});

test("still no connection from here: only other networks can confirm it", async () => {
  const reached = await confirmDown(SITE, 0, {
    directCheck: noConnection,
    secondOpinion: async () => ({ verdict: "up", code: 200, detail: "2 of 3" }),
  });
  assert.equal(reached.confirmed, false);
  const unreached = await confirmDown(SITE, 0, {
    directCheck: noConnection,
    secondOpinion: async () => ({ verdict: "down", code: 0, detail: "0 of 3" }),
  });
  assert.equal(unreached.confirmed, true);
});

test("nobody to ask is never a confirmation", async () => {
  const nobody = await confirmDown(SITE, 0, {
    directCheck: noConnection,
    secondOpinion: async () => ({ verdict: "unknown", code: 0, detail: "rate limit" }),
  });
  assert.equal(nobody.confirmed, false);
});

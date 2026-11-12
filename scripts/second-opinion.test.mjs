// node --test scripts/
// No network: the probe network and the direct check are replaced by fakes.
import test from "node:test";
import assert from "node:assert/strict";
import { confirmDown, judge, measurementFor, secondOpinion } from "./second-opinion.mjs";

const answered = (statusCode, rawBody = "") => ({ result: { status: "finished", statusCode, rawBody } });
const unreachable = () => ({ result: { status: "failed", statusCode: null } });
const pending = () => ({ result: { status: "in-progress" } });
const READY = { expectedStatusCodes: [200], requireText: '"status":"ok"' };

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

test("one network getting the expected answer is enough for up", () => {
  const verdict = judge([unreachable(), answered(200, '{"status":"ok"}'), unreachable()], READY);
  assert.equal(verdict.verdict, "up");
  assert.equal(verdict.code, 200);
});

test("a redirect shows the endpoint answering", () => {
  assert.equal(judge([answered(307), answered(307)], { expectedStatusCodes: [200] }).verdict, "up");
});

test("down needs every network to have reported, and none to pass", () => {
  assert.equal(judge([unreachable(), unreachable(), unreachable()], READY).verdict, "down");
  assert.equal(judge([answered(503, '{"status":"degraded"}'), unreachable()], READY).verdict, "down");
  // The right code without the body marker is not a pass.
  assert.equal(judge([answered(200, "<html>"), answered(200, "<html>")], READY).verdict, "down");
});

test("too little evidence is unknown, never down", () => {
  assert.equal(judge([unreachable()], READY).verdict, "unknown");
  assert.equal(judge([], READY).verdict, "unknown");
  assert.equal(judge([unreachable(), unreachable(), pending()], READY, false).verdict, "unknown");
  assert.equal(judge(null, READY).verdict, "unknown");
});

test("an answer that arrived before time ran out still counts as up", () => {
  assert.equal(judge([answered(200, '{"status":"ok"}'), pending()], READY, false).verdict, "up");
});

function fakeNetwork(steps) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    const step = steps.shift();
    if (!step) throw new Error("no more answers");
    if (step.throws) throw step.throws;
    return { status: step.status, json: async () => step.body };
  };
  return { fetchImpl, calls };
}

const quick = { sleep: async () => {} };

test("asking the probe network: created, polled, judged", async () => {
  const net = fakeNetwork([
    { status: 202, body: { id: "abc" } },
    { status: 200, body: { status: "in-progress", results: [pending()] } },
    { status: 200, body: { status: "finished", results: [answered(200, '{"status":"ok"}'), unreachable()] } },
  ]);
  const out = await secondOpinion("https://api.example.com/readyz", READY, { ...quick, fetchImpl: net.fetchImpl });
  assert.equal(out.verdict, "up");
  assert.equal(net.calls[0].method, "POST");
  assert.match(net.calls[1].url, /\/abc$/);
});

test("a refused or failing probe network is unknown", async () => {
  const limited = fakeNetwork([{ status: 429, body: { error: {} } }]);
  assert.equal(
    (await secondOpinion("https://api.example.com/", {}, { ...quick, fetchImpl: limited.fetchImpl })).verdict,
    "unknown"
  );
  const broken = fakeNetwork([{ throws: new Error("offline") }]);
  assert.equal(
    (await secondOpinion("https://api.example.com/", {}, { ...quick, fetchImpl: broken.fetchImpl })).verdict,
    "unknown"
  );
});

test("a measurement that never finishes is unknown", async () => {
  let clock = 0;
  const net = fakeNetwork(
    [{ status: 202, body: { id: "slow" } }].concat(
      Array.from({ length: 50 }, () => ({ status: 200, body: { status: "in-progress", results: [pending(), pending()] } }))
    )
  );
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

test("still no connection from here: other networks decide", async () => {
  const noConnection = async () => ({ answered: false, ok: false, code: 0 });
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
  // Nobody to ask: the down stands, as it did before the second check existed.
  const nobody = await confirmDown(SITE, 0, {
    directCheck: noConnection,
    secondOpinion: async () => ({ verdict: "unknown", code: 0, detail: "rate limit" }),
  });
  assert.equal(nobody.confirmed, true);
});

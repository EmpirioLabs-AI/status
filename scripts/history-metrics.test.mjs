import test from "node:test";
import assert from "node:assert/strict";
import { checkSuccessPercent, componentMetrics, incidentHistory, incidentStatus, coverageStart, durationLabel, formatCheckPercent,
  validateIncidentComponents } from "./history-metrics.mjs";

const buckets = [
  { date: "2026-10-21", status: "none", checks: 0 },
  { date: "2026-10-22", status: "up", checks: 30, ok: 30, down: 0 },
];
const outage = { number: 70, components: ["account-sign-in", "dashboard"], state: "CLOSED",
  createdAt: "2026-10-22T10:25:00Z", closedAt: "2026-10-22T18:36:00Z" };
const now = Date.parse("2026-10-23T01:00:00Z");

test("a missed sign-in outage colors the day without fabricating failed probes", () => {
  const annotated = incidentHistory(buckets, [outage], "account-sign-in", now);
  assert.equal(annotated[1].status, "degraded");
  assert.equal(annotated[1].incidentSeconds, 491 * 60);
  assert.equal(durationLabel(annotated[1].incidentSeconds), "8h 11m");
  assert.equal(annotated[1].checks, 30);
  assert.equal(annotated[1].down, 0);
  assert.equal(checkSuccessPercent(annotated), 100);
  assert.equal(buckets[1].status, "up");
  assert.equal(annotated[0].status, "none");
  assert.equal(coverageStart(annotated), "2026-10-22");
});

test("an incident does not affect a component it did not interrupt", () => {
  assert.deepEqual(incidentHistory(buckets, [outage], "api", now), buckets);
});

test("an open confirmed incident overrides a blind green check only for its components", () => {
  const open = { ...outage, state: "OPEN" };
  assert.equal(incidentStatus("up", [open], "dashboard", now), "degraded");
  assert.equal(incidentStatus("down", [open], "dashboard", now), "down");
  assert.equal(incidentStatus("up", [open], "api", now), "up");
  assert.equal(incidentStatus("up", [outage], "dashboard", now), "up");
  assert.equal(incidentStatus("up", [open], "dashboard", Date.parse("2026-10-21T00:00:00Z")), "up");
});

test("overlapping incidents count the overlapping time only once", () => {
  const overlap = { ...outage, createdAt: "2026-10-22T18:00:00Z", closedAt: "2026-10-22T19:00:00Z" };
  assert.equal(incidentHistory(buckets, [outage, overlap], "dashboard", now)[1].incidentSeconds, 515 * 60);
});

test("cross-midnight incidents are clipped to each day and now", () => {
  const incident = { ...outage, state: "OPEN", createdAt: "2026-10-21T23:50:00Z" };
  const rows = incidentHistory(buckets, [incident], "dashboard", Date.parse("2026-10-22T00:10:00Z"));
  assert.equal(rows[0].incidentSeconds, 600);
  assert.equal(rows[1].incidentSeconds, 600);
  assert.equal(rows[0].checks, 0);
  assert.equal(rows[0].status, "degraded");
});

test("missing history has no percentage and no invented coverage", () => {
  assert.equal(checkSuccessPercent([buckets[0]]), null);
  assert.equal(coverageStart([buckets[0]]), null);
  assert.equal(checkSuccessPercent([{ checks: 5, down: 1 }]), 80);
  assert.equal(formatCheckPercent(99.999), "99.99%");
  assert.equal(formatCheckPercent(100), "100%");
});

test("a confirmed monitoring gap suppresses the uptime claim without rewriting the samples", () => {
  const missed = { ...outage, monitoringGap: true };
  const metrics = componentMetrics(buckets, [missed], "account-sign-in");
  assert.equal(metrics.uptimePercent, null);
  assert.equal(metrics.checkSuccessPercent, 100);
  assert.equal(metrics.monitoringGap, true);
  assert.equal(componentMetrics(buckets, [missed], "api").uptimePercent, 100);
});

test("missing components, unknown components and bad windows fail publication", () => {
  validateIncidentComponents([outage], ["account-sign-in", "dashboard"]);
  assert.throws(() => validateIncidentComponents([{ ...outage, components: [] }], ["dashboard"]));
  assert.throws(() => validateIncidentComponents([outage], ["api"]));
  assert.throws(() => validateIncidentComponents([{ ...outage, closedAt: outage.createdAt }], outage.components));
});

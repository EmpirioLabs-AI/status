// Probe samples and confirmed incidents are different evidence. Never turn a
// retrospective incident into invented probes or a continuous-uptime claim.
export function checkSuccessPercent(buckets) {
  const measured = buckets.filter((b) => b.checks > 0);
  const total = measured.reduce((n, b) => n + b.checks, 0);
  if (!total) return null;
  const failed = measured.reduce((n, b) => n + (typeof b.down === "number"
    ? b.down : b.status === "up" ? 0 : b.checks), 0);
  return 100 * (total - failed) / total;
}

function unionDuration(intervals) {
  let total = 0, end = -Infinity;
  for (const [start, stop] of intervals.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  return total;
}

export function incidentHistory(buckets, incidents, slug, now = Date.now()) {
  const relevant = incidents.filter((i) => i.components?.includes(slug));
  return buckets.map((bucket) => {
    const start = Date.parse(`${bucket.date}T00:00:00Z`);
    const end = Math.min(start + 86400000, now);
    const intervals = [];
    for (const incident of relevant) {
      const a = Math.max(start, Date.parse(incident.createdAt));
      const b = Math.min(end, incident.state === "OPEN" ? now : Date.parse(incident.closedAt));
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) intervals.push([a, b]);
    }
    const seconds = unionDuration(intervals) / 1000;
    if (!seconds) return { ...bucket };
    // A confirmed interruption is visible even if no probe covered its window.
    // It says nothing about the unobserved remainder of that day.
    return { ...bucket, status: bucket.status === "down" ? "down" : "degraded",
      incidentSeconds: seconds, incidentCount: intervals.length };
  });
}

export function coverageStart(buckets) {
  return buckets.find((b) => b.checks > 0)?.date || null;
}

export function componentMetrics(buckets, incidents, slug) {
  const checks = checkSuccessPercent(buckets);
  const gap = incidents.some((i) => i.monitoringGap && i.components?.includes(slug));
  return { uptimePercent: gap ? null : checks, checkSuccessPercent: checks,
    monitoringGap: gap, coverageStart: coverageStart(buckets) };
}

export function incidentStatus(observed, incidents, slug, now = Date.now()) {
  if (observed === "down") return observed;
  return incidents.some((i) => i.state === "OPEN" && i.components?.includes(slug) &&
    Date.parse(i.createdAt) <= now) ? "degraded" : observed;
}

export function durationLabel(seconds) {
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

export function formatCheckPercent(value) {
  if (value === null) return "No data";
  if (value === 100) return "100%";
  // A recorded failure must never round into a perfect result.
  return `${Math.min(value, 99.99).toFixed(2)}%`;
}

export function validateIncidentComponents(incidents, slugs) {
  const known = new Set(slugs);
  for (const incident of incidents) {
    if (!Array.isArray(incident.components) || !incident.components.length ||
        incident.components.some((slug) => !known.has(slug))) {
      throw new Error(`Incident #${incident.number} needs valid components in its status-incident metadata`);
    }
    const start = Date.parse(incident.createdAt);
    const end = incident.state === "OPEN" ? Infinity : Date.parse(incident.closedAt);
    if (!Number.isFinite(start) || !(end > start)) {
      throw new Error(`Incident #${incident.number} has an invalid incident window`);
    }
  }
}

#!/usr/bin/env node
// scripts/reconcile-incidents.mjs
// Opens, labels, assigns and closes the incident issue of each site, from the
// status Upptime recorded in history/<slug>.yml.
//
// Why incidents are opened here
// -----------------------------
// Upptime records a site as down when its own runner cannot connect to it,
// and that is sometimes the runner's network and not the site (2026-11-12: a
// runner timed out against two unrelated hosts for five minutes while both
// answered everyone else, and an incident opened for an outage that never
// happened). Upptime's token therefore cannot open issues any more (see
// .github/workflows/uptime.yml). This script opens the incident, and only once
// the down is confirmed: the site answered with an error, or it still cannot
// be reached from here and other networks cannot reach it either
// (scripts/second-opinion.mjs). A down that is not confirmed opens nothing and
// notifies nobody; the next check settles it.
//
// Notification
// ------------
// Assigning the issue is what reaches a person: the assignees from
// .upptimerc.yml are applied here.
//
// Older incidents
// ---------------
// An incident that something else opened is still picked up by its title: it
// gets its slug label, and assignees once it is confirmed, and duplicates are
// closed.
//
// The "status" label is deliberately NOT applied. build-site.mjs publishes
// every issue carrying it as a curated public incident on the status page
// (`loadIncidents`, label = "status"), and raw auto-opened issues are not
// written for that audience. Only the slug label is needed for the lookup.
//
// Usage: node scripts/reconcile-incidents.mjs [--dry-run]
// Requires: GITHUB_TOKEN (or GH_TOKEN) with issues: write, GITHUB_REPOSITORY.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { confirmDown } from "./second-opinion.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONFIG_FILE = join(ROOT, ".upptimerc.yml");
const HISTORY_DIR = join(ROOT, "history");

const DRY_RUN = process.argv.includes("--dry-run");
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const API = process.env.GITHUB_API_URL || "https://api.github.com";
const LABEL_COLOR = "ededed";

// Incidents are titled the way Upptime titles them, "<emoji> <name> is down"
// and "<emoji> <name> has degraded performance", so one it opened in the past
// is matched too. Match on the name and suffix, not the emoji.
const DOWN_SUFFIX = " is down";
const DEGRADED_SUFFIX = " has degraded performance";

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function loadConfig() {
  return yaml.load(readFileSync(CONFIG_FILE, "utf8")) || {};
}

// History files carry a trailing comment block after the YAML document.
// Returns the recorded status and the HTTP code that check saw (0: it could
// not connect).
function loadSiteHistory(slug) {
  const file = join(HISTORY_DIR, `${slug}.yml`);
  if (!existsSync(file)) return null;
  const doc = yaml.loadAll(readFileSync(file, "utf8"))[0];
  if (!doc || typeof doc.status !== "string") return null;
  return { status: doc.status, code: Number(doc.code) || 0 };
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${TOKEN}`,
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204 || res.status === 404) return { status: res.status, data: null };
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

async function listOpenIssues(owner, repo) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const { status, data } = await api(
      "GET",
      `/repos/${owner}/${repo}/issues?state=open&per_page=100&page=${page}`
    );
    if (status !== 200 || !Array.isArray(data)) {
      throw new Error(`listing open issues failed with HTTP ${status}`);
    }
    // The issues endpoint also returns pull requests.
    out.push(...data.filter((i) => !i.pull_request));
    if (data.length < 100) break;
  }
  return out;
}

async function ensureLabel(owner, repo, name) {
  const { status } = await api("GET", `/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`);
  if (status === 200) return;
  if (DRY_RUN) {
    console.log(`[reconcile] would create missing label "${name}"`);
    return;
  }
  const created = await api("POST", `/repos/${owner}/${repo}/labels`, {
    name,
    color: LABEL_COLOR,
  });
  // 422 means it already exists, which is fine.
  if (created.status !== 201 && created.status !== 422) {
    console.error(`[reconcile] could not create label "${name}" (HTTP ${created.status})`);
  }
}

async function unlock(owner, repo, number) {
  if (DRY_RUN) return;
  await api("DELETE", `/repos/${owner}/${repo}/issues/${number}/lock`);
}

async function comment(owner, repo, number, body) {
  if (DRY_RUN) return;
  await api("POST", `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
}

async function closeIssue(owner, repo, number) {
  if (DRY_RUN) return;
  const { status } = await api("PATCH", `/repos/${owner}/${repo}/issues/${number}`, {
    state: "closed",
    state_reason: "completed",
  });
  if (status !== 200) {
    throw new Error(`closing #${number} failed with HTTP ${status}`);
  }
}

async function applyLabel(owner, repo, number, label) {
  if (DRY_RUN) return;
  const { status } = await api("POST", `/repos/${owner}/${repo}/issues/${number}/labels`, {
    labels: [label],
  });
  if (status !== 200) {
    throw new Error(`labelling #${number} with "${label}" failed with HTTP ${status}`);
  }
}

// Opens the incident for a confirmed down, already labelled and assigned.
async function openIncident(owner, repo, site, slug, history, assignees) {
  const degraded = history.status === "degraded";
  const title = degraded
    ? `\u26a0\ufe0f ${site.name}${DEGRADED_SUFFIX}`
    : `\u{1f6d1} ${site.name}${DOWN_SUFFIX}`;
  const body = [
    `${site.name} (${site.url}) ${degraded ? "is answering slowly" : "is not passing its check"}.`,
    "",
    history.code ? `- HTTP code: ${history.code}` : "- No connection",
    "",
  ].join("\n");
  if (DRY_RUN) {
    console.log(`[reconcile] would open "${title}" for ${slug}`);
    return null;
  }
  const { status, data } = await api("POST", `/repos/${owner}/${repo}/issues`, {
    title,
    body,
    labels: [slug],
    assignees,
  });
  if (status !== 201 || !data) {
    throw new Error(`opening the incident for ${slug} failed with HTTP ${status}`);
  }
  return data.number;
}

async function applyAssignees(owner, repo, number, assignees) {
  if (!assignees.length || DRY_RUN) return;
  const { status } = await api("POST", `/repos/${owner}/${repo}/issues/${number}/assignees`, {
    assignees,
  });
  if (status !== 201) {
    console.error(`[reconcile] could not assign #${number} (HTTP ${status})`);
  }
}

async function main() {
  if (!TOKEN) throw new Error("GITHUB_TOKEN is required");
  const repository = process.env.GITHUB_REPOSITORY || "";
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY must be <owner>/<repo>");

  const config = loadConfig();
  const sites = Array.isArray(config.sites) ? config.sites : [];
  if (!sites.length) throw new Error("no sites configured in .upptimerc.yml");
  const assignees = Array.isArray(config.assignees) ? config.assignees : [];

  const issues = await listOpenIssues(owner, repo);
  console.log(`[reconcile] ${sites.length} sites, ${issues.length} open issues`);

  let closed = 0;
  let labelled = 0;
  let opened = 0;

  for (const site of sites) {
    const slug = site.slug || slugify(site.name);
    const history = loadSiteHistory(slug);
    if (history === null) {
      console.log(`[reconcile] ${slug}: no history file yet, skipping`);
      continue;
    }
    const status = history.status;

    // Newest first, so the survivor of a duplicate set is the most recent one.
    const incidents = issues
      .filter(
        (i) =>
          i.title.endsWith(`${site.name}${DOWN_SUFFIX}`) ||
          i.title.endsWith(`${site.name}${DEGRADED_SUFFIX}`)
      )
      .sort((a, b) => b.number - a.number);

    if (!incidents.length) {
      if (status === "up") {
        console.log(`[reconcile] ${slug}: up, no open incident`);
        continue;
      }
      // Recorded as failing and nothing open yet: open the incident, but only
      // for a down that is confirmed.
      const check = await confirmDown(site, history.code);
      if (!check.confirmed) {
        console.log(`[reconcile] ${slug}: ${status} on record, not confirmed (${check.why}); nothing opened`);
        continue;
      }
      await ensureLabel(owner, repo, slug);
      const number = await openIncident(owner, repo, site, slug, history, assignees);
      if (number) {
        opened += 1;
        console.log(`[reconcile] ${slug}: opened #${number} (${check.why}), assigned to ${assignees.join(", ")}`);
      }
      continue;
    }

    if (status === "up") {
      // The site is passing its checks, so nothing here should still be open.
      // Upptime cannot close these itself while the slug label is missing.
      for (const issue of incidents) {
        await unlock(owner, repo, issue.number);
        await comment(owner, repo, issue.number, "Checks for this endpoint are passing again.");
        await closeIssue(owner, repo, issue.number);
        closed += 1;
        console.log(`[reconcile] ${slug}: closed #${issue.number} (site is up)`);
      }
      continue;
    }

    // Still down or degraded: keep exactly one open incident, and make sure it
    // carries the label Upptime needs to find it again.
    const [survivor, ...duplicates] = incidents;
    await ensureLabel(owner, repo, slug);

    if (!survivor.labels.some((l) => l.name === slug)) {
      await applyLabel(owner, repo, survivor.number, slug);
      labelled += 1;
      console.log(`[reconcile] ${slug}: labelled #${survivor.number}`);
    }
    if (!survivor.assignees.length) {
      // Assigning is what notifies a person, so it waits for confirmation.
      const check = await confirmDown(site, history.code);
      if (check.confirmed) {
        await applyAssignees(owner, repo, survivor.number, assignees);
        console.log(`[reconcile] ${slug}: assigned #${survivor.number} to ${assignees.join(", ")} (${check.why})`);
      } else {
        console.log(`[reconcile] ${slug}: #${survivor.number} not confirmed (${check.why}); nobody assigned`);
      }
    }

    for (const issue of duplicates) {
      await unlock(owner, repo, issue.number);
      await comment(owner, repo, issue.number, `Superseded by #${survivor.number}.`);
      await closeIssue(owner, repo, issue.number);
      closed += 1;
      console.log(`[reconcile] ${slug}: closed duplicate #${issue.number}`);
    }
  }

  console.log(
    `[reconcile] done${DRY_RUN ? " (dry run)" : ""}: ${opened} opened, ${closed} closed, ${labelled} labelled`
  );
}

main().catch((err) => {
  console.error(`[reconcile] ${err && err.message ? err.message : err}`);
  process.exit(1);
});

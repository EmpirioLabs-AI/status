#!/usr/bin/env node
// scripts/reconcile-incidents.mjs
// Keeps Upptime's auto-opened incident issues in a state Upptime can actually
// find again, and makes sure a human is notified when one opens.
//
// Why this exists
// ---------------
// Upptime looks up the open incident for a site by its SLUG label:
//
//   update.ts: octokit.issues.listForRepo({ labels: slug, state: "open" })
//
// and it passes `labels: ["status", slug]` when it creates the issue. In this
// repo that label never lands: every auto-opened issue since #1 (2026-05-03)
// has `labels: []` and `assignees: []`, because `GH_PAT` can create an issue
// but cannot set labels or assignees on it (GitHub silently drops both for a
// token without repository write access). Two consequences, both observed:
//
//   1. The lookup returns nothing, so every down check opens ANOTHER duplicate
//      instead of reusing the open one.
//   2. The lookup returns nothing on recovery too, so the "site came back up"
//      branch never runs and the incident stays open forever. #46 sat open
//      from 2026-08-25 while history/website.yml read `status: up`.
//
// This script runs with the workflow's own GITHUB_TOKEN, which does have write
// access, so the labels and assignees it applies actually stick. Once an open
// incident carries its slug label, Upptime finds it again and its normal
// open/close lifecycle resumes unaided.
//
// Notification
// ------------
// The incidents are authored by the PAT owner's own account, and GitHub does
// not notify you about your own activity. Assigning the issue from a different
// actor (github-actions[bot]) is what actually reaches the assignee, so the
// assignees from .upptimerc.yml are applied here rather than left to Upptime.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONFIG_FILE = join(ROOT, ".upptimerc.yml");
const HISTORY_DIR = join(ROOT, "history");

const DRY_RUN = process.argv.includes("--dry-run");
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const API = process.env.GITHUB_API_URL || "https://api.github.com";
const LABEL_COLOR = "ededed";

// Upptime titles its auto-opened issues "<emoji> <name> is down" and
// "<emoji> <name> has degraded performance". The emoji is configurable, so
// match on the name and suffix instead of the prefix.
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
function loadSiteStatus(slug) {
  const file = join(HISTORY_DIR, `${slug}.yml`);
  if (!existsSync(file)) return null;
  const doc = yaml.loadAll(readFileSync(file, "utf8"))[0];
  return doc && typeof doc.status === "string" ? doc.status : null;
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

  for (const site of sites) {
    const slug = site.slug || slugify(site.name);
    const status = loadSiteStatus(slug);
    if (status === null) {
      console.log(`[reconcile] ${slug}: no history file yet, skipping`);
      continue;
    }

    // Newest first, so the survivor of a duplicate set is the most recent one.
    const incidents = issues
      .filter(
        (i) =>
          i.title.endsWith(`${site.name}${DOWN_SUFFIX}`) ||
          i.title.endsWith(`${site.name}${DEGRADED_SUFFIX}`)
      )
      .sort((a, b) => b.number - a.number);

    if (!incidents.length) {
      console.log(`[reconcile] ${slug}: ${status}, no open incident`);
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
      await applyAssignees(owner, repo, survivor.number, assignees);
      console.log(`[reconcile] ${slug}: assigned #${survivor.number} to ${assignees.join(", ")}`);
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
    `[reconcile] done${DRY_RUN ? " (dry run)" : ""}: ${closed} closed, ${labelled} labelled`
  );
}

main().catch((err) => {
  console.error(`[reconcile] ${err && err.message ? err.message : err}`);
  process.exit(1);
});

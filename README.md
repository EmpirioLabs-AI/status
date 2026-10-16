# EmpirioLabs AI - Status

Live status page for EmpirioLabs AI services.

- Live page: https://status.empiriolabs.ai
- Uptime checks run four times every five minutes.
- Incidents are auto-filed as issues in this repo with the `status` label.

## Past incidents

The status page renders past incidents from GitHub issues in this repo that
have the `status` label.

For incidents that are backfilled after the fact, add this hidden metadata
block to the issue body so the page renders the real incident window instead
of the GitHub issue creation time:

```markdown
<!-- status-incident
started_at: 2026-05-19T23:03:00Z
resolved_at: 2026-05-20T02:28:00Z
-->
```

Use only timestamps that are confirmed as the incident start and recovery
window. If a later message is just a follow-up confirmation, keep it in the
issue timeline but do not use it as `resolved_at`.

The status page shows the issue title, timing, duration, and the first
non-metadata paragraph from the issue body. Keep that first paragraph concise
and customer-safe.

If the issue body includes a `Timeline (<timezone>)` section with bullet items,
those items render as quiet timestamped notes inside the incident card, and the
timezone label is shown in the timeline heading. Keep timeline notes short and
customer-safe; full incident discussion still lives in the GitHub issue/comments.

## License

This repository is published in public form for operational
transparency only. It is not open-source and is not available for
forking, copying, modifying, or redistribution. See [LICENSE](./LICENSE)
for the full notice.

If you'd like to build something similar for your own services,
[Upptime](https://upptime.js.org/) is open-source and is what powers
the underlying GitHub Actions used here.

## Third-party components

The CI workflows invoke `upptime/uptime-monitor` as a GitHub Action
dependency (referenced by git-pinned hash, not bundled). The build
script depends on `js-yaml` via npm at runtime.

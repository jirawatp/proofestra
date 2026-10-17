# Project history and traceability

These versioned logs preserve how Proofestra's requirements, choices, and design
evolved. Current specifications remain the source for intended behavior. Logs are
concise project records, not private conversation transcripts or runtime logs.

| Record | Purpose |
| --- | --- |
| [Requirement log](requirements.md) | Scope changes, stable requirement/acceptance references, and supersession. |
| [Decision log](decisions.md) | Confirmed user choices, proposed engineering decisions, rationale, and status. |
| [Design log](design.md) | Architecture/interface/contract revisions and their evidence/limitations. |
| [Continuation checkpoint](../../CONTINUE.md) | Current state, reading order, next work, open choices, and portable resume prompt. |

## Recording changes

Use the next unused `RLOG-NNN`, `DLOG-NNN`, or `XLOG-NNN` ID in its own file.
Never renumber IDs or silently delete a historical entry. Dates use `YYYY-MM-DD`;
include a timezone only when the exact time matters and is known.

Each entry should say what changed, why, its status, affected requirement IDs and
documents, source revision/evidence, validation where relevant, and what it
supersedes. The initial entries were reconstructed from committed snapshots and
the confirmed project scope on 2026-10-17. Snapshot commit times are not asserted
to be the exact time a user confirmed a choice. Mark unconfirmed engineering
defaults and implementation gaps plainly.

For a changed decision, append a new entry that points back to the prior ID;
the later entry records the supersession. A historical entry may add a pointer
or correct an explicitly identified factual typo, but retain the original meaning
and describe substantive corrections in a new entry. Update current specs at the
same time so a new contributor does not have to reconstruct current behavior from
the log alone.

When writing an entry before its commit exists, reference the preceding source
revision and say that the change belongs to the containing commit. Git history
provides that commit's identity; avoid an impossible self-referential commit hash.
Later entries can link its exact revision. Use `git log --follow -- <path>` and
`git show <revision>:<path>` to inspect history. Reference files relatively so they
work on GitHub, a different machine, and in an offline clone.

## Baseline revisions

| Revision | Committed snapshot |
| --- | --- |
| [`c8a25fd`](https://github.com/jirawatp/proofestra/commit/c8a25fd201fad55f0f4ff017e9ddc77554c7d9e0) | Public Apache 2.0 project foundation and initial documentation. |
| [`f2d6863`](https://github.com/jirawatp/proofestra/commit/f2d6863c515d75136bb700d00d0062fc5a82ae9b) | Personal self-hosted MVP requirements, technical/API design, and interactive mockup. |
| [`0760660`](https://github.com/jirawatp/proofestra/commit/07606603baa30f6a4f79091c0cf11c06ad268d7e) | Same-provider identities and bounded nested subagents. |
| [`7a23553`](https://github.com/jirawatp/proofestra/commit/7a235536be0a8df835f2f897a07f5f436eef2bbe) | Extensible tools/backends, automatic scoped routing, configurable capacity, and all tool surfaces confirmed. |

The `codex/project-traceability` branch begins at `7a23553` and adds these logs,
the continuation checkpoint, and agent instructions. This is a documentation
checkpoint; it does not implement the proposed application or merge into main.

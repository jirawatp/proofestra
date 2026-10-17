# Decision change log

The current [decision register](../decisions.md) and [requirements](../requirements.md)
remain authoritative. This log preserves why the direction changed; the
[requirements log](requirements.md) tracks affected scope and acceptance scenarios.

Reconstructed on 17 October 2026 from committed snapshots in Git order. Dates
below are source commit dates, not exact confirmation times. A confirmed entry
reports what the source snapshot records as user-confirmed; proposed entries are
engineering/business choices awaiting validation. Same-date records do not imply
an invented sequence of chat timestamps. Requirement IDs are current trace links,
including retrospective mappings for the foundation.

| Log ID / snapshot date | Decision, status and reason | Source / consequence |
| --- | --- | --- |
| **DLOG-001** · 2026-10-17 | **Established direction:** full Apache 2.0 core and an open-source multi-model harness. **Proposed business strategy:** managed hosting, support and separately identified enterprise additions. Independent review should expose uncertainty rather than guarantee correctness. | Source: [c8a25fd]. Trace: DV-03, AG-03/06, EV-02; [business model](../business-model.md). The paid-service idea does not restrict core licensing or establish a paid product. |
| **DLOG-002** · 2026-10-17 | **Confirmed:** personal self-hosting, own keys and all three initial providers. **Proposed implementation:** TypeScript/React/Vite, Fastify/Node, SQLite, SSE, one active run, local history, server-side configuration and mock-first development. These choices keep the first implementation local and inspectable. | Source: [f2d6863]. Trace: UX-01–05, PR-01–03, PV-02–06, DV-01/02; [technical design](../technical-design.md). Its two/three-agent, one-model-per-provider and no-tool assumptions were later replaced by DLOG-003/004. Stack choice remains proposed, not installed or implemented. |
| **DLOG-003** · 2026-10-17 | **Confirmed expansion:** repeated-provider agents and subagents. **Proposed response:** make agent identity independent of provider/model; use root IDs for synthesis and harness-managed nested helpers with scoped context, reservations, deduplication and released waiting-parent slots. Child work is not an additional vote. | Source: [0760660]. Trace: AG-02–05/09–11, PR-02/05, CT-02/07; [agents](../agents.md). Supersedes DLOG-002's one-agent/model-per-provider simplification. Personal helper defaults remain configurable proposals; see DLOG-005. |
| **DLOG-004** · 2026-10-17 | **Confirmed expansion:** broad tool/provider coverage and all API, local SDK/CLI/app, function/MCP/executor and supported hosted-agent surfaces. **Proposed response:** extensible registries, backend-specific credentials/capabilities, lazy tool loading, and automatic compatible routing inside existing task grants. Provider-compatible syntax does not imply tool parity. | Source: [7a23553]. Trace: PR-01/02/06/07, TL-01–06; [tools](../tools.md), [provider capabilities](../provider-capabilities.md). Resolves the prior API-versus-SDK/CLI working assumption and supersedes the no-tools slice in DLOG-002/003. Stage integration after mocks/API tools; no session-token bridge or blanket CLI mode. |
| **DLOG-005** · 2026-10-17 | **Proposed supersession:** express six-root/tree limits as finite configurable deployment defaults, and replace universal model-call accounting with separate observable-request, observed-tool and native-job ledgers. Native internals may be unknown; strict policy rejects unenforceable required boundaries. Larger-team topology and review coverage need an explicit plan. | Source: [7a23553]. Trace: AG-02/05, CT-01/02/04/06/08; [scaling](../scaling.md). Refines DLOG-003's fixed-looking caps and shared invocation vocabulary. The small all-peer `2n+1` base formula and demo cap do not describe every execution graph. No exact spend, native stop or rollback guarantee follows. |
| **DLOG-006** · 2026-10-17 | **Proposed permission/evidence rules:** existing valid grants avoid redundant prompts; missing scope can receive an exact-action decision within frozen allowed routes. Helpers OFF prevents tool routing from creating managed children. Recheck revocation; broader provider/destination/allowlist choices require a new run. Retrieval and claim-support checks stay distinct. | Source: [7a23553]. Trace: AG-07, TL-01/03/04, EV-01/02, PV-01/02; acceptance A17–A20. Refines DLOG-004's automation boundary without granting model-driven permission changes. Preserve backend limitations and unverified support instead of equating tool success with truth. |

## DLOG-007 — Durable logs and a portable handoff

- **Date / status:** 2026-10-17; user-confirmed need for a new branch and traceable
  project records. Separate logs, stable IDs, repository-relative links, and a root
  continuation guide are the chosen documentation format.
- **Reason:** Another machine or agent should recover context from the repository,
  without a private chat transcript, local ZIP, or machine-specific preview URL.
- **Source / consequence:** User request; preceding baseline [7a23553]; delivered
  by the containing commit on `codex/project-traceability`. See
  [CONTINUE.md](../../CONTINUE.md), [history conventions](README.md), and RLOG-008
  in the [requirement log](requirements.md). Preserve canonical specs and append
  later changes with evidence/supersession references. This branch does not merge
  into main or implement the planned runtime.

## Updating this log

- Append the next unused `DLOG-NNN`; preserve existing IDs and historical status.
  Record the date, decision/rationale, confirmed or proposed status, source evidence,
  affected requirement IDs and superseded decision-log IDs.
- Change the current decision register alongside the log. A later reversal gets a
  new entry that cites the earlier one; factual corrections should be explicitly
  marked, not silently substituted.
- Cite a verified revision and relative canonical document links. A change in the
  containing commit can state that and cite its preceding baseline; Git history
  supplies its revision. Mark other uncommitted sources pending rather than
  predicting a hash.
- Distinguish documentation checks, mock tests, integration tests and measured
  results. User scope confirmation and readable provider docs are not proof of
  runtime compatibility, accuracy or permission enforcement.

[c8a25fd]: https://github.com/jirawatp/proofestra/commit/c8a25fd201fad55f0f4ff017e9ddc77554c7d9e0
[f2d6863]: https://github.com/jirawatp/proofestra/commit/f2d6863c515d75136bb700d00d0062fc5a82ae9b
[0760660]: https://github.com/jirawatp/proofestra/commit/07606603baa30f6a4f79091c0cf11c06ad268d7e
[7a23553]: https://github.com/jirawatp/proofestra/commit/7a235536be0a8df835f2f897a07f5f436eef2bbe

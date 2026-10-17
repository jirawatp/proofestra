# Requirements change log

Read the current [requirements](../requirements.md) for normative behavior and
[decisions](../decisions.md) for confirmed direction versus proposed defaults.
This log records changes, not another copy of the specification. See also the
[decision log](decisions.md).

These entries were reconstructed on 17 October 2026 from Git ancestry and the
cited committed snapshots. Dates are source commit dates, not exact times of user
confirmation. “Confirmed” means the snapshot records user-confirmed scope;
“proposed” means a design/default that still needs implementation and validation.
Current requirement IDs below also provide retrospective links where a foundation
snapshot predates those IDs. No entry claims a live implementation or measured accuracy.

| Log ID / snapshot date | Status and change | Trace / supersession |
| --- | --- | --- |
| **RLOG-001** · 2026-10-17 | **Established:** public Apache 2.0 project foundation. **Proposed:** friendly multi-model chat, independent review, uncertainty, history/export, self-hosting and bounded usage. Consensus is not a correctness guarantee. | Source: [c8a25fd], especially its README and architecture. Current trace: DV-03, AG-03/06, EV-02, PV-04. Its proposed two-provider live pilot was superseded by RLOG-002. |
| **RLOG-002** · 2026-10-17 | **Confirmed in snapshot:** personal single-user self-hosted app, own API keys, and OpenAI + Anthropic + Gemini together in the first live version. **Proposed initial slice:** Quick/Team, local history, frozen common context and no hidden trimming; mock first. Team was limited to two/three provider-selected agents and tools/retrieval were outside that slice. | Source: [f2d6863]. Trace: UX-01–05, AG-01–08, PR-01–05, PV-01–06, DV-01–03; acceptance A1–A12. Same-provider/team restrictions changed in RLOG-003; tool exclusions changed in RLOG-004; old limits changed in RLOG-005. |
| **RLOG-003** · 2026-10-17 | **Confirmed expansion:** multiple agents can share a provider/model or use different configured models; every provider's agents can request subagents. **Proposed mechanics:** distinct agent IDs, synthesis by root ID, nested harness helpers, inherited scope, root-draft barrier, deduplicated spawn/continuation, shared reservations and tree stop/restart. Quick helpers OFF and Team helpers ON were defaults. | Source: [0760660]. Trace: AG-02–05/09–11, PR-02/05, CT-02/07; A13–A16. Supersedes the provider-as-agent restriction in RLOG-002. Its fixed-looking six-root/tree bounds and universal invocation accounting were clarified by RLOG-005. |
| **RLOG-004** · 2026-10-17 | **Confirmed expansion:** broad providers/tools and automatic use of agent tools; the user confirmed all tool surfaces—built-in API tools, local apps/SDKs/CLIs, functions/MCP/local executors and supported hosted agents. **Proposed delivery:** capability registries with separate provider/profile/backend/agent identity, lazy relevant tool selection, and staged validation. Three core API adapters remain first; extra adapters and native/hosted integrations are candidates until tested. | Source: [7a23553]. Trace: PR-01/02/06/07, TL-01/02/05/06, NX-02. Supersedes earlier “tools later/outside scope” proposals in RLOG-002/003. It also resolves the earlier API-versus-SDK/CLI scope assumption; broad scope is not universal compatibility. |
| **RLOG-005** · 2026-10-17 | **Proposed clarification:** finite configurable deployment policy replaces product-wide-looking limits. Personal defaults include six roots, 32 observable harness provider requests, 64 observed tool operations and four native jobs. Native internal counts/tokens/cost can be unknown; one job is not one total model call. `2n+1` applies only to the small all-peer base plan. | Source: [7a23553]. Trace: AG-02/05, CT-01/02/04/06/08; A19/A20; [scaling](../scaling.md). Supersedes RLOG-002's initial nine-call/180-second/16,384-output-token Team defaults and RLOG-003's universal call accounting. The demo's six-entry editor is not a product ceiling. |
| **RLOG-006** · 2026-10-17 | **Proposed routing/permission rules:** tool selection is separate from grants. Covered reads, sandbox work and reversible workspace actions run without repeated approval. Managed helpers require helpers enabled, including tool-driven routing. Freeze route/tool/backend/profile/destination allowlists and initial grant references; recheck validity/revocation, and record exact-action approval only within allowed routes. Broader allowlists need a new configured run. | Source: [7a23553]. Trace: AG-07, TL-01/03/04/06, PV-01/02; A17/A18; [tool policy](../tools.md). Refines RLOG-003/004 without granting models authority or creating a blanket approval endpoint. Quick is exactly one request/no retry only with both tools and helpers OFF. |
| **RLOG-007** · 2026-10-17 | **Proposed evidence refinement:** distinguish an unretrieved model citation from tool/provider retrieval, and retrieval from a separate claim-support check. Native recursion, cancellation, scope and usage visibility must match validated backend capabilities; unsupported work is denied or uses an approved harness fallback. Accuracy guarantees remain excluded. | Source: [7a23553]. Trace: EV-01/02, AG-09, PR-06/07, CT-04/08; [evaluation](../evaluation.md), [provider capabilities](../provider-capabilities.md). Supersedes the earlier all-citations-unretrieved assumption, not the requirement to show uncertainty. |

## RLOG-008 — Repository-backed continuity

- **Date / status:** 2026-10-17; confirmed project-process request.
- **Change:** The user requested a new branch and decision, design, and requirement
  logs so work is traceable and easy to resume anywhere. `codex/project-traceability`
  adds these logs, a [history index](README.md), [continuation checkpoint](../../CONTINUE.md),
  and [agent instructions](../../AGENTS.md).
- **Trace / source:** User request; preceding design baseline [7a23553]. This entry
  is delivered in its containing commit. It changes project process, not a product
  requirement ID or runtime capability. Current requirements remain authoritative.
- **Evidence:** Source revisions and relative references are checked, and the
  published branch is verified from a fresh checkout before handoff.

## Updating this log

- Append the next unused `RLOG-NNN` in chronological recorded order; never renumber
  or reuse an ID. Keep the date and distinguish source-event evidence from the
  later time an entry was reconstructed.
- State changed scope, confirmed/proposed status, affected requirement IDs and
  acceptance scenarios, source revision/document, and any superseded log IDs.
- Update the canonical requirements first or with the same change. Preserve older
  records; append a correction/supersession instead of rewriting history. Do not
  invent quotes or confirmation times from commit dates.
- For a change delivered by the containing commit, say so and cite the preceding
  baseline; Git history supplies its revision. Other uncommitted sources are
  pending evidence. A design commit is not implementation/test evidence.

[c8a25fd]: https://github.com/jirawatp/proofestra/commit/c8a25fd201fad55f0f4ff017e9ddc77554c7d9e0
[f2d6863]: https://github.com/jirawatp/proofestra/commit/f2d6863c515d75136bb700d00d0062fc5a82ae9b
[0760660]: https://github.com/jirawatp/proofestra/commit/07606603baa30f6a4f79091c0cf11c06ad268d7e
[7a23553]: https://github.com/jirawatp/proofestra/commit/7a235536be0a8df835f2f897a07f5f436eef2bbe

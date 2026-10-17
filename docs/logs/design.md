# Design change log

Current designs: [architecture](../architecture.md),
[technical design](../technical-design.md), [experience](../experience.md),
[API](../api.md), and [OpenAPI](../openapi.yaml).
Use the [history conventions](README.md) for new `XLOG-NNN` entries. All entries
below are dated 2026-10-17; cited commits are saved snapshots, not claimed exact
times of discussion or production releases.

## XLOG-001 — Initial collaboration architecture

- **Date / status:** 2026-10-17; recorded foundation, implementation pending.
- **Change:** Established independent initial answers, comparison, evidence-aware
  review, synthesis, and explicit uncertainty as the intended product flow.
  Provider adapters, orchestration, storage/export, and verification belong to
  the Apache 2.0 core.
- **Reason:** Make cross-model review understandable without treating consensus
  as proof or requiring a commercial service.
- **Source:** [`c8a25fd`](https://github.com/jirawatp/proofestra/commit/c8a25fd201fad55f0f4ff017e9ddc77554c7d9e0).
- **Current references:** [architecture](../architecture.md),
  [business model](../business-model.md); AG-03/04/06, EV-01/02, DV-03.
- **Evidence / limitation:** Documentation foundation only; no runnable harness.
- **Followed by:** XLOG-002 makes the personal deployment and contract concrete.

## XLOG-002 — Personal application, local API, and interactive design

- **Date / status:** 2026-10-17; proposed implementation design and simulated interface.
- **Change:** Defined a single-user application with Quick/Team flows, persistent
  local history as a future feature, REST/SSE contract, run states, context
  admission, safe exports, and deterministic mock behavior. Proposed TypeScript,
  React/Vite, Fastify/Node, and SQLite. Added a dependency-free browser prototype.
- **Reason:** Provide a reviewable experience and a bounded first implementation
  milestone before paid provider integration.
- **Source:** [`f2d6863`](https://github.com/jirawatp/proofestra/commit/f2d6863c515d75136bb700d00d0062fc5a82ae9b).
- **Current references:** [experience](../experience.md),
  [technical design](../technical-design.md), [API](../api.md),
  [prototype](../prototype/index.html); UX-01–05, AG-01–08, PV-03–06, DV-01/02.
- **Evidence / limitation:** The prototype demonstrates presets in tab memory;
  the contract does not implement persistence, live endpoints, or provider calls.
  Package versions and database driver remain implementation choices.
- **Followed by:** XLOG-003 expands identity/delegation; XLOG-004 revises provider,
  tool, accounting, and capacity assumptions.

## XLOG-003 — Agent identity and bounded nested delegation

- **Date / status:** 2026-10-17; required design, simulated direct-child demonstration.
- **Change:** Separated provider/profile from agent ID, allowed repeated-provider
  roots, addressed synthesis by agent ID, and specified a managed parent/child
  tree. Added scoped context, shared quotas, parent waiting/resume, cancellation,
  and invocation-scoped spawn deduplication. A response batch gets one parent
  continuation; child results do not become extra peer votes.
- **Reason:** Let each provider's agents request helpers and let users configure
  several agents from the same provider without identity collisions or quota bypass.
- **Source:** [`0760660`](https://github.com/jirawatp/proofestra/commit/07606603baa30f6a4f79091c0cf11c06ad268d7e).
- **Current references:** [agents](../agents.md), [API](../api.md),
  [evaluation](../evaluation.md); AG-02/03/09–11, PR-05, CT-02/07, A13–A16.
- **Evidence / limitation:** Browser/design checks covered repeated identities,
  helper returns, synthesis selection, scheduling, cancellation, and exports.
  Arbitrary recursive/native runtimes and durable scheduling were not implemented.
- **Supersession:** XLOG-004 retains managed-tree semantics but replaces a universal
  model-call ceiling with scoped ledgers and makes personal defaults configurable.

## XLOG-004 — Extensible capability routing and native execution boundaries

- **Date / status:** 2026-10-17; expanded required design, compatibility unvalidated.
- **Change:** Added open provider IDs, versioned tool/backend capability registry,
  lazy tool selection, current-profile use or approved helper fallback, existing
  grants, exact-action missing-scope approval, and current grant revocation checks.
  All API/app/SDK/CLI/MCP/hosted tool surfaces are confirmed design scope.
  Approval controls must be inaccessible to agent-operated browsers/CLIs.
- **Reason:** Cover many tools and providers automatically while respecting actual
  compatibility, destinations, permissions, and observable resource boundaries.
- **Source:** [`7a23553`](https://github.com/jirawatp/proofestra/commit/7a235536be0a8df835f2f897a07f5f436eef2bbe).
- **Current references:** [tools](../tools.md),
  [provider capabilities](../provider-capabilities.md), [scaling](../scaling.md),
  [contract](../openapi.yaml); PR-01/06/07, TL-01–06, CT-01–08, EV-01, A17–A20.
- **Supersedes / preserves:** Replaces earlier fixed-looking capacity and complete
  call-accounting assumptions. Keeps distinct roots, the draft barrier, managed
  delegation, and selected synthesizer. Helpers-off cannot be bypassed by tools
  or opaque native jobs. Configurable limits do not imply unlimited capacity.
- **Accounting:** Separate observable harness requests, observed tool operations,
  native jobs, and nullable internal usage. Strict bounds reject incapable routes;
  explicit bounded-job admission does not invent an internal cap. Local Stop
  cannot undo completed external effects or prove a remote process stopped.
- **Evidence:** [Review record](../design-review.md) reports OpenAPI validation,
  15 embedded examples, 14 rejected schema cases, semantic fixtures, and browser
  checks. Tool samples were simulated. Official documentation research is dated;
  Orbit discovery returned 403 and official sources supplied the fallback.
- **Limitation:** No live adapter, agent tool, SDK/CLI job, paid evaluation, approval
  isolation implementation, or measured larger-team deployment has been validated.

## XLOG-005 — Portable project history and continuation checkpoint

- **Date / status:** 2026-10-17; documentation delivered by the containing commit.
- **Change:** Created branch `codex/project-traceability`, separate requirement,
  decision, and design logs, the [history index](README.md), root
  [CONTINUE.md](../../CONTINUE.md), and [AGENTS.md](../../AGENTS.md). Linked them
  from project/contribution entry points and kept these documentation logs tracked
  while excluding runtime logs.
- **Reason:** The user requested traceability and easy continuation from anywhere.
  A checked-out repository should carry decisions, present state, next work, and
  evidence without needing the original conversation or local machine.
- **Source:** User request on 2026-10-17; branch starts from `7a23553`. This entry
  belongs to its containing commit; Git history records that revision.
- **Affected scope:** Project process; no product requirement or runtime behavior
  is changed. Current specifications remain authoritative for intended behavior.
- **Validation:** Relative links/anchors, source revision references, whitespace,
  tracked-log exceptions, and a fresh branch checkout are checked for this handoff.
  Remote publication is verified before reporting completion; it is not a merge.
- **Next:** Resume from CONTINUE.md. Mock application/history/coordinator is the
  next proposed implementation milestone; live integrations remain later work.

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

## RLOG-009 — Shared skills, plugins and custom MCP

- **Date / status:** 2026-10-17; user-confirmed expansion to shared skills, plugins
  and custom MCP across connected providers. Catalog formats, broker mechanics and
  lifecycle controls below are proposed design, not installed integrations.
- **Change:** Add EX-01–EX-08 and A21–A25. One global/workspace harness catalog
  supplies progressively loaded versioned skills, trusted manifest bundles and
  brokered local STDIO/negotiated HTTP MCP. Namespaced logical IDs map through
  compatible provider adapters or an existing authorized helper when enabled;
  sharing does not require manual vendor-by-vendor copies or make exclusive
  hosted tools/vendor plugin formats universally compatible.
- **Boundaries:** Imports/skills grant no permission and execute no scripts by
  themselves. Pin immutable versions/digests, reject namespace/wire-name collisions,
  recheck current grants/enablement, and block disabled/revoked/removed/superseded
  definitions unless the pinned old version is explicitly retained enabled and
  authorized. Shared registration must preserve per-branch draft/tool-state
  isolation and central secret protection; Stop is not erasure or rollback.
- **Trace / source:** Current user request; preceding baseline [1374641]. This
  change belongs to its containing commit. See [requirements](../requirements.md),
  [extension policy](../extensions.md), [decisions](../decisions.md),
  [evaluation](../evaluation.md) and [roadmap](../roadmap.md). Extends RLOG-004/006/007
  without superseding their compatibility, grant, helper-policy or evidence limits.
- **Evidence:** Documentation/ID/link checks only; A21–A25 specify future mock
  acceptance. No skill/plugin installation, custom MCP connection, live execution
  or paid compatibility check has been performed for this change.

## RLOG-010 — Local v1 implementation acceptance

- **Date / status:** 2026-10-21; delivered by the uncommitted containing work on
  `codex/project-traceability`. Confirms the acceptance behaviours of the
  previously-only-designed requirements; mocks remain the default and no live
  provider call was made.
- **Change:** The local v1 implementation now satisfies the executable
  interpretations of a subset of the current requirement IDs. The subset is
  listed below with corrected mappings (the original 2026-10-21 entry
  misclassified several items — the mapping below supersedes it; see
  "Correction to RLOG-010 mapping" immediately after this entry).
  - **CT-01** (advertise + validate server-policy limits before dispatch):
    per-run `max_harness_invocations` and `total_output_tokens` enforced at
    admission; per-call `max_output_tokens_per_call` ceiling enforced at
    dispatch; overall + per-call hard timeout + output-token reservation
    advertised as the deployment policy.
  - **CT-02** (reserve observable provider requests and output before
    dispatch): admission-time infeasible-plan rejection via
    `base_planned_calls × max_output_tokens_per_call ≤ total_output_tokens`;
    per-call output-token reservations drained to the conservative ledger on
    settle.
  - **CT-04** (Stop prevents new harness work and attempts cancellation):
    cancellation CAS, terminal state is immutable, late adapter callbacks
    are discarded without mutating usage; `external_work_status` is set to
    `"unknown"` so remote stop is never implied as acknowledged.
  - **CT-05** (preserve usable partial results and distinguish terminal
    statuses; never invent a missing response): atomic terminal commit of
    snapshot + terminal event + final assistant message in one SQLite
    transaction; overall-deadline promotes to `partial` with
    `draft_fallback` when ≥1 draft succeeded; truncated upstream output
    downgrades to `partial`; terminal-step normalization collapses every
    non-terminal step / invocation to a terminal status in the same
    transaction.
  - **CT-06** (sticky-unknown provider-reported usage): the reported
    `input_tokens`/`output_tokens` aggregates become `null` once any
    dispatched invocation reports unknown and stay `null` for the rest of
    the run; a parallel conservative numeric `consumed_output_tokens`
    ledger charges the full reserve on ambiguous/missing outcomes.
  - **CT-07** (shared bounded scheduling, waiting parents release slots):
    per-provider + global concurrency bounds enforced by a serialized
    `globalActive` counter that releases on terminal settle even against
    an abort-ignoring adapter.
  - **PR-01** (first three live adapters): `openai_chat_completions`,
    `anthropic_messages_v1`, and `gemini_generate_content` adapters wired
    behind a normalized interface, with safe-non-negative-integer usage
    counters shared across all three.
  - **PR-02** (multi-profile per provider; backend separate from identity):
    JSON profile catalog in `src/core/profileConfig.ts` with content-addressed
    `catalog_version`; UI selects registered profiles/backends.
  - **PR-03** (start without provider calls or credentials): the server
    reads keys from env, never discovers models at boot, and never
    dispatches a provider request until the user Sends in live mode.
  - **PR-04** (normalize unavailable models / auth / rate-limit / timeout
    failures): adapter failures are mapped to a shared `NormalizedFailure`
    code vocabulary and surfaced via SSE without leaking upstream bodies.
  - **PV-02** (keep credentials server-side): keys read from env, never in
    the browser bundle, never in SSE events, never in persisted snapshots,
    never in exports — covered by an `sk-`-marker export-privacy
    regression.
  - **PV-03** (persist locally; no private chain-of-thought): SQLite
    `data/proofestra.sqlite`; Gemini `thought` text is never stored.
  - **PV-04** (export one conversation as versioned portable JSON without
    credentials or internal request headers): `GET
    /conversations/:id/export` covered by the privacy regression.
  - **PV-05** (reject deletion while a run is active): HTTP 409 while a run
    is non-terminal; succeeds after terminal — covered by `active-run
    guards and export privacy` regression.
  - **PV-06** (default to loopback-only access for this single-user
    release): Host + Origin allowlist with CSRF; public exposure requires
    separate design.
  - **EV-02** (use "team review completed" wording, never "verified
    answer"): UI copy and run presentation reflect this; synthesis
    instructions explicitly require preserving uncertainty.
  - **A1 / A2 / A5 / A6 / A7 / A9 / A10 / A13** acceptance scenarios have
    executable regressions in `tests/integration/acceptance.test.ts`
    (Quick, Team happy path, cancellation, partial, export, restart
    interruption, same-provider agents).

  Not addressed by v1: CT-03 (retry policy — v1 does not retry;
  deliberate), CT-08 (native-job accounting — v1 ships no native backend),
  EV-01 (retrieval-vs-support — v1 ships no retrieval tools), PV-01
  (pre-live disclosure UI — basic Live warning only), AG-07 / AG-09 /
  AG-10 / AG-11 (helper/delegation lifecycle — v1 rejects delegation at
  admission), TL-* (tool routing — v1 ships no tools), EX-* (extension
  lifecycle — v1 ships no extensions). These remain design-only.
- **Boundaries:** The implementation does NOT ship tool execution, delegation,
  SDK/CLI/app surfaces, native execution tracing, or paid runs. `tool_policy.mode`
  must be `"off"` and `delegation.enabled` must be `false` or the server returns
  422 at admission. Live mode remains gated behind `PROOFESTRA_LIVE_ENABLED=1`
  AND an explicit `execution_mode: "live"` per run.
- **Trace / source:** Current user request on 2026-10-21; preceding baseline
  [a96dedf]. See DLOG-009 in the [decision log](decisions.md), XLOG-007 in the
  [design log](design.md), and [design-review](../design-review.md).
- **Evidence:** 92 automated tests pass (`npx vitest run`): 25 unit, 13
  integration (fastify-inject against buildApp with deterministic mock
  fixtures), 54 adapter sanitization (3 providers × 4 arbitrary non-`sk-*`
  markers × 4 upstream behaviours — HTTP 400 with marker body, HTTP 500 with
  marker body, thrown network error with marker in `e.message`, non-JSON 200
  body — plus unknown enum / hidden-reasoning filters / contract shape).
  `npm audit --production=false` reports 0 vulnerabilities. `npm run build`
  produces `dist/public` + `dist/server`; `npm start` on port 3101 completes a
  Quick mock run with `input_tokens=115, output_tokens=120,
  consumed_output_tokens=120, reserved_output_tokens=0`.

### Correction to RLOG-010 mapping (2026-10-21)

The original 2026-10-21 RLOG-010 entry misclassified several of the current
requirement IDs. The corrected mapping above supersedes the original and is
in place of these specific incorrect claims:

- "CT-02 (per-provider + global concurrency)" → **CT-07** (shared bounded
  scheduling). CT-02 is about reservations, not concurrency.
- "CT-03 (overall + per-call hard timeout)" → **CT-01** (deadline/output
  limits advertised) + **CT-05** (bounded-deadline preserve-partial). CT-03
  is about retry policy, which v1 deliberately does not implement.
- "CT-05 (max_output_tokens_per_call + admission-time rejection)" → **CT-02**
  (reserve before dispatch) + **CT-01** (validate before dispatch). CT-05 is
  about preserving partial state and distinguishing terminal statuses, which
  the implementation also provides but through a different mechanism.
- "CT-08 (cancellation CAS)" → **CT-04** (Stop; attempt cancellation;
  preserve canceled state). CT-08 is about native-job accounting, and v1
  ships no native backend.
- "PV-04 (Last-Event-ID monotonic guards)" → implementation detail of
  **CT-05** (preserve state) and reliability engineering; PV-04 is about
  export. The SSE replay guards are listed under CT-05 above.
- "EV-01 (export skips in-progress runs)" → **PV-04** (export shape) +
  **PV-05** (reject delete while running) + **PV-02** (no credentials in
  export). EV-01 is about retrieval vs. claim support and v1 ships no
  retrieval tools.
- "PR-01/02/03 (atomic terminal commit)" → **CT-05** (preserve partial and
  distinguish terminal statuses). PR-01/02/03 are about adapters,
  multi-profile catalogs, and no-calls-on-start, which the v1 also
  implements and is listed under those IDs above.

Only the ID mapping is corrected; the behaviour claims in the original entry
are unchanged and are re-verified by the agent-run test suite listed under
RLOG-013. Preserved per the `docs/logs/README.md` history-preservation
policy; the original entry remains above as recorded.

## RLOG-011 — Local v1 acceptance pass: persistence, mock output, framing-aware context

- **Date:** 2026-10-21
- **Status:** Confirmed. Agent-run acceptance pass on top of RLOG-010 in
  response to a user requirement correction request. The behaviour fixes
  and the test coverage below were executed by the controlling Codex
  agent in this checkout; the user's role here was requesting the
  correction, not attesting to the test results.
- **Scope changes:**
  - Browser now persists only the selected `conversation_id` (UUID shape) to
    `localStorage['proofestra:selected-conversation-id:v1']`. On boot the id
    is restored only if the server still knows about it; a missing/deleted
    id is cleared silently and the UI falls through to the empty state.
    Nothing else is persisted client-side: no title, no prompt text, no run
    id, no provider identity, no credential. Extends CT-04 (reload recovery).
  - Mock adapter output is now concise and deterministic. Draft, review, and
    synthesis stages no longer echo the full reference material inline — the
    coordinator still passes the complete artifacts into each stage and the
    full per-step output remains inspectable in the run inspector, so the
    "preserve inspectable artifacts" requirement (CT-07) is unaffected.
    Simulated evidence, cross-draft disagreement, and uncertainty remain
    visible. The misleading `mock-fail-review` label/behaviour were made
    consistent: drafts and synthesis succeed, only review fails. Extends
    CT-07 (preserved uncertainty) and does not supersede it.
  - Context admission upper bound is now documented and framing-aware:
    `estimateTokens(text) = max(ceil(utf8_bytes/2), ceil(chars/4))` plus
    `TOKENS_PER_MESSAGE_FRAMING = 8` per message and
    `TOKENS_FOR_REPLY_FRAMING = 8` per reply. The derivation and the
    conservative-upper-bound property are written at the top of
    `src/core/context.ts`. `worstCaseReferenceTokens` returns a token count
    directly; the coordinator passes it via the new
    `referenceMaterialTokens` input so the admission check does not reify a
    synthetic string and double-charge byte/char overhead. Extends CT-03
    (per-profile capacity checks).
  - README now documents Node 22.19+, `npm ci`, `npm run dev`,
    `npm run build` + `npm start`, server-only env credentials, a profile
    JSON example with multiple same-provider models, mock-vs-live
    costs/privacy/limits, the exact set of checks CI would run, and the
    explicit scope exclusions (no helpers/tools/MCP/plugin execution; no
    correctness guarantee).
- **Boundaries:** No new provider surfaces or credentials added. No live
  provider call made. No commit, push, deploy, publish, or license change.
- **Trace / source:** Current user request on 2026-10-21; preceding
  implementation RLOG-010. See DLOG-010 in the [decision log](decisions.md)
  and XLOG-008 in the [design log](design.md).
- **Evidence:** 100 automated tests pass (`npx vitest run`): 33 unit (incl. 9
  new context/framing regressions covering ASCII, Thai, emoji,
  framing-dominant, and worst-case Team-3 synthesis), 13 integration, 54
  adapter sanitization. `npm audit --production=false` continues to report
  0 vulnerabilities. `npx eslint src tests --max-warnings 0`,
  `npx tsc -p tsconfig.server.json --noEmit`, and `npx tsc -p tsconfig.web.json
  --noEmit` all pass clean. Agent-run Fastify-inject QA on 2026-10-21
  confirmed infeasible-plan admission, Team-3 → 7 calls
  with selected second-root synthesis, idempotent replay yielding exactly
  one assistant message, abort-ignoring 5s hard timeout with sticky-unknown
  usage + conservative-ledger charge, and the next run succeeding (no
  stranded `globalActive`). Live-provider end-to-end tests are still out of
  scope at this checkpoint (`PROOFESTRA_LIVE_ENABLED=0` across validation).

## RLOG-012 — Terminal accounting, overall-deadline Partial, truncation signal, and broad acceptance regressions

- **Date:** 2026-10-21
- **Status:** Confirmed. Agent-run final acceptance pass on top of
  RLOG-011 in response to concrete user review findings. The behaviour
  fixes and the regression coverage below were executed by the
  controlling Codex agent in this checkout; the user's role here was
  requesting the fixes, not attesting to the test results. This log
  captures the behaviour fixes and the test coverage that locks them in.
- **Scope changes:**
  - **Terminal accounting (single-charge invariant).** `finalize()` is the
    sole owner of the "drain outstanding reservations into
    `consumed_output_tokens` and zero `reserved_output_tokens`" step. The
    late-callback branches in `runSingleStep` (success-after-terminal and
    failure-after-terminal) now return immediately without touching usage
    so late results cannot double-charge the ledger or push
    `reserved_output_tokens` negative. Extends CT-06 (honest unknown usage).
  - **Overall-deadline Partial fallback.** The overall-deadline guard no
    longer commits `failed` when useful work exists. If synthesis is
    already complete it commits `partial` with `team_synthesis`
    presentation; if ≥1 draft is complete it commits `partial` with
    `draft_fallback` presentation and the first successful draft as the
    final answer; only with no successful drafts does it fall back to
    `failed`. Extends CT-07 (preserved uncertainty / useful artifacts) and
    CT-05 (bounded deadlines).
  - **Truncated output as Partial.** When any step surfaces a finding whose
    text matches `/truncat/i` (OpenAI `finish_reason=length`, Anthropic
    `stop_reason=max_tokens`, Gemini `MAX_TOKENS`, or the new `truncated`
    mock fixture), the run is downgraded to `partial` with
    `reason="truncated_output"` and the limitation is echoed into
    `limitations[]`. Full completion is never implied for a truncated
    stage. Extends CT-07.
  - **Expanded mock fixture mechanism.** Profile fixtures gained
    `only_on_stage: "draft" | "review" | "synthesis"` so a scenario can be
    scoped to a single stage without touching source. A new `truncated`
    scenario mirrors a provider that stopped on `max_tokens`.
- **Boundaries:** No new credentials, no live calls, no publication, no
  commit, no license change. The user's Terminal 2 continues to run
  `PROOFESTRA_MOCK_LATENCY_MS=5000 npm run dev` for visible-cancellation
  verification; the current test harness does not script browser-level
  E2E.
- **Trace / source:** Current user request on 2026-10-21; preceding
  checkpoint RLOG-011. See DLOG-011 in the [decision log](decisions.md)
  and XLOG-009 in the [design log](design.md).
- **Evidence:** 119 automated tests pass (`npx vitest run`): 33 unit, 16
  new acceptance integration regressions, 13 prior integration tests, 57
  adapter sanitization tests. `npm audit --production=false` continues to
  report 0 vulnerabilities. `npx eslint src tests --max-warnings 0`,
  `npx tsc -p tsconfig.server.json --noEmit`, `npx tsc -p
  tsconfig.web.json --noEmit`, and `npm run build` all pass clean. The new
  acceptance file [`tests/integration/acceptance.test.ts`](../../tests/integration/acceptance.test.ts)
  covers: terminal-accounting non-double-charge after cancel + late
  callbacks; overall-deadline Partial fallback with surviving draft;
  Team-3 exact-7-calls happy path with selected synthesizer and single
  assistant message; per-provider concurrency cap; mixed known/unknown
  Team usage; review-only and synthesis-only partial failures; truncated
  provider output ≠ full completion; Host / Origin / CSRF rejection; SSE
  replay / terminal sequence / unique assistant message; restart
  interruption via `markInterruptedOnStartup`; active-run export/delete
  409 then success after terminal; export never surfaces API keys or
  injected secret markers (`sk-`, `AIza`, test-only marker). Agent-run
  Fastify-inject regression asserts cancel + repeat cancel + late-success
  callback leaves zero assistant messages for the canceled run.
  Browser-level Stop behaviour is covered by this agent-run regression,
  not by a user-attested manual Chrome session.

## RLOG-013 — Final robustness: safe counters, Gemini thinking, hydration, step normalization, shared startup settlement

- **Date:** 2026-10-21
- **Status:** Confirmed. Follow-up robustness pass on top of RLOG-012 after
  independent agent-run QA caught concrete bugs. No new user-visible
  features; only correctness fixes, test coverage, and documentation
  alignment.
- **Scope changes:**
  - **Safe non-negative integer validation across every provider usage
    counter.** `src/providers/_sanitize.ts` now exports `safeUsageCount`
    (uses `Number.isSafeInteger`, rejects negative, fractional, non-finite,
    unsafe-integer, and missing values) and `safeUsageSum` (detects
    overflow past `Number.MAX_SAFE_INTEGER`). All three adapters —
    `openai.ts`, `anthropic.ts`, `gemini.ts` — route every `prompt_tokens`
    / `completion_tokens` / `input_tokens` / `output_tokens` through this
    shared helper; invalid or missing values now return `null` so the
    conservative ledger charges the full reservation and the sticky-unknown
    aggregate becomes null. Extends CT-06 (sticky-unknown usage).
  - **Gemini thinking-token accounting.** `combineGeminiOutput` now
    returns `candidates + thoughts` when both counts are safe-nonneg
    integers; falls back to `totalTokenCount - promptTokenCount` only when
    all three counters are strictly valid and the derivation is
    non-negative; returns `null` (not a candidates-only "complete" count)
    when thoughts is absent / malformed and no valid total-prompt
    derivation exists. Fixtures cover candidate-only, malformed total,
    fractional / negative / unsafe counters, and overflowing sums. No
    thought text or signature is stored. Extends CT-06, PR-04.
  - **Hydration never deletes a stored older chat.** `src/web/App.tsx`
    now uses a lazy `useState(() => readSelectedConversationId())`
    initializer and gates the persistence effect on a `hydrated` flag so
    the first render's `null` cannot clobber the stored id. Validation of
    the stored id uses a direct `GET /api/v1/conversations/:id` call via
    the new `getConversation` client helper; only an HTTP 404 clears the
    selection, so a valid conversation on page 2+ of
    `listConversations()` is kept and spliced into the sidebar. Extends
    CT-05 (reload recovery).
  - **Context estimator honest wording.** `src/core/context.ts` header
    now says explicitly that the estimator is a conservative overestimate
    that CAN reject valid inputs, that there is NO mathematical guarantee
    for proprietary provider framing, and that the provider's own
    tokenizer / `countTokens` endpoint plus the provider's
    `context_too_large` error are the authoritative final checks. Floors
    changed from `bytes/2` + `chars/4` to the honest worst-case
    `bytes/1` + `chars/1`. Extends CT-01 (advertise limits honestly).
  - **Verified model IDs and v1 Gemini default.** `src/shared/config.ts`,
    `.env.example`, and `README.md` reference vendor-verified model IDs
    only: `gpt-5.6-terra`
    (https://developers.openai.com/api/docs/models/gpt-5.6-terra),
    `gpt-5.4-mini`
    (https://developers.openai.com/api/docs/models/gpt-5.4-mini),
    `claude-sonnet-5-5`
    (https://platform.claude.com/docs/en/models/overview), and
    `gemini-3.8-flash`
    (https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).
    Gemini default is `gemini-3.8-flash` because Google's docs restrict
    2.5 Flash to prior active users; env override preserved. The invented
    `gpt-5.1-reasoning` / `gpt-5.1-nano` example profiles were removed.
  - **README custom-profile example respects the UI default.** Example
    profile `max_output_tokens` is now ≥ 2048 so a Send with the UI's
    default reservation does not get rejected 422 at admission. The
    effective-ceiling behaviour (admission rejects when the profile ceiling
    is below the per-call reservation) is documented inline.
  - **Terminal-step normalization.** `finalize()` now normalizes every
    non-terminal step / invocation to a terminal status in the same SQLite
    transaction that commits the terminal snapshot and `run.terminal`
    event. Completed outputs and reported usage are preserved verbatim;
    `external_work_status` is moved toward `"unknown"` so remote stop is
    never implied as acknowledged. Fixes the regression where review /
    synthesis steps appeared "Running" / "Queued" forever on a canceled
    Team run even though the run itself had already committed Canceled.
    Extends CT-05 (preserve state, distinguish terminal statuses).
  - **Shared startup settlement.** `markInterruptedOnStartup()` now
    delegates to the same `settleRunAtTerminal()` helper as `finalize()`
    so a restart-interrupted run drains `reserved_output_tokens` into
    `consumed_output_tokens`, nulls the reported `input_tokens` /
    `output_tokens` aggregates (crashed invocations never reported final
    counts), normalizes every mid-flight step / invocation, emits one
    ordered `run.terminal` event, and persists atomically. Idempotent on
    repeat startup via the `isTerminal` CAS: a second pass is a no-op and
    does not re-emit the event or re-drain the ledger. No resume or
    dispatch is attempted. Extends CT-05 (preserve state) and reliability
    engineering.
  - **Package engines aligned.** `package.json` engines pinned to
    `>=22.19.0 <24` to match `.nvmrc`, undici 8.x's `>=22.19` requirement,
    and the README's documented Node version.
  - **`/data-prod/` excluded.** Added to `.gitignore` as a targeted
    exclusion for the end-to-end smoke-test fixture directory; the
    directory itself and the user's `/data/` dev DB are preserved.
  - **Strengthened synthesis prompt (EV-01 clarification).**
    `SYNTH_INSTRUCTIONS` in `src/core/coordinator.ts` now requires every
    substantive claim to be accompanied by the sentence "no external
    verification in this run" — ALWAYS, including when an agent cited a
    URL — because this v1 ships no retrieval/support-checker and never
    fetched any cited page. The prompt explicitly forbids presenting peer
    agreement as evidence of truth. Supersedes RLOG-012's narrower
    synthesis wording. Documented in `docs/evaluation.md` under the
    EV-01 clarification block.
  - **RLOG-010 ID mapping corrected in place** per the
    "Correction to RLOG-010 mapping" subsection above. The behaviour
    claims are unchanged; the ID vocabulary now matches the current
    `docs/requirements.md`.
- **Attribution.** Browser-level Chrome observations in prior RLOG entries
  that read "confirmed by the user" have been retitled to "agent-run
  Fastify-inject regression". The server-side invariants being asserted
  (no assistant message for a canceled run; terminal-step normalization;
  late callback immutability) are checked by agent-run regressions in
  `tests/integration/acceptance.test.ts` and are not user-attested manual
  sessions.
- **Boundaries.** No live calls, no new credentials, no commit / push /
  merge / deploy / publish / license change. The user has independently
  verified the test matrix below from their own shell.
- **Trace / source:** Current user requests on 2026-10-21 (final
  robustness; terminal normalization; startup settlement; attribution
  correction; EV-01 synthesis clarification). Preceding checkpoint
  RLOG-012. See DLOG-012 in the [decision log](decisions.md) and XLOG-010
  in the [design log](design.md).
- **Evidence (agent-run; all observations below executed by the
  controlling Codex agent in this checkout, not by a human user):**
  - **127 automated tests pass** (`npx vitest run`) across 8 test files:
    `tests/unit/{context,ids,limits,schema}.test.ts` (33 unit tests),
    `tests/adapters/sanitize.test.ts` (62 adapter contract tests),
    `tests/integration/{acceptance,coordinator}.test.ts` + prior
    integration (32 integration tests). The acceptance file covers
    terminal-accounting non-double-charge after cancel + late callbacks;
    overall-deadline Partial fallback with surviving draft; Team-3
    exact-7-calls happy path; per-provider concurrency cap; mixed
    known/unknown Team usage; review-only and synthesis-only partial
    failures; truncated provider output ≠ full completion; Host / Origin
    / CSRF rejection; SSE replay / terminal sequence / unique assistant;
    restart-interruption shared settlement (reservation drain,
    sticky-unknown nulling, step normalization, ordered atomic terminal
    event, idempotent on repeat startup, no resume/dispatch);
    active-run export/delete 409 then success after terminal; export
    privacy against `sk-` / `AIza` / injected markers; Team cancel step
    normalization; hydration via direct `GET /conversations/:id` with
    404-only deletion.
  - `npx eslint src tests --max-warnings 0` — clean.
  - `npx tsc -p tsconfig.server.json --noEmit` — clean.
  - `npx tsc -p tsconfig.web.json --noEmit` — clean.
  - `npm audit --include=dev` — 0 vulnerabilities across prod (77) + dev
    (269) + optional (53) dependencies.
  - `npm run build` — `dist/public` (167.43 KiB JS gzipped 54.31 KiB,
    10.99 KiB CSS gzipped 3.18 KiB) + `dist/server` built clean.
  - `git diff --check` — clean (one earlier trailing blank line in
    `docs/logs/design.md` was fixed as part of this pass).
  - Agent-run Fastify-inject + localhost-socket QA on 2026-10-21: 5s live
    SSE through terminal event IDs 1..5 over a real socket; `Last-Event-ID`
    strict > cursor replays matching events; caught-up returns 204;
    future value returns 400; bad `Host` → 403; missing session → 401;
    missing / bad `Origin` → 403; bad `X-CSRF-Token` → 403; hydration
    `GET /conversations/:id` 200 for stored id and 404 for confirmed
    deletion; cancel path leaves zero assistant messages.
- **Live-provider end-to-end tests remain unverified** at this
  checkpoint (`PROOFESTRA_LIVE_ENABLED=0` across all validation).

## RLOG-014 — Attribution correction and production socket re-check

- **Date:** 2026-10-21
- **Status:** Confirmed. Documentation-only pass: no runtime source changed.
- **Scope changes:**
  - **Attribution corrected across logs and specs.** All QA observations
    that earlier RLOG / XLOG / design-review entries attributed to the
    human user ("the user confirmed", "user-attested manual Chrome
    session", "the user has run their own …", "User-driven acceptance
    pass", "Independent Fastify-inject QA reported by the user", etc.)
    have been reattributed to the controlling Codex agent, which actually
    executed those checks in this checkout. Preserved: all historical
    user-confirmed REQUIREMENT scope (RLOG-001 through RLOG-004 and the
    tool-surface, extension, and product-direction confirmations in
    `docs/requirements.md`, `docs/decisions.md`, `docs/design-review.md`,
    `docs/roadmap.md`, `docs/provider-capabilities.md`, `docs/tools.md`,
    and `docs/logs/decisions.md`); only QA-attestation phrasing was
    changed.
  - **Production socket re-check recorded.** Agent-run verification
    against a live `npm start` process on `127.0.0.1:3000` with the
    normal 50 ms mock latency: a Team-of-3 Quick + Team flow completed
    in 7 calls (3 drafts + 3 reviews + 1 selected-synth) with the
    expected artifacts, selected synthesizer, and sticky-unknown usage
    ledger; a fresh SSE stream delivered terminal event IDs in order;
    `Last-Event-ID` strict-greater returned matching events; caught-up
    returned 204; a future `Last-Event-ID` returned 400; bad `Host`
    returned 403; missing session cookie returned 401; cross-origin
    `Origin` returned 403; bad `X-CSRF-Token` returned 403. These were
    executed by the controlling Codex agent in this checkout and are
    not user confirmation.
  - **SECURITY.md "data/ SQLite … only place implementation runs"
    corrected.** The implementation source lives in-tree under `src/`,
    `tests/`, `docs/`, and the top-level configuration files; the
    `data/` directory is a `.gitignore`-excluded generated local-state
    folder that the server creates at startup for its SQLite database
    (schema in `src/storage/migrations.ts`), not the implementation
    itself.
  - **CONTINUE.md uses repo-relative instructions only.** The hardcoded
    `/Users/<user>/...` absolute path in the uncommitted-v1 disclaimer
    was removed; instructions now reference "the existing local checkout
    where this file lives" and all commands run from the repository
    root. No change to the previously documented
    `git clone --branch codex/project-traceability …` future-state
    recipe.
- **Boundaries.** Documentation-only. No runtime source modified in this
  pass per user instruction. No commit / push / merge / deploy / publish /
  license change. The production `npm start` process the agent probed
  remains running in the user's owned terminal.
- **Trace / source:** User instruction on 2026-10-21 to correct
  attribution of agent-run QA, correct the SECURITY misstatement, remove
  the hardcoded machine path in CONTINUE, and record the production
  socket re-check. Preceding checkpoint RLOG-013.
- **Evidence:** Agent-run verification before and after this
  documentation-only pass: 127 automated tests pass across 8 test files
  (`npx vitest run`), lint and both TypeScript projects compile clean,
  `npm audit --include=dev` reports 0 vulnerabilities, `npm run build`
  succeeds, `git diff --check` is clean on the working tree. Production
  socket re-check at `127.0.0.1:3000` observed as described above.
- **Live-provider end-to-end tests remain unverified** at this
  checkpoint (`PROOFESTRA_LIVE_ENABLED=0` across all validation).

## RLOG-015 — First-class attachments scope (upload, store, native/extracted projection)

- **Date:** 2026-10-21
- **Status:** Confirmed scope; implementation landed in this uncommitted
  checkpoint on top of RLOG-014.
- **Scope changes:**
  - **File attachments are now in scope** for a personal single-user
    conversation. The composer accepts files via native picker, paste, and
    drag-drop; each file is uploaded to a signed-conversation blob store,
    sniffed for MIME, bounded by per-upload / per-store / per-count limits,
    and either routed to a provider's native modality or extracted to
    bounded text — depending on per-profile capability.
  - **Store-wide upload admission.** Upload is a single store-wide gate
    (concurrency 1, bounded waiting queue, 120 s per-upload deadline).
    Per-conversation gating is replaced because `max_store_bytes` is
    shared; parallel uploads to different conversations now cannot both
    snapshot the same free-byte count.
  - **Deferred `markReady` publication.** The attachment row flips to
    `ready` only after the full multipart body ends successfully. A trailing
    invalid part that occurs after a draft tab has already seen the row can
    no longer unlink bound bytes.
  - **Parser error classification.** Known @fastify/multipart / @fastify/busboy
    error codes (`FST_FILES_LIMIT`, `FST_REQ_FILE_TOO_LARGE`,
    `ERR_STREAM_PREMATURE_CLOSE`, `FST_PARTS_LIMIT`, `FST_FIELDS_LIMIT`,
    `FST_PROTO_VIOLATION`) now surface as 400 / 413, never 500. Independent
    agent-run realHTTP QA that previously produced two 500 upload_failed
    rows for malformed / extra-file input now records 4xx instead.
  - **Full-payload idempotency.** The pending-submit key is derived from
    the full admission payload (prompt + mode + execution_mode + ordered
    agents / profile / synth + ordered Ready-attachment refs), not from the
    prompt alone. Changing the mode or file set no longer collapses onto
    the previously pending submission.
  - **Native wire serialization is mandatory.** OpenAI ChatCompletions,
    Anthropic Messages, and Gemini v1beta `generateContent` now receive the
    attached bytes in each vendor's documented inline shape
    (`image_url` / `file`, `image` / `document` with `source.base64`, and
    `inlineData` respectively), per-stage and over full history. The Mock
    adapter never claims to analyze bytes.
- **Affected requirement IDs:**
  AT-01 (upload admission, size + count + MIME + traversal limits), AT-02
  (per-profile native / extracted routing with attachment-only fallback),
  AT-03 (bounded extraction with safe decoders and worker termination),
  AT-04 (immutable per-run projection into every draft / review /
  synthesis / followup), AT-05 (metadata-only export), PV-01 / PV-02 /
  PV-05 (no bytes / base64 / extracted text / paths in run JSON, SSE
  frames, snapshots, or exports), AG-02 / AG-05 (store-wide concurrency
  bound), UX-04 (single-assistant terminal commit survives attachment
  flows).
- **Supersedes / extends:** None superseded; extends RLOG-010 (project
  surface) with explicit file-upload scope. Preceding checkpoint RLOG-014.
- **Source / evidence:** Changes in the containing commit (preceding
  baseline `a96dedf`). Code: `src/server/routes/attachments.ts`,
  `src/core/attachments.ts`, `src/core/attachmentExtraction.ts`,
  `src/core/coordinator.ts`, `src/providers/types.ts`,
  `src/providers/openai.ts`, `src/providers/anthropic.ts`,
  `src/providers/gemini.ts`, `src/providers/mock.ts`,
  `src/storage/migrations.ts`, `src/storage/repos.ts`,
  `src/server/app.ts`, `src/server/security.ts`, `src/web/App.tsx`,
  `src/web/api.ts`. Tests:
  [`tests/adapters/native_attachments.test.ts`](../../tests/adapters/native_attachments.test.ts)
  and [`tests/integration/attachments.test.ts`](../../tests/integration/attachments.test.ts).
- **Validation:** Agent-run in this checkout, `PROOFESTRA_LIVE_ENABLED=0`
  across all checks. `npx vitest run` → **138 passed / 138 across 10 test
  files** (adds the 5 injected-fetch wire-contract tests for OpenAI /
  Anthropic / Gemini / honest-attachment_only plus the 6 real-HTTP
  upload regressions on an isolated port + dataDir). `npm audit
  --include=dev` → 0 vulnerabilities (after bumping
  `@fastify/multipart` to **10.1.4** per the upstream fix for issue
  [#594](https://github.com/fastify/fastify-multipart/issues/594) +
  PR [#595](https://github.com/fastify/fastify-multipart/pull/595)
  released in v9.3.0 / v9.4.0, then taken to the latest compatible
  10.1.4 per
  [v10.1.4](https://github.com/fastify/fastify-multipart/releases/tag/v10.1.4)).
  `npx eslint src tests --max-warnings 0`,
  `npx tsc -p tsconfig.server.json --noEmit`,
  `npx tsc -p tsconfig.web.json --noEmit`,
  `npm run build`, and `git diff --check` are all clean.
- **Live-provider end-to-end tests remain unverified** at this
  checkpoint. No live key was requested or used. Native-wire shapes are
  proven only by the injected-fetch contract tests. The user owns the
  subsequent visible-Chrome paste / mixed / retry / remove / reload /
  drop verification.

## RLOG-016 — History-complete attachment projection and conservative routing

- **Date:** 2026-10-21
- **Status:** Confirmed scope; implementation landed on top of RLOG-015 in
  the containing commit.
- **Scope changes:**
  - **Full-history typed projection.** `attachment_coverage.routes` and
    `projectHistoryWithAttachments` now cover the UNION of (current turn
    refs, every historical user turn's refs). Follow-up turns re-send
    the actual bytes / extracted text of the attachment the model
    already saw, not an `attachment_only` placeholder. The native-byte
    aggregate budget is enforced across the full union at admission.
  - **Capacity reflects the exact normalized projection.** A new
    `attachmentTokens` field on `evaluateCapacity` carries the sum of
    `nativeImageTokenReserve` / `nativeNonImageTokenReserve` /
    `extractedTextTokenReserve` per agent. Admission AND dispatch both
    pass it. An eight-24k Thai extract on a low-capacity profile is
    now rejected at admission with an exact `attachments …` reason;
    the earlier estimator counted `m.text` only and billed zero for
    attachment wrappers and native payloads.
  - **Validated image dimensions required for native image routing.**
    `markReady` persists the magic-byte sniffed width/height for
    PNG/GIF/WebP. Images without validated dimensions (JPEG, or any
    format whose head slice was too short) fall back to
    attachment-only. Oversized per-side (>4096 px) and oversized area
    (>16 Mpx) also fall back.
  - **PDF stays explicit attachment-only in v1.** The routing refuses
    the native-PDF path even when the adapter supports PDF inline
    wire format because v1 has no bounded page-count parser; the
    bounded extracted-text extractor stays as the next-best route.
    Audio and video with unverified duration also stay
    attachment-only (unchanged policy, now covered by a unit regression).
  - *(Superseded by RLOG-017: validated native PDF and Gemini audio/video routing now exist.)*
  - **Mock-effective per-profile capability caps.** A new
    `ModelProfile.capabilities` override lets a profile tighten (never
    widen) the provider defaults. `effectiveCapabilitiesFor(profile,
    effectiveProvider)` is called with `effectiveProvider = "mock"`
    when `executionMode === "mock"`, so an OpenAI-profile agent in
    mock mode receives no-native capabilities. The Mock adapter was
    already honest about not reading bytes; the coverage projection
    now matches that honesty.
  - **Catalog digest covers capabilities.** `catalogVersion` includes
    the per-profile `capabilities` override so a change rotates the
    version and invalidates stale UI pins.
  - **Sanitized attachment-read errors.** All three live adapters
    (OpenAI / Anthropic / Gemini) read attachment blobs through a
    small helper that collapses any filesystem error
    (ENOENT / EACCES / EIO / EISDIR / ENOSPC …) to an
    `attachment_unreadable` AdapterFailure with a fixed label. No
    absolute path, no errno token, no raw `err.message` reaches the
    run snapshot, SSE frames, or exports. `AttachmentRepo.markFailed`
    also scrubs the stored message defensively.
  - **UI: safe pre-send previews.** The composer renders inline
    previews for image / audio / video / text via the authenticated
    same-origin preview endpoint, and a "No inline preview — use
    Download" fallback for PDF / docx / zip / binary. HTML / SVG /
    XML / office is never rendered as active content.
  - **UI: rehydration preserves in-flight tracking.** A merge helper
    joins the server's authoritative draft list with the composer's
    in-memory rows by `serverId`, preserving `localId`, `fileHandle`,
    `controller`, and `progress` for anything still uploading in this
    tab. A bounded exponential poll resolves rows the server still
    shows as `uploading` after a chat switch.
  - **UI: send settlement is scoped to the originating conversation
    and the exact submitted refs.** `activeRun`, prompt clear, and
    composer clear only run when the user is still viewing the chat
    they submitted from, and the composer clear drops only the rows
    that were actually submitted. The pending-submit digest also
    includes each agent's display `name`.
  - **UI: XHR 401 invalidates the cached boot/session.** `uploadAttachment`
    mirrors the generic `request()` 401 handling: a 401 drops the
    cached CSRF token and the pending bootstrap promise so a subsequent
    explicit retry re-bootstraps from scratch. There is no automatic
    resubmit of an uncertain POST.
  - **Preview endpoint refuses unsafe raster images with 422
    `preview_unavailable`.** `GET /api/v1/attachments/:id/preview`
    checks the persisted sniffed dimensions through
    `isImagePreviewDimensionsSafe(width, height)` (same per-side /
    pixel-area caps as native eligibility). An image whose persisted
    width/height is unknown (JPEG — our head sniff never reads the
    SOF marker), invalid (null / zero / non-integer / non-finite /
    negative), or exceeds the caps (e.g. a 69-byte PNG whose IHDR
    declares 100000×100000) returns `422 preview_unavailable` with
    a JSON error body and NO raster bytes. The `/download` endpoint
    continues to serve the same bytes with
    `Content-Disposition: attachment` so a user-initiated download
    remains possible, but eager inline `<img>` embedding on the
    preview surface never triggers a browser download or decode.
    The UI's `ComposerAttachmentPreview` client-side mirror
    (`isPreviewImageDimensionsSafeClient`) skips the `<img>` tag
    altogether for unsafe rows and renders the explicit
    download-only fallback.
  - **UI: localStorage keeps only opaque ordered ready ids.** A new
    `proofestra:composer-order:v1` key stores at most 16 ids per
    conversation, bounded in length and character set, with no bytes,
    display names, MIME types, extracted text, or secrets. On reload
    the server list wins for identity; the local order wins for
    arrangement.
- **Affected requirement IDs:**
  AT-01 (admission; sniffed dimensions column), AT-02 (per-profile
  native / extracted / attachment-only routing; PDF+audio+video
  policy), AT-03 (bounded extracted-text wrapper reserve), AT-04
  (immutable per-run projection across every stage AND follow-up),
  AT-05 (metadata-only export), PV-01 / PV-02 / PV-05 (no raw bytes
  / absolute paths / errno strings in run JSON, SSE frames, snapshots,
  or exports), AG-02 / AG-05 (bounded concurrency), UX-04 (single
  assistant terminal commit survives the attachment flow).
- **Supersedes / extends:** None superseded. Extends RLOG-015 with
  the full-history projection, capacity-faithful admission, image
  dimension / PDF / audio / video routing policy, mock-effective
  capabilities, and the UI safe-preview + rehydration-merge +
  settlement-scope + XHR-401 + ordered-ready-ids changes.
- **Source / evidence:** Changes in the containing commit (preceding
  baseline `a96dedf`). Code:
  `src/core/attachments.ts`,
  `src/core/coordinator.ts`,
  `src/core/context.ts`,
  `src/core/profileConfig.ts`,
  `src/core/registry.ts`,
  `src/providers/openai.ts`,
  `src/providers/anthropic.ts`,
  `src/providers/gemini.ts`,
  `src/server/routes/attachments.ts`,
  `src/storage/repos.ts`,
  `src/shared/types.ts`,
  `src/web/App.tsx`,
  `src/web/api.ts`,
  `src/web/styles.css`.
  Preview-guard additions: `src/core/attachments.ts`
  (`isImagePreviewDimensionsSafe`),
  `src/server/routes/attachments.ts`
  (`422 preview_unavailable` branch in `servePreview`),
  `src/web/App.tsx` (`isPreviewImageDimensionsSafeClient` + unsafe
  fallback card).
  Tests:
  [`tests/unit/attachments_routing.test.ts`](../../tests/unit/attachments_routing.test.ts)
  (routing + mock-effective caps + token reserves +
  sanitizeFailureMessage),
  [`tests/unit/context.test.ts`](../../tests/unit/context.test.ts)
  (new `evaluateCapacity attachment reserve` block incl. 8×24k Thai),
  [`tests/integration/attachments.test.ts`](../../tests/integration/attachments.test.ts)
  (sniffed dimensions on DTO; history-complete coverage on second-turn
  run),
  [`tests/adapters/native_attachments.test.ts`](../../tests/adapters/native_attachments.test.ts)
  (sanitized attachment-read error on missing blob, 3 adapters).
- **Validation:** Agent-run in this checkout,
  `PROOFESTRA_LIVE_ENABLED=0` across all checks. `npx vitest run` →
  **174 passed / 174 across 11 test files** (+36 from the RLOG-015
  138 baseline; includes four preview-guard regressions:
  `isImagePreviewDimensionsSafe` unit, `/preview` 422 on
  excessive-dim PNG, `/preview` 422 on unknown-dim JPEG, `/preview`
  200 on safe-dim PNG — plus the earlier history-complete coverage,
  sniffed-dim DTO, sanitize-failure-message, and sanitized read-error
  regressions). `npm audit --include=dev` → 0 vulnerabilities
  (`@fastify/multipart` 10.1.4 stays pinned).
  `npx eslint src tests --max-warnings 0`,
  `npx tsc -p tsconfig.server.json --noEmit`,
  `npx tsc -p tsconfig.web.json --noEmit`,
  `npm run build`, and `git diff --check` are all clean.
- **Live-provider end-to-end tests remain unverified** at this
  checkpoint. The actual native-wire shapes are proven only by the
  injected-fetch contract tests. The user owns the subsequent
  visible-Chrome paste / mixed / retry / remove / reload / drop
  verification against a restarted test server.

## RLOG-017 — Bounded real content analysis for attachments

- **Date:** 2026-10-21
- **Status:** Confirmed by the user's 2026-10-21 requests (2:52 PM scope,
  2:59 PM corrections, UTC+7); implementation lands in the containing commit on top of
  preceding revision [`a96dedf`][a96dedf] (nearly all v1 code is still
  uncommitted in this checkout).
- **Scope changes:**
  - **PDF text** from the installed Poppler (`pdfinfo` / `pdftotext`), fixed
    discovered path, no shell, UUID blob path only, at most 20 pages, 5 s,
    bounded output; encrypted, scanned/no-text, malformed, and timed-out files
    are labeled explicitly and never reported as full text.
  - **Office and ODF** (DOCX, XLSX, PPTX, ODT/ODS/ODP, including macro/template
    variants without running macros) body text through bounded ZIP inflation and
    a namespace-aware tokenizer: no DTD, entity, external reference, macro, or
    formula processing.
  - **ZIP** inventory plus bounded text of supported text/code entries with real
    compressed/expanded/ratio/CRC/local-header checks; nested archives and binary
    entries are excluded, never recursed, never written to disk, never executed.
  - **Media** metadata through `ffprobe` over the read-only blob descriptor only;
    validated duration, streams, container format, and a wire-normalized MIME are
    persisted (migrations 4 and 5) and carried through `AttachmentRef`, the
    coordinator, and routing. No transcription, no model, no new service.
  - **Native routing becomes metadata-aware:** native PDF (validated pages, at
    most 20), Gemini-only native audio/video (finite duration at most 120 s,
    aggregate 120 s and 12 MiB per call, supported codecs, bounded video stream),
    one shared admission/dispatch token reserve, and a native-token budget of at
    most 50% of a profile's safe input. OpenAI and Anthropic state plainly that
    native audio/video is unsupported.
  - **Cancellation and abort:** a client disconnect after multipart EOF aborts
    parsing; subprocesses are killed and awaited, the worker is terminated and
    awaited, no `ready` row is published, and only then is the upload gate
    released.
  - **UI:** `Analyzing on server…` at 100% upload with cancel still available,
    semantic coverage labels (`Full text`, `Partial (truncated)`,
    `No text layer (scanned)`, `Unsupported`, `Encrypted`, `Analysis failed`,
    `Metadata only — no transcription`), media previewed only after validation,
    and a per-agent route list with the exact reason in run details.
  - **Prompt injection:** uploaded content is untrusted data; one notice precedes
    extracted text and every native part in all four adapters.
  - `GET /api/v1/providers` exposes only two parser-availability booleans.
- **Affected requirements:** AT-01..AT-05 (AT-02..AT-05 rewritten; see
  [requirements](../requirements.md)), AG-07, AG-08, CT-01, CT-04, CT-05, PV-01,
  PV-02, PV-04.
- **Supersedes:** the RLOG-016 point "PDF stays explicit attachment-only in v1
  ... audio and video with unverified duration also stay attachment-only" (now:
  validated native PDF and validated Gemini native audio/video), the
  inventory-only ZIP/Office statements of RLOG-015/016, and the stale AT-04
  wording that historical turns are `attachment_only` placeholders (since RLOG-016
  they re-send actual content; AT-04 now says so).
- **Evidence:** [`docs/technical-design.md`](../technical-design.md),
  [`docs/api.md`](../api.md), [`tests/fixtures/content/README.md`](../../tests/fixtures/content/README.md),
  and the tests named in XLOG-011. Fixtures are synthetic; the Poppler 26.04.0 /
  ffprobe 7.1.1 behavior was verified only on the checkpoint's development host.
- **Validation:** agent-run in this checkout, `PROOFESTRA_LIVE_ENABLED=0`,
  `npx vitest run` -> 339 passed across 18 files at first landing (baseline 183 across 12; 398 across 23 after all review corrections below);
  lint, both typechecks, `npm audit --include=dev` (0 vulnerabilities), build,
  `node tests/smoke/worker-dist.mjs`, and `git diff --check` clean (see
  [CONTINUE.md](../../CONTINUE.md) for the dated results).
- **Not claimed:** no live provider call was made; no provider has been shown to
  understand any native part; the caps are proposed defaults. Visible-browser QA
  remains the user's.

- **Review corrections (2026-10-21).** Three independent reviews of this same
  unlanded change led to these corrections (no new IDs): PDF metadata fails
  closed on ambiguous `pdfinfo` output; media streams and persisted summaries
  fail closed (more than 8 streams, unnamed codecs, non-A/V streams in WebM) and
  every video stream must be bounded; the Office tokenizer is linear with depth
  and tag limits and strict UTF-8; XLSX now reads stored cell values (cached
  formula results, no formula evaluation; label "cached values, formulas not
  evaluated"); cancelled and queued uploads no longer pin the upload gate, the
  composer hides cancelled rows, the post-upload label is now
  `Processing on server…` (it also covers queued files, replacing the
  `Analyzing on server…` wording above), and DELETE of a still-processing row
  aborts its parse; refusal reasons no longer blame earlier attachments for a
  file that exceeds a cap alone, and mock mode says it sends no bytes;
  `/providers` returns `catalog_source.file_configured` instead of a path;
  binary discovery uses the fixed environment at startup; token reserves price
  the exact framed text; docs now separate evidence from the earlier 183-test
  build. Acceptance scenario A26 was added to the requirements.
## RLOG-018 — Required development models and coverage

- **Date:** 2026-10-21
- **Status/source:** User-confirmed request, uncommitted change on baseline a96dedf; no authorization for new spending, keys or publication.
- Confirmed user scope: always-on project rules; Fable 5.1 planner/designer, Opus 5.5 reviewer/advisor, user-spelled Sonet 5.5 worker; >=90% meaningful test coverage. DEV-01/02 and docs/development-policy.md define acceptance. Exact Cursor names, including whether Sonnet 5.5 is the intended worker, require visible account-specific verification. No substitute or new spending is authorized.
- **Validation:** 398/398 tests pass; measured coverage is 60.70% statements,
  57.04% branches, 58.82% functions and 63.26% lines. All four 90% gates fail.
  A coordinated native Cursor check lists the requested model families, but Fable
  planning was Model Blocked by administrator policy and did not execute. The
  worker label is Claude Sonnet 5.5 High (user wrote Sonet). No substitute,
  live-provider call, or newly requested Proofestra model-role run is claimed.

## RLOG-019 — GPT Sol planner replacement

- **Date:** 2026-10-21
- **Status/source:** Latest explicit user correction; uncommitted on baseline a96dedf.
- User-confirmed correction: "ง้้นเปลี่ยนจาก Fabel เป็น GPT Sol". GPT Sol replaces Fable for DEV-01 planner/designer; Opus 5.5 reviewer/advisor, Sonnet 5.5 worker and DEV-02 >=90% coverage remain. Supersedes only the planner portion of RLOG-018. Exact GPT Sol label/version/ID and permitted execution await coordinated Cursor UI verification.
- **Validation:** Configuration only; 398 tests pass, but coverage is 60.70% statements, 57.04% branches, 58.82% functions and 63.26% lines. No new role execution claimed.

- **Coordinated verification/update:** GPT-5.6 Sol Medium, ID gpt-5.6-sol,
  was individually selected and successfully executed planning reads in another
  project. Installed .cursor/agents/proofestra-{planner,worker,reviewer}.md with
  gpt-5.6-sol, claude-sonnet-5-5 and claude-opus-5-5 respectively; planning/review
  read-only. No new Proofestra role execution is claimed, and actual model identity
  must be checked because Cursor can fall back. No Fable retry.

## RLOG-020 — Coverage gate achieved; XLSX shared-string partiality

- **Date:** 2026-10-21
- **Status/source:** Worker implementation of the planner's coverage plan under DEV-01/DEV-02 (user instruction of the same day); uncommitted on baseline a96dedf. Independent Opus review and operator-run native Chrome QA are still pending.
- **Requirement change (AT-02, A26):** an XLSX cell that reads a shared string dropped by `MAX_SHARED_STRINGS` (200,000) or `MAX_SHARED_STRING_CHARS` (8 MiB) now yields `truncated` / `coverage.truncated` with the label "shared-string limit reached, some cached text omitted"; previously such a sheet could read `text_extracted` with no signal. Caps unchanged. A sheet that only references strings before the cap stays `text_extracted`.
- **DEV-02 outcome:** `npm run test:coverage` exits 0 on 63 files / 1369 tests: statements 98.23% (5191/5284), branches 95.36% (3742/3924), functions 98.92% (826/835), lines 99.26% (4586/4620), all 53 production TS/TSX files measured, no exclusions, no ignore directives, thresholds still 90 each. Mock/intercepted/jsdom tests are not live-provider or native-browser evidence.
- **Supersedes:** the "coverage not met" status in RLOG-018/RLOG-019 validation lines (history preserved).

## RLOG-021 — Native subscription-backed backends; Codex fail-closed, Antigravity unverified

- **Date:** 2026-10-22
- **Status/source:** User instruction of 2026-10-22 (implement the bounded GPT Sol plan, completion first, then consolidated validation by the operator). Worker implementation by Claude Sonnet 5.5 High (`claude-sonnet-5-5`, identity as stated by the session; no fallback observed by the worker); uncommitted on baseline a96dedf. Independent Opus review and operator-run full suites/HTTP/native QA are pending.
- **Requirement change:** added PR-08 (native backend identity and backend-keyed dispatch), PR-09 (sanitized fail-closed readiness and frozen admission policy), PR-10 (Codex via the vendor-managed ChatGPT login, invocation-only policy), PR-11 (allowlisted output, fixed failure classes), PR-12 (Antigravity unverified/disabled), PR-13 (honest native accounting) and DEV-03 (publication authorization and subscription constraints). Existing IDs unchanged; CT-06/CT-08 and TL-06 are reinforced, not altered.
- **Blocked state (exact):** Codex execution admission is `unverified` / `tool_surface_unproven` against the installed codex-cli 0.163.0. Evidence from harmless, non-inference commands: `features list --disable unified_exec` still reports `unified_exec=true`; all 11 bundled models report `apply_patch_tool_type=freeform` and `shell_type=unified_exec` (the `apply_patch_freeform` flag is `removed`), and 10 of 11 report `tool_mode=code_mode_only`; `web_search` is not a `features list` entry and MCP configuration cannot be enumerated; no command lists a turn's tools without inference. Antigravity (`agy` 1.1.5) is `unverified` / `protocol_unverified`.
- **Scope kept:** no token or auth-file read, new login/grant/persistent setting, paid API fallback or purchase; no model/network/browser/server activity during implementation; no stage/commit/push/PR. Subscription quota is never presented as API credit and cost is never $0.
- **Housekeeping:** the historical removal note in RLOG-014 (uncommitted-v1 disclaimer) re-quoted a real username path; only that path was replaced by `/Users/<user>/...`, meaning unchanged. `.gitignore` gained defensive credential/auth-state/session/database-dump names that do not match production code, tests, fixtures or user documents.
- **Validation:** focused tests only (typecheck of all three tsconfigs, lint, 125 new native tests, 486 related existing tests); full `npm run check`, coverage gate, audit and HTTP/Chrome checks are deferred to the operator. See XLOG-016.

## RLOG-022 — Native admission, authentication and accounting corrections

- **Date:** 2026-10-22 (follows RLOG-021, whose original text is unchanged; amends PR-10 and PR-13).
- **Status/source:** scoped correction follow-up after two preliminary static security reports, assessed against the actual code (not presumed review conclusions). Worker: Claude Sonnet 5.5 High; independent Opus review pending.
- **Requirement change:** PR-10 gains subscription-only authentication (per-job `login status` gate plus `forced_login_method`); PR-13 replaces "flag over-ceiling usage" with fail-the-step, adds the explicit `bounded_job` + `allow_unknown_internal_usage` admission condition and the enforceable-control set, and states that native usage is never simulated or falsely zero. Reason codes: `ready_auth_unchecked` is superseded by `ready_auth_checked_per_job`; `auth_mode_unproven` is new. Real execution stays blocked (tool surface and now the authentication control remain unproven).
- **Findings assessed:** line-cap bypass by complete newline-terminated lines (real, fixed); API-key billing via cached login not prevented by env scrubbing (real, gated); strict/unknown-usage policy not applied to native admission (real, enforced); over-ceiling output recorded as completed with a finding (real, now a failure); simulated step scope and zero invocation/step counters (real, fixed for native; Live steps no longer start simulated).
- **Validation:** see XLOG-017. No inference, login or server action.

## RLOG-023 — Native containment, confirmed model, executable identity and accounting honesty

- **Date:** 2026-10-22 (follows RLOG-022, whose original text is unchanged; amends PR-10 and DEV-03; the accounting-honesty change is recorded in DLOG-020 and the technical design).
- **Status/source:** an independent Claude Opus 5.5 review of the native change (execution off) found two Medium and four Low findings; each was assessed against the code and fixed. Worker: Claude Sonnet 5.5 High (`claude-sonnet-5-5`); a targeted Opus recheck is pending the operator's consolidated verification.
- **Requirement change:** PR-10 no longer claims a "whole-process-tree kill": cancel/timeout is a best-effort process-group SIGKILL followed by bounded settlement; a descendant that left the group is not contained, and such a job is `containment_unverified` with external work `unknown`. PR-10 also requires the model to be confirmed by the CLI's own transcript, identifies the executable by real path plus dev/ino/size/mtime (cache key and pre-launch re-check), and shares one wall-clock budget between the probes and the job. A Live dispatch (any provider) counts one harness invocation at invocation/step/run level and reports unknown tokens on failure. DEV-03 no longer records a one-task publication authorization (a permanent rule must not embed task-scoped permission); agents never stage, commit, push, open a PR, merge or deploy.
- **Findings assessed:** (1) escaped pipe-holding descendant could keep a job unsettled indefinitely (real, bounded settlement added; "whole-tree kill" wording was an overclaim); (2) `docs/openapi.yaml` presented design-only fields as required and omitted six implemented attachment routes (real, split into `implemented_v1`/`design_only` and contract-checked); (3) a per-call hard timeout abandoned a still-running adapter without aborting it, releasing the slot early and leaving external work `none` (real, fixed); (4) the pinned model was assumed executed when the transcript never reported one (real, fixed); (5) the preflight cache trusted a path after the binary changed (real, fixed); (6) failed API calls did not count a step/invocation harness invocation or mark their tokens unknown (real, fixed).
- **Supersedes in part:** XLOG-017's statement that the OpenAPI alignment was sufficient; it was not (see XLOG-018).
- **Validation:** see XLOG-018. No inference, login, server action, network or vendor CLI was used.

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
[1374641]: https://github.com/jirawatp/proofestra/commit/13746413cbb076c1ec9458090d9c89fdd6178af8
[a96dedf]: https://github.com/jirawatp/proofestra/commit/a96dedf3ae94eb7d07cd971e9cd20886151966ed

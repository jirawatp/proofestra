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

## XLOG-006 — Shared extension catalog and provider-independent tool broker

- **Date / status:** 2026-10-17; user-confirmed skills/plugins/custom MCP scope,
  proposed implementation design. Delivered by the containing commit after
  [`1374641`](https://github.com/jirawatp/proofestra/commit/13746413cbb076c1ec9458090d9c89fdd6178af8).
- **Change:** Add a shared global/workspace catalog for skill packages, plugin
  bundles, and custom MCP registrations. A scoped skill loader and MCP/function
  broker make compatible contributions usable by all connected providers without
  mandatory separate native installation. Preserve stable package identity and
  namespaces, immutable version/digest snapshots, central secret references,
  compatible function projections, lifecycle checks, and isolated root-branch state.
- **Reason / trace:** User requested common skills/plugins/custom tools across
  providers. EX-01–EX-08, A21–A25; RLOG-009 and DLOG-008 in the other logs.
  See [extensions](../extensions.md), [API](../api.md), and
  [continuation checkpoint](../../CONTINUE.md).
- **Refines:** XLOG-004's tool/backend registry. Shared catalog use is broader than
  native provider MCP connectors, while vendor-only tools still require compatible
  routes or authorized helpers. Skills and manifests do not grant permission.
  Shared registration never shares current peer drafts or mutable scratch handles.
- **Evidence / limitation:** Official Agent Skills and MCP specifications were
  checked for design; exact sources are in extensions.md. Contract/example,
  documentation, and simulated-browser checks are recorded in the review record.
  No live skill import, plugin installation, MCP connection, provider call, or
  production isolation/security test is claimed.
- **Next:** Mock extension fixtures and cross-provider broker behavior, then
  validated real imports/transports. Package-manager write endpoints and native
  import adapters need their own implementation and acceptance work.

## XLOG-007 — Local v1 coordinator, sanitized adapters, and content-addressed catalog

- **Date / status:** 2026-10-21; delivered by the uncommitted containing work on
  `codex/project-traceability` after
  [`a96dedf`](https://github.com/jirawatp/proofestra/commit/a96dedf3ae94eb7d07cd971e9cd20886151966ed).
  Confirmed implementation; mocks are the default and no live provider call was
  made.
- **Change:** Implement the local v1 run coordinator and provider adapters that
  earlier revisions only described:
  - **Admission ordering:** idempotency replay runs BEFORE catalog / live /
    agent / profile admission, so a prior successful run replays after Live is
    disabled or the catalog rotates. A changed payload under the same key
    returns 409.
  - **Infeasible-plan rejection:** admission computes
    `base_planned_calls × max_output_tokens_per_call` and rejects with 422
    when the product exceeds `total_output_tokens`; it also refuses any
    requested per-call ceiling that exceeds the profile's own
    `max_output_tokens`.
  - **Token accounting:** two parallel fields on `Usage` — the honest
    sticky-unknown aggregate (`input_tokens`/`output_tokens: number | null`,
    starting at 0 and collapsing to `null` once ANY dispatched invocation
    reports unknown, per CT-06) and a conservative numeric ledger
    (`consumed_output_tokens: number`, `reserved_output_tokens: number`) that
    charges the full per-call reservation to the ledger for every
    missing/ambiguous outcome. Terminal commit drains any outstanding
    reservation into the ledger.
  - **Hard timeouts:** each `adapter.generate()` await is wrapped in a
    `Promise.race` against a local timeout; the whole run is wrapped in an
    overall-deadline guard that commits a `failed` terminal state and
    releases the serialized `globalActive` chain even when an adapter
    ignores `AbortSignal`.
  - **Atomic transitions:** `events.append` + `runs.updateSnapshot` run in a
    single SQLite transaction; the bus event is emitted only after the
    transaction returns. Terminal commit atomically writes the terminal
    event, the snapshot, and the final assistant message (idempotent per
    `run_id`).
  - **Context bounds:** admission validates
    `history + prompt (included once) + instructions + output reserve +
    worst-case stage artifacts` against EACH configured profile's
    `safe_input_tokens`. The token estimator uses the conservative
    upper bound `max(ceil(utf8_bytes/2), ceil(chars/4))` so Thai / CJK /
    emoji are not undercounted. Synthesis reference is 2n artifacts
    (n drafts + n reviews), not n·n.
  - **Content-addressed catalog version:** `catalog_version` =
    `CATALOG_VERSION_PREFIX + sha256(stableStringify(profiles)).slice(0,12)`,
    so changing a `model_id` under the same `profile_id` rotates the version
    and invalidates stale UI pins via `expected_catalog_version` at run
    creation.
  - **Adapter sanitization:** OpenAI, Anthropic and Gemini adapters discard
    every upstream body, caught `Error.message` and vendor stop/finish/block
    string. Failures surface only fixed boilerplate + HTTP status +
    allowlisted enum values through `src/providers/_sanitize.ts`;
    `thought: true` parts and `thoughtSignature` are stripped from Gemini
    output.
  - **Dev plumbing:** security hooks (Host allowlist, CSP, no-store, CSRF)
    register at app root scope so static assets are also covered. Vite dev
    config forwards 5173 → 3000 with `changeOrigin: true` and an `Origin`
    header rewrite; `PROOFESTRA_EXTRA_ORIGINS` accepts loopback-only
    additions. SSE validates Last-Event-ID monotonically, returns 400 for
    future IDs, 204 for terminal + caught up, and cleans up on both
    response and request close.
- **Reason / trace:** Current user request on 2026-10-21 and the independent
  review of the same date. See DLOG-009 in the [decision log](decisions.md),
  RLOG-010 in the [requirement log](requirements.md),
  [technical design](../technical-design.md), [API](../api.md), and
  [architecture](../architecture.md).
- **Refines:** XLOG-002/003/004. The implementation preserves bounded same-provider
  identities, scoped delegation (currently rejected at admission with
  `helpers_not_supported` because v1 does not run subagents), compatible tool
  routing (rejected with `tools_not_supported` for the same reason), and the
  mock-default / live-opt-in boundary.
- **Evidence / limitation:** 92 automated tests pass (`npx vitest run`):
  unit + integration + adapter sanitization. `npm audit` reports 0
  vulnerabilities on the full dev tree. `npm run build` emits
  `dist/public` + `dist/server`. `npm start` on port 3101 served a Quick
  mock run with `status=completed`, `input_tokens=115`, `output_tokens=120`,
  `consumed_output_tokens=120`, `reserved_output_tokens=0`, and the
  content-addressed `catalog_version=catalog-v2-local-20261021-8460ba2dca24`.
  No credential or upstream body text was observed in any logged payload,
  snapshot, event or export. No live provider call was made.
- **Next:** Wire the Live-mode UI opt-in, author browser-level end-to-end
  verification (not covered by fastify-inject), and extend the adapter
  contract tests to cover streamed responses and non-text content blocks
  when those features are added. Delegation, tool execution, SDK/CLI/app
  surfaces, and native execution tracing remain out of this v1 scope.

## XLOG-008 — Acceptance pass: concise mock, framing-aware admission, UI persistence, docs

- **Date / status:** 2026-10-21; delivered by the uncommitted containing work on
  `codex/project-traceability`, on top of XLOG-007. Confirmed; mocks remain
  the development default and no live provider call was made.
- **Change:**
  - **UI selected-chat persistence (`src/web/App.tsx`).** The selected
    `conversation_id` is now persisted to `localStorage` under
    `proofestra:selected-conversation-id:v1`. Shape is validated as a UUID on
    read, missing/unknown/deleted ids are cleared silently, and the UI falls
    through to the empty state. The server stays the source of truth; nothing
    else is persisted client-side.
  - **Concise deterministic mock output (`src/providers/mock.ts`).** Draft,
    review, and synthesis stages no longer echo the full reference material.
    The coordinator still feeds each stage the complete reference, so every
    peer draft and review is preserved per-step in the run inspector; only
    the top-level final-answer bubble is now compact. The output still
    cites simulated evidence (a prompt digest), reports draft/review counts,
    and preserves cross-draft disagreement and uncertainty. The
    `mock-fail-review` profile label was corrected to match its code path
    (drafts and synthesis succeed; only the review stage fails).
  - **Framing-aware context admission (`src/core/context.ts`).** The
    conservative upper bound is now documented and includes per-message
    framing: `BYTES_PER_TOKEN_FLOOR = 2`, `CHARS_PER_TOKEN_FLOOR = 4`,
    `TOKENS_PER_MESSAGE_FRAMING = 8`, `TOKENS_FOR_REPLY_FRAMING = 8`. The
    file header derives the per-byte and per-char floors from observed
    worst-case ratios across OpenAI o200k/cl100k, Anthropic Claude 3, and
    Google Gemini SentencePiece tokenizers, and cites the OpenAI cookbook's
    `tokens_per_message=3` + reply `+3` as a lower bound we exceed. The
    coordinator passes the planner's worst-case reference size as a token
    count via the new `referenceMaterialTokens` input instead of reifying it
    as a synthetic string; this fixes a regression where normal Team-3
    admission on a 128k-safe profile was rejected because `bytes/2` of the
    synthetic string double-charged byte/char overhead. The admission check
    now reports `history + system + reference + framing + reserve` in its
    `reason` so admission failures are debuggable.
  - **Documentation (`README.md`, `CONTINUE.md`, `docs/logs/*.md`).** README
    gained a concrete setup/run section (Node 22.19+, `npm ci`, `npm run
    dev`, `npm run build`, `npm start`), a server-only env credentials
    table with a working example, a profile JSON example showing multiple
    same-provider models, mock-vs-live costs/privacy/limits, the exact set
    of CI-equivalent checks, and the explicit scope exclusions (no
    helpers/tools/MCP/plugin execution, no streaming adapter, no native SDK
    surfaces, no correctness guarantee). CONTINUE.md reflects the current
    implementation state and this checkpoint's validation evidence.
- **Reason / trace:** Current user request on 2026-10-21 ("final acceptance
  pass"), building on the independent Fastify-inject QA that confirmed
  XLOG-007's run coordinator. See DLOG-010 in the [decision log](decisions.md)
  and RLOG-011 in the [requirement log](requirements.md).
- **Refines:** XLOG-007. Does not supersede it.
- **Evidence / limitation:** 100 automated tests pass (`npx vitest run`):
  33 unit (incl. 9 new context/framing regressions for ASCII, Thai, emoji,
  short-message framing-dominant, and Team-3 worst-case synthesis
  admission), 13 integration, 54 adapter sanitization. `npm audit
  --production=false` reports 0 vulnerabilities. `npx eslint src tests
  --max-warnings 0`, `npx tsc -p tsconfig.server.json --noEmit`, and
  `npx tsc -p tsconfig.web.json --noEmit` all pass clean. `npm run build`
  emits `dist/public` + `dist/server`. Browser-level E2E is still not
  scripted in this checkpoint; the user's independent Chrome QA and the
  owned Terminal-2 `PROOFESTRA_MOCK_LATENCY_MS=5000 npm run dev` for
  visible cancellation remain the current live-browser evidence. Live
  provider end-to-end tests remain outside this checkpoint.
- **Next:** Script Playwright-style visible-browser tests under `tests/ui/`
  for default-send succeeds, cancel mid-run, stop-on-reload recovery,
  EventSource reconnect, expandable step details, and the export privacy
  notice. When a Live-provider validation is done, append a new XLOG entry
  with the dated session and the exact scoped credentials used (never
  commit credentials).

## XLOG-009 — Terminal accounting single-charge, Partial preservation, truncation, broad acceptance regressions

- **Date / status:** 2026-10-21; delivered by the containing uncommitted
  work on `codex/project-traceability`. Agent-run follow-up to a user
  review-finding request on top of XLOG-008; the implementation, test
  coverage, and verification below were executed by the controlling Codex
  agent, not by a human user.
- **Change:**
  - **Terminal accounting is drained exactly once.** `finalize()` is now
    the sole owner of "move `reserved_output_tokens` into
    `consumed_output_tokens` and zero the reservation". The late-success
    branch in `runSingleStep` (adapter returned after a cancellation)
    and the late-failure branch (adapter rejected after a cancellation)
    both detect the terminal state via `isTerminal()` on the authoritative
    `activeSnapshots` entry and return without touching usage. Previously
    both branches re-ran the drain, double-charging the ledger and
    driving `reserved_output_tokens` into negatives visible in SSE replay
    snapshots.
  - **Overall-deadline guard preserves useful work.** When the overall
    deadline fires with ≥1 successful draft, the run commits `partial`
    with a `draft_fallback` presentation and the first successful draft
    as the final answer; if synthesis is already complete, the
    presentation is `team_synthesis`. Only when no useful artifact exists
    does the guard fall through to `failed`. Limitation line records the
    overall-deadline origin.
  - **Truncated provider output is Partial.** After per-stage findings
    are aggregated, the coordinator scans for any finding matching
    `/truncat/i` and promotes the run to `partial` with
    `reason="truncated_output"`. This covers OpenAI `finish_reason=length`,
    Anthropic `stop_reason=max_tokens`, Gemini `MAX_TOKENS`, and the new
    `truncated` mock scenario.
  - **Mock fixture expressivity.** Profile fixtures gained
    `only_on_stage: "draft" | "review" | "synthesis"` so a failure
    scenario can be scoped to a single stage without duplicating
    profiles. The new `truncated` scenario emits a short deterministic
    body + a truncation finding + `usage.output_tokens` equal to the
    reservation.
  - **Test-friendly AppBundle.** `src/server/app.ts` exposes `db`, `runs`,
    `events`, `conversations`, and `messages` on the returned bundle for
    in-process integration tests. HTTP routes continue to depend on the
    narrower `RouteDeps` interface, so the HTTP surface is unchanged.
  - **Fastify DELETE semantics.** Integration tests use a header helper
    that strips `content-type: application/json` on DELETE requests so
    Fastify's content-type parser does not fail with
    `FST_ERR_CTP_EMPTY_JSON_BODY` before the active-run guard runs.
- **Rationale:** Honest usage accounting (CT-04/06), preserved uncertainty
  / useful artifacts under bounded deadlines (CT-05/07), privacy and no
  credential leak in exports (PV-01/02/05), concurrency bounds (AG-02/05),
  and single-assistant terminal commit (UX-04).
- **Validation:** 119 automated tests pass (`npx vitest run`): 33 unit
  (including 9 context/framing), 16 new acceptance integration regressions
  under [`tests/integration/acceptance.test.ts`](../../tests/integration/acceptance.test.ts),
  13 prior integration, 57 adapter sanitization. The new acceptance file
  covers terminal non-double-charge after cancel + late callbacks,
  overall-deadline Partial fallback with surviving draft, Team-3
  exact-7-call happy path with the user-selected synthesizer and single
  assistant message, per-provider concurrency cap, mixed known/unknown
  Team usage, review-only and synthesis-only partial failures, truncated
  provider output ≠ full completion, Host/Origin/CSRF rejection, SSE
  replay / terminal sequence / unique assistant message, restart
  interruption via `markInterruptedOnStartup`, and active-run
  export/delete 409 + export never surfacing API keys or injected
  marker strings. `npm audit --production=false` reports 0
  vulnerabilities. `npx eslint src tests --max-warnings 0`, `npx tsc -p
  tsconfig.server.json --noEmit`, `npx tsc -p tsconfig.web.json
  --noEmit`, and `npm run build` all pass clean. The user's visible
  Chrome Stop verification (zero assistant messages for the canceled
  run) is now locked in as an automated regression. Browser-level E2E
  remains outside this test harness.
- **Next:** Playwright-style visible-browser tests still pending (see
  XLOG-008). When Live-provider validation is run, append a new XLOG
  entry with the dated session and the exact scoped credentials used
  (never commit credentials).

## XLOG-010 — First-class attachments: upload gate, native projection, parser-error 4xx

- **Date:** 2026-10-21
- **Status:** Confirmed design; implementation landed in the containing
  commit on top of XLOG-009.
- **Scope:**
  - **Upload admission.** A single store-wide `UPLOAD_GATE`
    (concurrency 1, bounded waiting queue, 120 s per-upload deadline)
    sits in front of `handleOneUpload`. Deadline fires via
    `AbortController`; `request.raw.once("close", onClose)` also aborts
    on client disconnect; the `finally` block clears the deadline
    timer, removes the `close` listener, and releases the slot in that
    exact order. Writer / extraction cleanup happens before release so
    partial bytes cannot leak past a timed-out upload.
  - **Deferred Ready publication.** `handleOneUpload` holds hash,
    byte size, head slice, sniffed MIME, and bounded extracted text
    locally in `pending`. The attachment row flips to `ready` only after
    the `request.parts()` async iterator completes successfully.
    `cleanupPartialBlob` re-reads the row inside the same transaction and
    refuses to unlink a `ready` or already-bound blob.
  - **Parser-error 4xx classification.** `FST_FILES_LIMIT → 400`,
    `FST_REQ_FILE_TOO_LARGE → 413`,
    `ERR_STREAM_PREMATURE_CLOSE / FST_PARTS_LIMIT / FST_FIELDS_LIMIT /
    FST_PROTO_VIOLATION → 400 multipart_malformed`. The 6 real-HTTP
    attachment regressions bind this classification; they reject 500 as
    a valid outcome for a malformed body.
  - **CSP preservation.** The server-wide `onSend` hook only sets
    `cache-control`, `x-frame-options`, and `content-security-policy`
    when the route has not already set them. The sandboxed preview /
    download routes continue to supply the strictest CSP, and the
    global default no longer overrides them.
  - **Typed `MessageContentPart` in the adapter contract.**
    `AdapterRequest.user_messages` carries `NormalizedMessage[]` with
    optional typed `parts: MessageContentPart[]`
    (`text` | `attachment_native` | `attachment_extracted_text` |
    `attachment_only`). The coordinator freezes
    `snapshot.context.attachment_coverage` + `snapshot.context.attachments`
    at admission and projects them on every stage (draft, review,
    synthesis, followup). Historical user messages are rendered as
    `attachment_only` placeholders so a provider sees a continuous but
    truthful history without re-sending bytes.
    - OpenAI ChatCompletions: image → `{type:"image_url",
      image_url:{url:"data:<mime>;base64,…"}}`;
      PDF → `{type:"file", file:{filename, file_data:"data:…"}}`.
    - Anthropic Messages: image → `{type:"image",
      source:{type:"base64", media_type, data}}`;
      PDF → `{type:"document", source:{…}}`.
    - Gemini v1beta `generateContent`: image / PDF / audio / video →
      `{inlineData:{mimeType, data:<raw base64>}}`.
    - Any non-native route surfaces as a plain text note that honestly
      names the file, MIME, size, and refusal reason. The Mock adapter
      has an explicit `describeAttachmentParts` helper that renders the
      same honest note; it never claims it analyzed the bytes.
  - **XHR upload client.** `uploadAttachment` awaits `boot()` first,
    short-circuits on an already-aborted signal, rejects on boot
    failure, sets `x-csrf-token` exactly once immediately before
    `xhr.send`, clears all listeners / timeouts on completion or abort,
    and never prints the token.
  - **StrictMode-safe composer.** `addComposerFiles` keeps its
    `setComposerAttachments` call pure (capacity math reads
    `composerAttachmentsRef.current`; no side effects inside the
    updater). Uploads kick off from an effect keyed on `localId` and
    guarded by `uploadStartedRef = useRef<Set<string>>()`. Each row
    carries its own `AbortController`; remove / cancel calls
    `controller.abort()`.
  - **Reloaded draft retry.** The composer row's `fileHandle` is
    `File | null`; rehydration from server state sets it to `null`;
    retry early-returns with a visible "re-select the file" message
    instead of posting `new File([])`.
  - **Full-payload idempotency.** `fullPayloadDigest(input)` hashes
    the prompt + mode + execution_mode + ordered agents + profile +
    synthesizer + ordered Ready-attachment refs. The pending-submit
    cache now keys on this digest, so the same prompt with a different
    mode or file set does not collapse onto an earlier pending key.
  - **Dependency bump.** `@fastify/multipart` is exact-pinned to
    [v10.1.4](https://github.com/fastify/fastify-multipart/releases/tag/v10.1.4)
    to carry the upstream fix for
    [issue #594](https://github.com/fastify/fastify-multipart/issues/594)
    ([PR #595](https://github.com/fastify/fastify-multipart/pull/595),
    released in v9.3.0 / v9.4.0). Node version is unchanged (22.19.0
    per `.nvmrc`). Defense-in-depth per-part + per-request error
    listeners are added so a future regression does not re-crash the
    process via an unhandled `error` event. No `uncaughtException` hack
    was added; no `node_modules` was patched.
- **Rationale:** Honest per-stage context (AT-02 / AT-04), privacy and
  export cleanliness (PV-01 / PV-02 / PV-05), bounded concurrency
  (AG-02 / AG-05), single-assistant terminal commit (UX-04), and
  attachment admission limits (AT-01 / AT-03).
- **Validation:** Agent-run in this checkout,
  `PROOFESTRA_LIVE_ENABLED=0` across all checks.
  - 138 / 138 vitest tests pass across 10 files. The new
    [`tests/adapters/native_attachments.test.ts`](../../tests/adapters/native_attachments.test.ts)
    injects a capturing `fetch` into each live adapter and asserts the
    exact wire shape for OpenAI image + PDF, Anthropic image + PDF,
    Gemini image + PDF + audio, and the honest `attachment_only` text
    note. The 6 real-HTTP attachment regressions use an isolated port +
    dataDir and prove the crash / abort / cleanup flow plus that a
    subsequent valid upload succeeds.
  - `npm audit --include=dev` reports 0 vulnerabilities after the
    @fastify/multipart 10.1.4 pin.
  - `npx eslint src tests --max-warnings 0`,
    `npx tsc -p tsconfig.server.json --noEmit`,
    `npx tsc -p tsconfig.web.json --noEmit`,
    `npm run build`, and `git diff --check` all clean.
- **Next:** Live-provider native-image / native-PDF end-to-end
  verification still requires separately supplied credentials and is
  out of scope for this checkpoint. The user owns the subsequent
  visible-Chrome paste / mixed / retry / remove / reload / drop
  verification.

## XLOG-011 — Content analysis implementation: parsers, worker, metadata flow, routing, UI, and test evidence

- **Date:** 2026-10-21
- **Status:** Implemented in the containing commit on top of
  [`a96dedf`](https://github.com/jirawatp/proofestra/commit/a96dedf3ae94eb7d07cd971e9cd20886151966ed);
  proposed defaults per DLOG-014 remain tunable.
- **Affected requirements:** AT-01..AT-05, AG-07, AG-08, CT-01, CT-04, CT-05,
  PV-01, PV-02, PV-04 (see RLOG-017 and DLOG-014).
- **Design / interface changes:**
  - `src/core/parsers/{boundedProc,pdf,ffprobe,zipCore,zip,office,binaryTools}.ts`,
    `src/core/{attachmentWorker,workerExtraction,attachmentExtraction}.ts`: a
    single bounded subprocess runner (kill then await `close`, own-listener
    cleanup, UTF-8-safe partial output), PDF classification, the FD-only probe, one
    hardened ZIP core, and the worker launcher (`.ts` bootstrap vs built `.js`,
    awaited termination, injectable factory).
  - `src/shared/attachmentMetadata.ts` holds the sanitizers shared by storage,
    coordinator, routing and the preview guard; `src/storage/{migrations,repos}.ts`
    persist pages, duration, streams, format and normalized MIME (migrations 4, 5).
  - `src/core/attachments.ts`: new capability fields (numeric caps, codec
    whitelists; profiles may only tighten), `routeNativeAttachment` over validated
    metadata, `planAttachmentRoutes` (history-first budgets), the shared token
    reserve, and `nativeWireMime`; `src/core/coordinator.ts` carries the metadata,
    uses the reserve at admission and dispatch, and converts invariant errors to a
    typed `invalid_request` step failure.
  - `src/providers/attachmentFraming.ts` and the four adapters: one notice, wire
    MIME, extracted-text framing.
  - `src/server/routes/attachments.ts`: abort on request or response close,
    injectable extractor, sanitized `markReady`, media preview 422 guard;
    `src/server/routes/providers.ts`: two parser booleans.
  - `src/web/{attachmentUi.ts,App.tsx,api.ts,styles.css}`: analysis state,
    semantic coverage, validated-only media preview, per-agent route list.
- **Test evidence (agent-run, mocks and fixtures only):**
  [`tests/unit/bounded_proc.test.ts`](../../tests/unit/bounded_proc.test.ts),
  [`tests/unit/zip_core.test.ts`](../../tests/unit/zip_core.test.ts),
  [`tests/unit/attachment_metadata.test.ts`](../../tests/unit/attachment_metadata.test.ts),
  [`tests/unit/attachments_routing.test.ts`](../../tests/unit/attachments_routing.test.ts),
  [`tests/unit/attachment_ui_helpers.test.ts`](../../tests/unit/attachment_ui_helpers.test.ts),
  [`tests/integration/content_parsers.test.ts`](../../tests/integration/content_parsers.test.ts)
  (every fixture in three synthetic manifests mapped; real Poppler/ffprobe/worker),
  [`tests/integration/attachments.test.ts`](../../tests/integration/attachments.test.ts)
  (disconnect-during-parse, persistence, preview guard, `/providers` booleans),
  [`tests/integration/content_delivery.test.ts`](../../tests/integration/content_delivery.test.ts)
  (OpenAI/Anthropic/Gemini Team drafts, reviews, synthesis and follow-up payloads
  through the coordinator with an injected transport and fake keys), and
  [`tests/adapters/native_attachments.test.ts`](../../tests/adapters/native_attachments.test.ts).
  `tests/smoke/worker-dist.mjs` proves the built `.js` worker runs without tsx.
  Total **339 tests / 18 files** at first landing (baseline 183 / 12); 398 / 23 after all review corrections below.
- **Supersedes:** the XLOG-010 statement that historical user messages are
  rendered as `attachment_only` placeholders (already incorrect after RLOG-016;
  this entry records the full-history projection with frozen routes). XLOG-010
  did not itself state that ZIP is inventory-only or that PDF/audio/video stay
  attachment-only; those points live in RLOG-015/016 and DLOG-012/013 and are
  superseded by RLOG-017 / DLOG-014. No older entry was edited.
- **Limitations:** intercepted-request contracts only (no live provider); the
  composer wiring is covered by typecheck and pure-helper tests, not a DOM or
  browser; parsers were verified on the checkpoint's development host (Poppler 26.04.0 and ffprobe
  7.1.1); strict-OOXML namespaces are not read; media uploaded before migration 5
  has no validated metadata and is download-only until re-uploaded.
- **Review corrections (2026-10-21).** Same unlanded change; no new ID. After
  three independent reviews: `xmlScan.ts` (linear tokenizer) replaces the regex
  attribute scanner; `office.ts` reads XLSX stored values and decodes strictly;
  `pdf.ts` accepts `pdfinfo` output only with exactly one `Pages:` and one
  `Encrypted:` line; `ffprobe.ts` fails closed on more than 8 streams or
  unnamed codecs and reports the largest of container/stream durations;
  `workerExtraction.ts` keeps `error`/`exit` listeners until `terminate()`
  settles; `routes/attachments.ts` drops queued uploads whose response closed,
  races every parser await against the abort signal, and registers in-flight
  uploads so DELETE can abort them (409 `attachment_removed`); the shared
  `isMediaPreviewValidated` rule serves both server and client;
  `src/shared/attachmentFraming.ts` holds the framing helpers and the reserve
  prices the exact strings; one `parseExtractionCoverage`; `guardAttachmentMetadata`
  turns admission invariant errors into `422 attachment_metadata_invalid`;
  `npm run typecheck` now includes tests. New tests: `content_hardening`,
  queued-cancel and DELETE socket tests, the `evaluateCapacity` drift spy,
  mid-run Poppler/ffprobe aborts, brand-patched QuickTime, and more (381 tests
  in 19 files).
- **Final review-fix batch (2026-10-21, same entry).** `ffprobe.ts` now keeps
  the "duration not reported or invalid" refusal whenever the CONTAINER duration
  is missing or invalid (stream durations can only raise the policy value, never
  replace it) and fails validation with "stream duration invalid" for a stream
  duration key that is non-positive, unparsable or over 24 h; the interpretation
  is a pure `interpretProbeJson` with synthetic-JSON tests. `xmlScan.ts` restores
  prefix bindings in reverse order. Conversation DELETE now aborts and awaits
  that conversation's in-flight uploads through the in-flight registry, and the
  upload catch path maps a vanished row/conversation to `409 attachment_removed`
  (cleaning the partial blob) instead of a 500. The composer drops a hydrated
  duplicate card after a successful upload (`settleUploadSuccess`). Binary
  discovery's fixed environment, the 8-stream probe branch and a 60 KB tag-run
  timing bound now have tests. Totals: 398 tests in 23 files.


## XLOG-012 — Required development models and coverage

- **Date:** 2026-10-21
- **Status/source:** User-confirmed DEV-01/02, uncommitted on baseline a96dedf.
- Added project-scoped always-on Cursor/AGENTS instructions, development-policy.md,
  exact Vitest/V8 5.0.5 tooling, all-source coverage and CI/local four-metric 90%
  gates. No app implementation or global approval policy changed.
- Automatic subprocess coverage was tried, then disabled: it injected
  NODE_V8_COVERAGE into fixed-env parser children, violated the existing security
  assertion, and did not collect native worker source. The assertion is preserved;
  worker-only code remains included and uncovered until safely instrumented tests
  cover it. No coverage exclusions or lowered thresholds were added.
- **Measured final result:** 398/398 tests in 23 files pass under coverage;
  statements 60.70%, branches 57.04%, functions 58.82%, lines 63.26%. The command
  correctly exits 1 for all four threshold failures. This is NOT a release pass.
- Coordinated native UI inspection verified picker names but a Fable planning
  submission was denied by administrator policy (Model Blocked); it did not run.
  No substitute or newly requested role execution is claimed. See development
  policy for exact evidence and remaining gates.

## XLOG-013 — GPT Sol planner replacement

- **Date:** 2026-10-21
- **Status/source:** Latest explicit user correction; uncommitted on baseline a96dedf.
- Updated project-scoped always-on rules, AGENTS.md and current development policy/requirements to GPT Sol planner/designer. Preserved historical Fable denial and original Sonet/Fabel spellings as evidence. Actual GPT Sol model identity/execution remains pending; this configuration change does not establish a successful multi-model workflow. No app behavior changed; measured coverage remains below the active four-metric 90% gate.
- **Validation:** Configuration only; 398 tests pass, but coverage is 60.70% statements, 57.04% branches, 58.82% functions and 63.26% lines. No new role execution claimed.

- **Coordinated verification/update:** GPT-5.6 Sol Medium, ID gpt-5.6-sol,
  was individually selected and successfully executed planning reads in another
  project. Installed .cursor/agents/proofestra-{planner,worker,reviewer}.md with
  gpt-5.6-sol, claude-sonnet-5-5 and claude-opus-5-5 respectively; planning/review
  read-only. No new Proofestra role execution is claimed, and actual model identity
  must be checked because Cursor can fall back. No Fable retry.

## XLOG-014 — Coverage gate execution and model-role evidence

- **Date:** 2026-10-21
- **Evidence (this checkout, repo-relative):** `npm run check:parsers` pass (Poppler and ffprobe present); `npm run lint`, server/web/test typecheck pass; `npm run test:coverage` exit 0 twice with identical results (63 files / 1369 tests; 98.23 / 95.36 / 98.92 / 99.26 percent S/B/F/L); a deliberately stricter statements threshold (99.5) exits 1, proving the gate bites; `npm audit --include=dev` 0 vulnerabilities; `npm run build` and `node tests/smoke/worker-dist.mjs` pass. All 53 `src/**/*.{ts,tsx}` files appear in the report. Direct synchronous Office/ZIP/worker-entry tests are instrumented parent-process tests, not child-worker coverage; the real Worker tests and the fixed-env parser assertion are unchanged; `autoAttachSubprocess` stays off.
- **New test scope:** `tests/web/*` (jsdom component/API tests, pinned jsdom 29.1.1 because jsdom 30 requires Node >= 22.22; Testing Library react 16.3.3, dom 10.4.2, user-event 14.6.8), 12 `tests/unit/parsers_*` / `attachments_*_branches` files, and server/coordinator/provider/storage/config files. Per-file floors are not required, but four files are below 90 on one metric (parser child-process defensive branches, `App.tsx` branches 88.45, `Markdown.tsx` unreachable `never` guards, `composerOrder.ts` branches 88.2); the global gate and every global metric pass.
- **Model roles as executed:** planner GPT-5.6 Sol Medium (`gpt-5.6-sol`) produced the plan; worker Claude Sonnet 5.5 High (`claude-sonnet-5-5`) implemented it, with two parallel `proofestra-worker` delegates (parsers/worker; server/coordinator/providers). Each agent reported its own identity; this cannot be independently verified from inside the session, so treat it as agent-reported, not proven. **Opus 5.5 independent review: not yet run.** Operator-run native Chrome QA of picker/paste/drop/reload: pending (no browser scripts used).
- **Not claimed:** any live-provider behavior, remote CI execution, or native-UI correctness.

## XLOG-015 — Independent review closed; evidence and wording corrections

- **Date:** 2026-10-22 (follows RLOG-020 / DLOG-017 / XLOG-014, whose original text is unchanged).
- **Independent review:** Claude Opus 5.5 1M Max Fast (`claude-opus-5-5`), selected and executed in the native Cursor UI as observed by the operator, reviewed the coverage pass without delegation. It reproduced the canonical check in a snapshot (1369 tests; 98.23 / 95.36 / 98.92 / 99.26 percent statements / branches / functions / lines) and found no blocking production defect. One MEDIUM test gap: the `FakeXHR.abort()` in `tests/web/api.test.ts` always emitted `abort`, so the bootstrap-cancel regression also passed against the unfixed `src/web/api.ts`. Correction: the fake now emits `abort` only for a request that was opened and sent (a real XHR emits nothing when aborted before send); a comment-only follow-up states this. Independent A/B on an isolated temp copy: unfixed `api.ts` fails exactly that test (36 pass / 1 fail), current `api.ts` passes 37/37; the original source file was never replaced. A targeted re-review closed the finding; no code or test blocker remains. Full coverage after the correction is unchanged.
- **Role evidence (operator-observed native UI, not live application-provider proof):** GPT-5.6 Sol Medium (`gpt-5.6-sol`) planned; Claude Sonnet 5.5 High (`claude-sonnet-5-5`) implemented with two pinned `proofestra-worker` delegates (a parser child's native header showed Claude Sonnet 5.5); Opus as above. No silent fallback shown; Fable was not retried. This replaces the "agent-reported, not independently verifiable" wording in XLOG-014 for these runs.
- **Corrections to earlier wording (history preserved):** (1) The four web regression cases that failed against the pre-fix `App.tsx` were the send-after-switch and cancel-after-switch pair plus the two delete-after-switch cases; they were NOT the bootstrap upload cancel, which now has its own independent A/B proof above. (2) `Markdown.tsx` is below 90 on statements (86.66) and lines (85.71), not branches (90); `App.tsx` branches are 88.45, `composerOrder.ts` branches 88.23, `boundedProc.ts` branches 88.88. The requirement stays a global 90 on each metric across all 53 production files; no per-file 90 floor exists or is claimed.
- **Historical, pre-coverage evidence (not current-build verification):** the 48-check production content HTTP suite, the 20-pass/1-skip general attachment suite, the real SSE socket checks and the 44-check source-parser/injected-wire suite ran before the coverage pass and the DLOG-017 server fixes.
- **Still pending / not claimed:** final visible-Chrome QA (picker, paste, drop, reload, retry, chat switch during send/stop) and a current-build HTTP check. The `:3000` process is a mixed build (old server modules in memory; rebuilt static UI and workers loaded from disk); a restart needs explicit operator approval, requested and pending, and no restart or server control was performed. Operator read-only data diagnostics, not a QA pass: 15 conversations, 31 messages, 17 runs, 16 attachments, 0 active runs, 0 uploading, 0 orphan blobs, 0 missing ready/bound blobs, migrations 1-5; no user content read. Live providers and remote CI remain unverified.

## XLOG-016 — Native backend implementation and evidence

- **Date:** 2026-10-22 (follows XLOG-015, whose original text is unchanged).
- **Implemented (uncommitted):** `src/core/nativeBackends.ts` (identity, verification record, argv, feature preflight, readiness, frozen policy), `src/core/nativeProc.ts` (supervised bounded job runner), `src/providers/codexCli.ts` (Codex adapter, transcript allowlist, Antigravity refuse-only adapter), backend-keyed dispatch/admission/accounting in `src/core/coordinator.ts`, native adapter table in `src/core/adapters.ts`, native profile validation/readiness in `src/core/profileConfig.ts`, sanitized `native_backends` in `GET /providers`, opt-in `PROOFESTRA_CODEX_*` configuration.
- **Harmless evidence gathered (no inference, no login read, scratch `CODEX_HOME`, credential-free env):** `codex --version`, `exec --help`, `features list` (default and with every deny override), `debug models --bundled`. Captures are in `tests/fixtures/native/`.
- **Tests added:** `tests/unit/native_backends.test.ts`, `tests/unit/native_proc.test.ts`, `tests/adapters/codex_cli.test.ts` (+ `_fakeCodex.ts`), `tests/integration/coordinator_native.test.ts`. They use fake processes and an injected fetch that fails if called; they prove supervision, interpretation and dispatch, not that a real Codex job is safe. A/B proof: forcing an API fallback fails 6 integration tests; replacing the process-group kill with a child-only kill fails 3.
- **Focused results (this checkout):** server/web/test typecheck and lint clean; new modules measured by their own tests alone: nativeBackends 100/97.9/100/100, nativeProc 94.1/85/100/98.9, codexCli 98.5/95.7/100/100 (S/B/F/L %). The all-source gate was NOT re-run; the 1369-test / 98.23-95.36-98.92-99.26 figure in XLOG-014 predates this change and is not current proof.
- **Role evidence:** worker only, Claude Sonnet 5.5 High (`claude-sonnet-5-5`) as identified by the session; the planner (GPT Sol) produced the plan in the prior turn; no substitute-model delegate was used; Opus review pending.
- **Not claimed:** any real Codex or Antigravity execution, live behavior, remote CI, or native-UI correctness.

## XLOG-017 — Native correction evidence and OpenAPI alignment

- **Date:** 2026-10-22 (follows XLOG-016, unchanged).
- **Tests added/changed:** `tests/unit/native_proc.test.ts` (per-line cap: complete newline-terminated, exact boundary, multi-chunk, same-chunk ordering, CRLF), `tests/unit/native_backends.test.ts` (forced login argv, exact status interpretation, policy admission, auth-only ladder state), `tests/adapters/codex_cli.test.ts` (+ `loginText/loginExit/loginStream` in the fake), `tests/integration/coordinator_native.test.ts` (strict/opaque admission and dispatch tamper, ceiling, usage honesty at three levels, API-key login refusal). A/B: removing the line check, the admission policy, the ceiling guard, the login gate or the live-step fix each fails the targeted tests.
- **OpenAPI:** `docs/openapi.yaml` gains `NativeBackendStatus`, `NativeBackendFreeze`, `ProviderList.native_backends/capabilities/catalog_source`, `RunSnapshot.native_backends`, `Usage.consumed_output_tokens`, `ModelProfile` runtime fields (`provider`, `label`, `max_output_tokens`, `api_shape`, wider `readiness`), `BackendKind: native_cli`, and the native admission rule in `ToolPolicyInput`. `delegation_capability` and `execution_controls` are no longer required on profiles because v1 does not return them (deferred). The real `GET /providers` response and a native run's `NativeBackendFreeze`, `Usage` and `ToolPolicy` were validated against the schema once with an ad hoc Ajv check (not committed); `RunSnapshot` as a whole still lists deferred required fields (`spawn_decisions`, `tool_executions`, extension fields) that v1 does not return, and is not claimed conformant.
- **Focused results:** typecheck (all three tsconfigs) and lint clean; 862 tests across 26 integration/adapter/related files pass. The full coverage gate, audit, HTTP and Chrome QA are not run here.
- **Not claimed:** any real Codex or Antigravity execution, that `login status` prints as assumed, or that `forced_login_method` is honored under `exec`.

## XLOG-018 — Opus-review follow-up evidence

- **Date:** 2026-10-22 (follows XLOG-017, unchanged; XLOG-017's OpenAPI disclosure was insufficient because `RunSnapshot` still required deferred fields and six attachment routes were missing).
- **Changed:** `src/core/nativeProc.ts`, `src/core/nativeBackends.ts` (`executableIdentity`, realpath resolution), `src/providers/codexCli.ts`, `src/providers/types.ts` (`AdapterFailure.externalWork`), `src/core/coordinator.ts`, `docs/openapi.yaml`, `package.json` (explicit `ajv8`/`ajv-formats`/`js-yaml` devDependencies; lockfile root entry edited by hand, no network), `AGENTS.md`, `.cursor/rules/proofestra-workflow.mdc`, `docs/development-policy.md`, `docs/requirements.md`, `docs/technical-design.md`, `docs/api.md`, `CONTINUE.md`.
- **Tests added/changed:** `tests/unit/native_proc.test.ts` (escaped descendant, grace, timer leaks), `tests/unit/native_backends.test.ts` (symlink/realpath, identity), `tests/adapters/codex_cli.test.ts` (+ latency, mutate-on-login and escaped-grandchild options in `_fakeCodex.ts`; replaced binary, re-pointed symlink, model confirmation, external-unknown flags, shared budget, containment), `tests/integration/coordinator_native.test.ts` (timeout/abort/bounded wait/exactly-once), `tests/integration/coordinator_live_attachments.test.ts` (failed and successful Live API accounting), new `tests/integration/openapi_contract.test.ts` (8 tests validating real responses with Ajv 8: mock, attachments, fake-native, injected live wire, errors, SSE frames, plus a non-vacuity test).
- **A/B proof (mutations reverted):** removing the model-confirmation check, the identity in the cache key, the pre-launch identity re-check, the containment check, the launched-implies-unknown rule, the shared deadline, the dispatch abort, or the Live failure/success accounting each fails its targeted tests.
- **Focused results (this checkout):** typecheck of all three tsconfigs and lint clean; 18 files / 584 tests across the coordinator, openapi contract, acceptance, content delivery, adapter, native and limits suites pass. The full suite, coverage gate, build, audit, HTTP and Chrome QA were NOT run; the earlier 1537-test baseline is not claimed for this tree.
- **Not claimed:** any real Codex or Antigravity execution; that no descendant can survive (containment is reported unverified, not proven); live-provider behavior.

## XLOG-019 — Clean-checkout 404 contract (order dependence closed)

- **Date:** 2026-10-22 (follows XLOG-018, unchanged).
- **Finding:** in an unbuilt checkout (`dist/public` is git-ignored and the canonical gate builds AFTER the tests) `src/server/app.ts` installed its custom not-found handler only when a client build existed, so an unknown API path got Fastify's default 404 body instead of the documented error envelope. The contract test's "design-only is not served" check therefore failed for `GET /extensions` in a clean checkout while passing on a machine that had been built. The route did not exist in either case; the real defect was the inconsistent runtime 404 body.
- **Fix (narrow):** the not-found handler is now always installed. An unknown `/api/` path always returns `404 not_found "unknown API path"` in the envelope; a non-API path falls back to the SPA only when a build exists and otherwise returns an envelope 404 (`"not found"`). No route, status code or static serving behavior changed when a build exists.
- **Tests:** `tests/integration/openapi_contract.test.ts` runs the served/unserved check in both an explicit unbuilt state and an explicit built state (temp dirs with `process.cwd` pointed at them, never the real repo or its `dist`), asserts the JSON envelope, and that a design-only path never falls through to the SPA page; `tests/integration/server_security.test.ts` adds the unbuilt unknown-API-path envelope case and an envelope body assertion for the unbuilt non-API 404. A/B: restoring the build-conditional handler fails exactly the unbuilt contract case (`get /extensions is documented design_only but is served`) and the two server_security cases; the built case is unaffected.
- **Focused results:** typecheck (server and root tsconfig) and lint of the three touched files clean; 7 server/contract files, 187 tests pass. Full suite, coverage gate, build and audit were not run.

## XLOG-020 — Release verification evidence and Opus closure

- **Date:** 2026-10-22 (follows XLOG-019, unchanged; supersedes the "pending" wording in XLOG-018, XLOG-019 and the CONTINUE checkpoint paragraphs for the items closed below). Documentation only: no source, test, configuration or rule file changed.
- **Evidence record:** [docs/verification/release-verification-2026-10-22.md](../verification/release-verification-2026-10-22.md).
- **Measured (operator, clean isolated locked install, canonical `npm run check`):** PASS, 1,579 tests in 68 files; 56/56 production TS/TSX files in the coverage report; statements 5,792/5,905 = 98.08%, branches 4,138/4,348 = 95.17%, functions 913/923 = 98.91%, lines 5,111/5,149 = 99.26% against the unchanged global 90% floor on each (global, not per file). Parser preflight, lint, three typechecks, server/web build and the compiled-JavaScript worker smoke pass; the production dependency audit reports 0 vulnerabilities; 230 candidate files were hash-identical before and after.
- **Independent review:** Claude Opus 5.5 closed the six XLOG-018 findings plus the clean-checkout 404 (XLOG-019) at 15:04 (UTC+7) on the 14:59 fix, with no code or test blocker; remaining items are Low wording/comment/log nits, not features.
- **Runtime and UI:** the original mock server restarted under guard on the current build with saved-data and session counts unchanged. A fixture-mutation attempt against the existing data was denied by automated review before execution and was not retried. On a disposable loopback dataset served by the same build: 48/48 content HTTP checks over 40 fixtures, 20/20 attachment checks with 0 skipped (with on-disk checks), and SSE tail/replay/resume/security checks passed. Native Chrome QA (screenshots plus native mouse/keyboard, no DOM or Playwright automation) passed picker upload with full-text preview, a mock Team run of 7 steps, the simulated-usage inspector, reload persistence and the 25 MiB cap rejection of a 26 MiB fixture. **Not completed natively:** clipboard image paste, mixed multi-selection, throttled progress/retry/cancel and native Thai input via the driver; HTTP checks cover related API behavior but do not prove that native UX.
- **Documentation corrections made here:** stale "Opus review / Chrome QA / HTTP check pending" statements in `README.md`, `CONTINUE.md` and `docs/development-policy.md` now point to the evidence record and keep the four open native interactions explicit. Production source comments were deliberately left unchanged.
- **Not claimed:** remote CI (at this local checkpoint nothing was published; later publication and CI results belong to the pull-request checks); live-provider or real Codex/Antigravity behavior (still `unverified`, refusing); native UX for the four open interactions; that documentation edits after the run were re-verified.

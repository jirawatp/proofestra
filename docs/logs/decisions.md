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

## DLOG-008 — Share extensions at the harness boundary

- **Date / status:** 2026-10-17; shared skills/plugins/custom MCP are confirmed user
  scope. A central catalog, manifest/broker model and lifecycle policy are proposed
  engineering decisions, pending mock and integration validation.
- **Reason / choice:** Reuse canonical namespaced capabilities across providers
  instead of requiring separate vendor installations. Skills supply progressively
  loaded instructions/resources; plugins bundle versioned references; a central
  broker maps custom MCP through compatible adapters or approved enabled helpers.
  Native vendor formats and hosted capabilities still need specific compatibility.
- **Consequence:** Global/workspace scopes, wire-safe collision-checked aliases and
  immutable version/digest snapshots preserve identity/provenance. Imports grant no
  permissions or startup execution. Recheck current authorization; disabled or
  superseded versions need explicit retained enablement/authorization before use.
  Keep central secrets and approval control isolated, and keep root-branch scratch,
  handles and results separate even when server registration is shared.
- **Trace / source:** Current user request; preceding baseline [1374641]; delivered
  by the containing commit on `codex/project-traceability`. Trace EX-01–EX-08,
  A21–A25, AG-03/07, TL-01/03/04 and PV-02. See [extension policy](../extensions.md)
  and RLOG-009 in the [requirement log](requirements.md). Extends DLOG-004/006 while
  preserving grant boundaries, helper enablement, candidate status and no parity
  guarantee. No previous historical entry is rewritten.
- **Evidence:** Design documentation checks only; no imports, installations,
  MCP connections, vendor calls or paid validation were run.

## DLOG-009 — Local v1 implementation: terminal CAS, bounded ledger, sanitized adapters

- **Date / status:** 2026-10-21; confirmed implementation decisions delivered by the
  containing commit on `codex/project-traceability`. Mocks are the development
  default and Live remains opt-in; no paid provider calls were made.
- **Reason / choice:** The uncommitted local v1 code implements the user-visible
  guarantees that earlier design documents only described. The independent review
  on 2026-10-21 showed that (a) the first-pass coordinator admitted infeasible
  plans and completed with `output_tokens=null`, (b) the adapters still echoed
  upstream body text and caught `Error.message` into failure strings, and (c)
  cancellation had a stale-snapshot CAS race. Each item required a code decision,
  not another design note.
- **Consequence:** The run coordinator now resolves idempotency BEFORE catalog /
  live / policy admission checks (so a prior successful run replays after Live
  is disabled or the catalog rotates); rejects infeasible base plans
  (`base_planned_calls × max_output_tokens_per_call ≤ total_output_tokens`);
  wraps every `adapter.generate()` in a `Promise.race` with a hard per-call
  timeout and the overall run in a deadline guard that releases the serialized
  `globalActive` slot even when an adapter ignores `AbortSignal`; and commits
  each state transition (`appendEvent` + `updateSnapshot`) atomically in a
  SQLite transaction, emitting on the bus only after the commit returns. Terminal
  state is immutable: late adapter callbacks that arrive after the terminal
  commit are discarded and the outstanding reservation drains into the
  conservative numeric `consumed_output_tokens` ledger. Provider-reported
  `input_tokens`/`output_tokens` keep sticky-unknown semantics (CT-06): they
  start at 0, grow with known contributions, and collapse to `null` for the rest
  of the run as soon as any dispatched invocation reports unknown. The three
  live adapters discard every upstream body, caught Error message and vendor
  stop/finish/block string, surfacing only fixed boilerplate + HTTP status +
  allowlisted enum values through `src/providers/_sanitize.ts`. The server
  profile catalog is content-addressed: `catalog_version` hashes the resolved
  profile set so a model_id change under the same `profile_id` rotates the
  version and invalidates stale UI pins.
- **Trace / source:** Current user request on 2026-10-21; preceding baseline
  [a96dedf]; implementation delivered by the containing uncommitted work on
  `codex/project-traceability`. Trace CT-01–CT-08, PR-01–PR-07, PV-02–PV-06,
  AG-02/05/07, TL-01–TL-04. See [technical design](../technical-design.md),
  [API](../api.md), [architecture](../architecture.md), XLOG-007 in the
  [design log](design.md) and RLOG-010 in the [requirement log](requirements.md).
  Extends DLOG-004/005/006; does not supersede them.
- **Evidence:** 92 automated tests pass (unit + 54 adapter sanitization checks
  across OpenAI/Anthropic/Gemini × 4 injected marker strings × 4 upstream
  behaviours + integration checks for infeasible-plan rejection, sticky-unknown
  CT-06 aggregation, late-success + never-settling adapter guards, idempotency
  replay before catalog admission, content-addressed catalog version rotation,
  atomic terminal commit, defaulted tool-off / helpers-off send). `npm run
  build` emits `dist/public` and `dist/server`; `npm start` on port 3101 served
  a complete quick run with `status=completed`, `input_tokens=115`,
  `output_tokens=120`, `consumed_output_tokens=120`, `reserved_output_tokens=0`.
  `npm audit` reports 0 vulnerabilities. No live provider call was made and no
  credential appears in any log, snapshot, event, or export.

## DLOG-010 — Acceptance pass: id persistence, concise mock, framing-aware context

- **Date / status:** 2026-10-21; confirmed decisions delivered by the containing
  uncommitted work on `codex/project-traceability`, on top of DLOG-009.
- **Reason / choice:** The user's independent QA pass confirmed the DLOG-009
  implementation (infeasible admission rejected, Team-3 → 7 calls, idempotent
  replay, abort-ignoring 5s hard timeout, next run succeeds). The same pass
  surfaced four smaller but required decisions: (1) reload should restore the
  selected chat without introducing a server round-trip for every URL change;
  (2) mock output was echoing the full reference material and producing a
  massive repetitive synthesis bubble; (3) the context estimator's `bytes/2`
  factor was undocumented and had no provider-side framing allowance; (4) the
  README/CONTINUE/log set still read like a design-only project.
- **Consequence:**
  - **Selected-chat persistence.** The web client persists ONLY the selected
    `conversation_id` to `localStorage` under
    `proofestra:selected-conversation-id:v1`. Shape is validated as a UUID on
    read, missing/deleted ids are cleared silently, and no other state
    (titles, prompts, run ids, provider identities, credentials) is stored
    client-side. The server remains the source of truth and private browsing
    / disabled storage degrade gracefully.
  - **Concise deterministic mock fixtures.** Draft/review/synthesis stages
    render a short, deterministic answer that cites a prompt digest, counts
    the peer artifacts, and preserves disagreement and uncertainty, instead
    of echoing the full reference material. The coordinator still feeds each
    stage the complete reference, so the full inspectable artifacts remain
    in each step's `output` in the run inspector; the final-answer bubble is
    no longer enormous. The `mock-fail-review` profile label is now
    consistent with its code path (drafts and synthesis succeed; only review
    fails).
  - **Framing-aware context admission.** `src/core/context.ts` defines
    `BYTES_PER_TOKEN_FLOOR = 2`, `CHARS_PER_TOKEN_FLOOR = 4`,
    `TOKENS_PER_MESSAGE_FRAMING = 8`, and `TOKENS_FOR_REPLY_FRAMING = 8`
    with the derivation written at the top of the file (worst-case per-byte
    and per-char tokenizer ratios across OpenAI o200k/cl100k, Anthropic
    Claude 3, Google Gemini SentencePiece, plus the OpenAI cookbook's
    `tokens_per_message = 3` and reply `+3` as a lower bound we exceed).
    `worstCaseReferenceTokens` now returns a token count; the coordinator
    passes it via the new `referenceMaterialTokens` input so the admission
    check does not reify a synthetic string and double-charge byte/char
    overhead. Normal Team-3 admission on a 128k-safe profile with 2048-token
    per-call reserve now holds; a near-limit 8k profile with the same
    reserve correctly rejects.
  - **Documentation.** The README now has a concrete setup/run section
    (Node 22.19+, `npm ci`, `npm run dev`, `npm run build`, `npm start`),
    the server-only env credentials table with a working example, a profile
    JSON example with multiple same-provider models, mock-vs-live
    costs/privacy/limits, the exact checks CI would run, and the explicit
    scope exclusions (no helpers/tools/MCP/plugin execution, no streaming,
    no native surfaces, no correctness guarantee).
- **Trace / source:** Current user request on 2026-10-21; preceding
  implementation DLOG-009. Trace CT-03, CT-04, CT-07; AG-02/05; PR-04/05.
  Extends DLOG-009; does not supersede it.
- **Evidence:** 100 automated tests pass (`npx vitest run`), including 9 new
  context/framing regressions covering ASCII, Thai, emoji, framing-dominant
  short-message, and Team-3 worst-case synthesis admission. `npm audit
  --production=false` continues to report 0 vulnerabilities. `npx eslint
  src tests --max-warnings 0`, `npx tsc -p tsconfig.server.json --noEmit`,
  and `npx tsc -p tsconfig.web.json --noEmit` all pass clean. `npm run
  build` emits `dist/public` + `dist/server`. No live provider call was
  made; no credential appears in any log, snapshot, event, or export. The
  Vite dev proxy pattern is `"^/api/"` (not `"/api"`); the old prefix
  intercepted `/api.ts` and blanked the page. The user's owned Terminal 2
  runs `PROOFESTRA_MOCK_LATENCY_MS=5000 npm run dev` for visible-cancellation
  verification; browser-level E2E remains outside this test harness.

## DLOG-011 — Terminal accounting single-charge, Partial preservation, truncation, and acceptance regressions

- **Date / status:** 2026-10-21; confirmed decisions delivered by the
  containing uncommitted work on `codex/project-traceability`, on top of
  DLOG-010. The user's final review surfaced four concrete correctness
  decisions and a broad test-coverage requirement; this log records the
  chosen behavior.
- **Reason / choice:**
  - **Single owner of the drain step.** The accounting ledger has one
    place to move outstanding reservations into `consumed_output_tokens`
    and zero `reserved_output_tokens`: `finalize()`. Any late-callback
    code path that observes a terminal state must return without
    mutating usage. Running the drain twice (`finalize()` → late success
    → late failure) was double-charging the ledger and could drive
    `reserved_output_tokens` negative in in-memory snapshots consumed by
    the UI and SSE replay.
  - **Preserve useful artifacts on overall deadline.** Committing
    `failed` while ≥1 drafts (and sometimes synthesis) have already
    returned a usable answer discards work the user already paid for and
    denies them the only artifact that remains. The overall-deadline
    guard therefore commits `partial` with a `draft_fallback` or
    `team_synthesis` presentation when any useful artifact exists.
  - **Truncated output is Partial.** Provider truncation
    (OpenAI/length, Anthropic/max_tokens, Gemini/MAX_TOKENS) is a
    documented loss of information and must not be surfaced as full
    completion. Any step finding matching `/truncat/i` promotes the run
    to `partial` with a `truncated_output` reason.
  - **Testable coverage replaces one-off QA scripts.** The user's
    Fastify-inject QA was running from ad-hoc scripts outside the
    repository; the acceptance guarantees belong in a committed test
    file so later changes cannot silently regress them.
- **Consequence:**
  - `src/core/coordinator.ts`: `runSingleStep` late-success and
    late-failure branches return immediately on terminal state; the
    overall-deadline guard promotes to `partial` with a
    draft/synthesis-backed presentation when useful artifacts exist; a
    truncation detection loop scans step findings after per-stage
    aggregation and downgrades status with a limitation line.
  - `src/providers/mock.ts` + `src/core/profileConfig.ts`: fixture
    schema gains `only_on_stage: "draft" | "review" | "synthesis"` and a
    new `truncated` scenario (which reports a truncation finding +
    conservative output tokens matching the reservation).
  - `src/server/app.ts`: `AppBundle` exposes `db`, `runs`, `events`,
    `conversations`, `messages` strictly for in-process integration
    tests. HTTP routes continue to use the narrower `RouteDeps`
    interface, so this exposure does not widen the HTTP surface.
  - `tests/integration/acceptance.test.ts`: 16 new behavior-focused
    regressions (terminal non-double-charge, overall-deadline Partial,
    Team-3 exact-7 happy path, per-provider concurrency, mixed
    known/unknown Team usage, review-only and synthesis-only partial
    failures, truncated-output ≠ completion, Host/Origin/CSRF rejection,
    SSE replay & unique assistant, restart interruption, active-run
    guards + export secret exclusion). Fastify DELETE calls strip
    `content-type: application/json` to avoid `FST_ERR_CTP_EMPTY_JSON_BODY`.
- **Trace / source:** Current user request on 2026-10-21; preceding
  implementation DLOG-010. Trace CT-04/05/06/07, PV-01/02/05, AG-02/05,
  UX-04. Extends DLOG-010; does not supersede it.
- **Evidence:** 119 automated tests pass (`npx vitest run`). `npm audit
  --production=false` reports 0 vulnerabilities. `npx eslint src tests
  --max-warnings 0`, `npx tsc -p tsconfig.server.json --noEmit`, `npx tsc
  -p tsconfig.web.json --noEmit`, and `npm run build` all pass clean. No
  live provider call made; no credential surfaced in any log, snapshot,
  event, or export (`sk-`, `AIza`, and injected marker strings are
  explicitly scanned in the export regression). Agent-run Fastify-inject
  regression asserts the cancel path leaves zero assistant messages for the
  canceled run; this is a server-side invariant check and does not attest
  to any specific browser session. Browser-level E2E remains outside this
  test harness.

## DLOG-012 — Attachment admission, storage, and native projection

- **Date:** 2026-10-21
- **Status:** Confirmed, implementation landed in the containing commit.
- **Decisions:**
  - **Store-wide upload gate replaces per-conversation gate.** A single
    `UPLOAD_GATE` with concurrency 1 and a bounded waiting queue honors
    the shared `max_store_bytes`. The 120 s per-upload deadline aborts the
    request stream, awaits writer / extraction cleanup, then releases.
    This resolves the earlier identity-compare bug where the gate map
    retained a fresh `prev.then(...)` continuation and never dropped
    completed waiters.
  - **`markReady` is deferred until multipart EOF.** Hash, byte size,
    head slice, declared MIME, and extraction all accumulate in a local
    `pending` value. The row flips to `ready` only after the parts loop
    returns successfully. `cleanupPartialBlob` double-checks state and
    never unlinks a `ready` or already-bound blob — closing the
    window where a trailing invalid multipart could delete bytes bound
    to a sibling tab's user message.
  - **Multipart parser error → 4xx classification.** `FST_FILES_LIMIT →
    400 too_many_files`, `FST_REQ_FILE_TOO_LARGE → 413 file size`,
    `ERR_STREAM_PREMATURE_CLOSE / FST_PARTS_LIMIT / FST_FIELDS_LIMIT /
    FST_PROTO_VIOLATION → 400 multipart_malformed`. Independent
    agent-run realHTTP QA that previously saw 500 upload_failed for
    malformed / extra-file bodies now records 4xx.
  - **CSP preservation in `onSend`.** The global security hook only
    sets `cache-control`, `x-frame-options`, and
    `content-security-policy` if the route did not already set them.
    The sandboxed attachment preview routes continue to supply the
    strictest CSP; the global default no longer overrides them.
  - **XHR CSRF header set exactly once.** `uploadAttachment` awaits
    `boot()` first, short-circuits on an already-aborted signal, rejects
    on boot failure, and sets `x-csrf-token` once before `send()`. The
    doubled header (`token,token` → 403) is gone. Tokens are never
    logged.
  - **StrictMode-safe composer.** `addComposerFiles` keeps its state
    updater pure; network work and `AbortController` wiring happen in
    an effect guarded by `uploadStartedRef` to dedupe StrictMode's
    double-invoke. Remove / cancel calls the real controller.
  - **Reloaded failed drafts require re-select.** `fileHandle` on a
    composer row is `File | null`; `null` after reload. Retry rejects
    with a visible "re-select the file" message instead of uploading
    `new File([])`.
  - **Full-payload pending-submit digest.** The pending-submit key
    incorporates the ordered prompt + mode + execution_mode + agents +
    profile + synthesizer + file refs. A different mode or file set no
    longer reuses the earlier pending submission.
  - **Typed `MessageContentPart` native projection.** OpenAI
    ChatCompletions receives `image_url` / `file` parts, Anthropic
    Messages receives `image` / `document` blocks with
    `source.base64`, Gemini v1beta `generateContent` receives
    `inlineData` for image / PDF / audio / video. The adapter is the
    only place in the server that materializes raw bytes; nothing is
    written to run JSON, SSE events, snapshots, or exports. Mock
    adapter honestly says it did not read the bytes.
  - **Dependency bump.** `@fastify/multipart` 9.0.3 crashed the Node
    process on malformed multipart with an unhandled FileStream error
    (upstream
    [issue #594](https://github.com/fastify/fastify-multipart/issues/594),
    fixed by [PR #595](https://github.com/fastify/fastify-multipart/pull/595)
    in v9.3.0 / v9.4.0 and carried into
    [v10.1.4](https://github.com/fastify/fastify-multipart/releases/tag/v10.1.4)).
    Exact-pinned to 10.1.4. Node version is unchanged (22.19.0 per
    `.nvmrc`). Defense-in-depth `part.file.on("error", …)` and
    `request.raw.on("error", …)` listeners are added so a future
    regression does not re-crash the process.
- **Affected requirement IDs:** AT-01 through AT-05 (RLOG-015), PV-01 /
  PV-02 / PV-05 (privacy), AG-02 / AG-05 (bounded concurrency), UX-04
  (single assistant terminal commit).
- **Supersedes / extends:** None superseded. Extends DLOG-011 (terminal
  accounting + Partial preservation) with attachment-flow invariants.
- **Source / evidence:** Code and test paths as cited in RLOG-015.
- **Validation:** Agent-run in this checkout.
  - 138/138 vitest, 10 files (adds 6 real-HTTP attachment regressions on
    an isolated port + dataDir, 5 injected-fetch native-wire contract
    tests). The native-wire tests assert the exact JSON body shape
    sent to each vendor endpoint; see
    [`tests/adapters/native_attachments.test.ts`](../../tests/adapters/native_attachments.test.ts).
  - `npm audit --include=dev` reports 0 vulnerabilities.
  - `npx eslint src tests --max-warnings 0`,
    `npx tsc -p tsconfig.server.json --noEmit`,
    `npx tsc -p tsconfig.web.json --noEmit`,
    `npm run build`, and `git diff --check` all clean.
  - No live-provider call was made and no credential was supplied at
    any point during validation. The visible-Chrome paste / mixed /
    retry / remove / reload / drop verification is scheduled under the
    user's control after this checkpoint.

## DLOG-013 — History-complete projection, capacity-faithful admission, dimension-aware preview, mock-effective caps, sanitized read errors, scoped composer rehydration

- **Date:** 2026-10-21
- **Status:** Confirmed, implementation landed in the containing commit on
  top of DLOG-012.
- **Decisions:**
  - **Typed history projection covers the full union of refs.**
    `projectHistoryWithAttachments` and the frozen
    `attachment_coverage.routes` map now cover every historical user
    message's refs (not just the current turn's). Follow-up draft /
    review / synthesis stages re-send the actual bytes or extracted
    text of the attachment the model already inspected. The native
    aggregate budget is enforced across the full union at admission.
    Current-turn `context.attachments` remains the small set of new
    refs; identity is still carried by the frozen `message_ids`.
  - **Capacity reflects the normalized projection at admission AND
    dispatch.** `evaluateCapacity` takes a conservative
    `attachmentTokens` reserve equal to the sum of per-ref
    `nativeImageTokenReserve` / `nativeNonImageTokenReserve` /
    `extractedTextTokenReserve` under the frozen routing decision.
    Admission can reject infeasible combined current / historical
    input before any model call is made (regression: eight 24k Thai
    extracts on a low-capacity profile now fail at admission).
  - **Image dimensions are persisted and required for native + inline
    preview.** `markReady` persists magic-byte sniffed width / height
    for PNG / GIF / WebP. JPEG stays "dimensions unknown" because our
    64-byte head sniff never reaches the SOF marker. `routeNativeAttachment`
    refuses native-image routing when dimensions are null, non-finite,
    non-positive, exceed `max_native_image_side_px` (4096), or exceed
    `max_native_image_pixels` (16 Mpx).
  - **PDF stays explicit attachment-only in v1.** The adapter still
    supports native PDF wire shapes, but v1 has no bounded page-count
    parser to admit a conservative token reserve. Routing refuses
    native-PDF and prefers extracted text when available. Audio /
    video with unverified duration also stay attachment-only.
  - *(Superseded by DLOG-014: PDF pages are validated and native PDF is routed; the byte-size reserve is replaced by the shared reserve.)*
  - **Preview endpoint refuses unsafe raster inline with 422.** The
    `/preview` surface now returns `422 preview_unavailable` with no
    raster bytes when a raster image's persisted sniffed dimensions
    are unknown, invalid, or exceed the preview-safety caps (same
    bounds as native eligibility). `/download` continues to serve
    the same bytes with `Content-Disposition: attachment` so a
    user-initiated download remains possible. The UI mirror
    `isPreviewImageDimensionsSafeClient` skips the `<img>` tag for
    unsafe rows and renders an explicit download-only fallback card.
    This matches the no-byte preview-refusal requirement and avoids
    eager inline embedding triggering a download.
  - **Per-profile capability caps + mock-effective routing + catalog
    digest.** `ModelProfile.capabilities` is an optional override that
    can tighten (never widen) the provider defaults. Admission uses
    `effectiveCapabilitiesFor(profile, effectiveProvider)` with
    `effectiveProvider = "mock"` when `executionMode === "mock"`, so
    an OpenAI-profile agent in mock mode receives no-native caps and
    the coverage projection records attachment-only. The catalog
    digest (`catalogVersion`) incorporates the per-profile override so
    a change rotates the version and invalidates any stale UI pin.
  - **Sanitized attachment-read errors in all three adapters.** The
    OpenAI / Anthropic / Gemini adapters read attachment blobs through
    small helpers that collapse any filesystem error to an
    `attachment_unreadable` AdapterFailure with a fixed sanitized
    label — no absolute path, no errno, no raw `err.message` reaches
    the run snapshot, SSE frames, or exports. `AttachmentRepo.markFailed`
    also scrubs the stored message defensively against future callers
    that might pass raw strings.
  - **UI: safe pre-send previews.** The composer renders inline
    previews for image / audio / video / text via the authenticated
    same-origin preview endpoint, and a fallback card for everything
    else (PDF / docx / zip / binary). HTML / SVG / XML / office is
    never rendered as active content.
  - **UI: rehydration preserves in-flight tracking.** A `mergeComposerWithServer`
    helper joins the server's authoritative draft list with the
    composer's in-memory rows by `serverId`, preserving `localId`,
    `fileHandle`, `controller`, and `progress` for anything still
    uploading in this tab. A bounded exponential poll resolves rows
    the server still shows as `uploading` after a chat switch.
  - **UI: send settlement scoped to the origin conversation + exact
    submitted refs.** `activeRun` / prompt clear / composer clear only
    run when the user is still viewing the chat they submitted from,
    and the composer clear drops only the rows that were actually
    submitted. The pending-submit digest also includes each agent's
    display `name`.
  - **UI: XHR 401 invalidates the cached boot/session.** `uploadAttachment`
    mirrors the generic `request()` 401 handling: a 401 drops the
    cached CSRF token and the pending bootstrap promise so a
    subsequent explicit retry re-bootstraps from scratch. There is
    no automatic resubmit of an uncertain POST.
  - **UI: localStorage keeps only opaque ordered ready ids.** A
    `proofestra:composer-order:v1` key stores at most 16 UUID-shaped
    ids per conversation. On reload the server list wins for
    identity; the local order wins for arrangement. No bytes, display
    names, MIME types, extracted text, or secrets are persisted.
- **Affected requirement IDs:** AT-01 through AT-05 (RLOG-016), PV-01 /
  PV-02 / PV-05 (privacy), AG-02 / AG-05 (bounded concurrency),
  UX-04 (single assistant terminal commit).
- **Supersedes / extends:** None superseded. Extends DLOG-012 with
  the full-history projection, capacity-faithful admission, image /
  PDF / audio / video routing policy, preview-dimension refusal,
  mock-effective caps, sanitized adapter read errors, and the UI
  safe-preview / rehydration-merge / settlement-scope / XHR-401 /
  ordered-ready-ids changes.
- **Source / evidence:** Code and test paths as cited in RLOG-016.
- **Validation:** Agent-run in this checkout.
  - **174/174** vitest across 11 files; the aggregate adds 36 tests
    over the DLOG-012 138 baseline: full-history coverage,
    dimension-faithful routing, bounded capacity, sanitized reads,
    preview-dimension refusal, composer merge, scoped settlement,
    XHR 401, opaque ordered ids.
  - `npm audit --include=dev` reports 0 vulnerabilities.
  - `npx eslint src tests --max-warnings 0`,
    `npx tsc -p tsconfig.server.json --noEmit`,
    `npx tsc -p tsconfig.web.json --noEmit`,
    `npm run build`, and `git diff --check` all clean.
  - No live-provider call was made and no credential was supplied
    at any point during validation. The visible-Chrome paste / mixed
    / retry / remove / reload / drop verification remains scheduled
    under the user's control.

## DLOG-014 — Bounded content analysis: node:zlib, migration 5, wire MIME, shared reserve, worker isolation

- **Date:** 2026-10-21
- **Status:** Engineering choices derived from the user's 2:52/2:59 PM
  (UTC+7) requests (the user-specified parts are listed in the current
  decision register, not here) and **proposed defaults** (marked below), both landing
  in the containing commit on top of [`a96dedf`][a96dedf].
- **Implementation choices (not separately confirmed by the user):**
  - **`node:zlib` instead of `fflate`.** `inflateRawSync` with `maxOutputLength`
    plus `zlib.crc32` (Node 22.19) fixes the zlib-wrapper-on-raw-deflate bug and
    removes a dependency; `fflate` is uninstalled and the lockfile regenerated.
  - **Migration 5, not an edit of migration 4.** Migration 4 (pages, duration,
    streams) was never applied in the two inspected databases but may be in
    another; applied migrations are immutable. Migration 5 adds
    `validated_media_format` and `normalized_media_mime`.
  - **Three distinct media identifiers:** sniffed MIME, validated container
    `format_name`, and a normalized wire MIME that exists only after a
    successful probe whose container family matches the sniffed type.
  - **Gemini MIME names:** `audio/mpeg` is kept (documented by Gemini);
    `video/quicktime` becomes `video/mov` only after validation; unvalidated
    QuickTime is attachment-only.
  - **One reserve:** `nativeAttachmentTokenReserve` serves admission and dispatch;
    `nativeNonImageTokenReserve` is deleted.
  - **One notice** (`UNTRUSTED_ATTACHMENT_CONTENT_NOTICE`) before extracted text and
    every native part in all adapters.
  - **Worker isolation:** Office/ZIP parse in a `worker_threads` worker with
    `resourceLimits`, an empty environment and an awaited `terminate()`.
    `--import tsx` in worker `execArgv` does not register tsx's resolver in a
    worker (verified on Node 22.19), so the source runtime bootstraps
    `tsx/esm/api` inside the worker; the built runtime loads the `.js` worker.
  - **ffprobe over a file descriptor**, `-protocol_whitelist fd`, fixed format
    whitelist, `-fd 0 -i fd:` (a regular file descriptor preserves WAV seeking and
    duration; `pipe:` does not).
- **Proposed defaults (implemented, tunable, not vendor limits):** native PDF at
  most 20 pages x 3,000 tokens/page + 1,024 framing; at most 120 s per media
  attachment and 120 s / 12 MiB total media per call; 64 tokens/s audio and 512
  tokens/s video + 1,024 framing; native reserve at most 50% of a profile's safe
  input with extracted-text/attachment-only fallback; a timed-out `pdftotext`
  with safe non-empty text is returned as partial (the user asked for partial
  text on overflow only, so timeout is an extension) while a `pdfinfo` timeout is
  a failure.
- **Supersedes:** DLOG-013 "PDF stays explicit attachment-only in v1" and its
  byte-size reserve (`max(2048, bytes/2)`); the fflate pin from the earlier
  attachment work.
- **Affected requirements:** AT-01..AT-05, AG-07, AG-08, CT-01, CT-04, CT-05,
  PV-01, PV-02, PV-04. Current register: [decisions](../decisions.md).
- **Evidence:** Poppler 26.04.0 and ffprobe 7.1.1 behavior on the synthetic
  fixtures; public Gemini documentation (supported audio/video MIME names, 20 MB
  inline request threshold) read 2026-10-21; Anthropic's documented approximate
  per-page PDF cost informed the 3,000 tokens/page default.
- **Validation:** see RLOG-017 and XLOG-011. No live call; no credential read.

- **Review corrections (2026-10-21).** Same unlanded change; no new ID. The
  "confirmed" label above was too strong: only the user-specified items (see
  [decisions](../decisions.md)) are confirmed, the rest are engineering choices
  and proposed defaults. Added engineering choices: fail-closed `pdfinfo`
  parsing and media stream validation (a document or file must not pick its own
  validated metadata), XLSX stored-value reading, strict UTF-8 for Office XML,
  one shared preview rule, `max(container, stream)` policy duration, framing
  helpers in `src/shared` so reserves price the exact framed text, and
  `catalog_source.file_configured`. Known limitation recorded as a proposed
  default pending the user's choice: audio with embedded cover art is refused
  for native audio. Source URLs read 2026-10-21: Gemini
  <https://ai.google.dev/gemini-api/docs/audio> and
  <https://ai.google.dev/gemini-api/docs/video-understanding>; Anthropic
  <https://platform.claude.com/docs/en/build-with-claude/pdf-support>.
  Final batch: a missing/invalid container duration always refuses (stream
  durations only raise the policy value) and an invalid stream duration makes
  the file unvalidated; conversation DELETE aborts and awaits that
  conversation's in-flight uploads (chosen over returning 409 while uploading).
## DLOG-015 — Required development models and coverage

- **Date:** 2026-10-21
- **Status/source:** User-confirmed request, uncommitted change on baseline a96dedf; no authorization for new spending, keys or publication.
- Confirmed roles and coverage scope are recorded in DEV-01/02. Engineering implementation: project .mdc alwaysApply + AGENTS.md; exact matching Vitest/V8 5.0.5; all src TS/TSX included with no production exclusions; four 90% thresholds, no auto-update; local check and CI gate. These instructions do not programmatically force a Cursor model. Native UI was unavailable at configuration time, so requested-model execution is not claimed.
- **Validation:** 398/398 tests pass; measured coverage is 60.70% statements,
  57.04% branches, 58.82% functions and 63.26% lines. All four 90% gates fail.
  A coordinated native Cursor check lists the requested model families, but Fable
  planning was Model Blocked by administrator policy and did not execute. The
  worker label is Claude Sonnet 5.5 High (user wrote Sonet). No substitute,
  live-provider call, or newly requested Proofestra model-role run is claimed.

## DLOG-016 — GPT Sol planner replacement

- **Date:** 2026-10-21
- **Status/source:** Latest explicit user correction; uncommitted on baseline a96dedf.
- Confirmed GPT Sol planner/designer replaces denied Fable, superseding that role choice in DLOG-015. No further Fable retry, silent model substitution, guessed GPT Sol version or execution claim. No new keys/spending/grants/publication. Other requested roles and coverage thresholds are unchanged.
- **Validation:** Configuration only; 398 tests pass, but coverage is 60.70% statements, 57.04% branches, 58.82% functions and 63.26% lines. No new role execution claimed.

- **Coordinated verification/update:** GPT-5.6 Sol Medium, ID gpt-5.6-sol,
  was individually selected and successfully executed planning reads in another
  project. Installed .cursor/agents/proofestra-{planner,worker,reviewer}.md with
  gpt-5.6-sol, claude-sonnet-5-5 and claude-opus-5-5 respectively; planning/review
  read-only. No new Proofestra role execution is claimed, and actual model identity
  must be checked because Cursor can fall back. No Fable retry.

## DLOG-017 — Fail-closed and race fixes found while testing

- **Date:** 2026-10-21
- **Status/source:** Defects proven by failing tests first, then fixed minimally (worker pass; uncommitted on baseline a96dedf). Review pending.
- **Web (`src/web/App.tsx`, `src/web/api.ts`):** a send or cancel response arriving after a chat switch no longer repaints the visible chat, merges into its run list or replaces its SSE subscription (the run is recovered from `active_run_id` on return); a delete decides against the CURRENT selection; cancelling an upload during session bootstrap settles immediately and never opens the request. Four regression tests fail against the unfixed code and pass now.
- **Server:** malformed %-encoded session cookie fails closed (401 / fresh session, never 500) via one shared `parseCookie`; fractional `PROOFESTRA_PORT` rejected; `http://[::1]` extra origins accepted; invalid conversation cursor 400 `invalid_cursor`; run limit above deployment ceiling 422; non-multipart upload 415; root error handler with a fixed 5xx message; SSE headers flushed immediately; an empty or whitespace-only provider answer is a failed step (`model_unavailable`), never a blank assistant message; over-long direct `createRun` prompt is 422 `context_too_large`; `close()` rejection at shutdown no longer leaves an unhandled rejection.
- **Affected:** AT-02/A26 via RLOG-020; docs/api.md error section. **Unchanged:** OpenAI maps 403 to `invalid_request` while Anthropic/Gemini map it to `authentication`; tests pin current behavior, no change decided.

## DLOG-018 — Native CLI backends: fail-closed Codex, unverified Antigravity

- **Date:** 2026-10-22
- **Decision (confirmed by the user's 2026-10-22 instruction; implementation choices proposed until review):** model subscription-backed local CLIs as a separate `native_cli` backend kind selected by frozen backend ID, never by provider label; keep Codex execution disabled until every tool-surface control is proven for the installed CLI version; keep Antigravity unverified/disabled.
- **Why "read-only sandbox" is not enough:** the sandbox governs model-generated shell commands only. In 0.163.0 the exec/shell surface cannot be switched off per invocation and apply_patch plus the code-mode tool mode come from the model catalog, so the preflight (deny overrides plus effective-state check against a classified allowlist) correctly fails today. The recorded verification evidence lives in `src/core/nativeBackends.ts` (`CODEX_VERIFICATION`) and `tests/fixtures/native/`.
- **Rejected alternatives:** reading or forwarding the ChatGPT login/token (violates TL-06); an API-key fallback (paid substitution); trusting the sandbox as a no-tools control; guessing Antigravity flags; reusing `runBoundedProc` (fixed env, no stdin, no process-group kill).
- **Unchanged:** Apache-2.0 core; mock-default; live opt-in; the all-source 90% coverage floors.
- **Affected:** PR-08..PR-13, DEV-03, CT-06, CT-08, TL-06; docs/technical-design.md "Native CLI backends", docs/provider-capabilities.md, docs/api.md.
- **Re-enable path (not authorized here):** a CLI version for which an invocation-only control demonstrably removes the tool surface, recorded as enforced controls in the verification record with fresh evidence, then an operator-approved opt-in test through the vendor's already-signed-in surface.

## DLOG-019 — Subscription-only authentication gate, native admission policy and honest native accounting

- **Date:** 2026-10-22 (supplements DLOG-018, unchanged).
- **Decision (confirmed scope; implementation choices proposed until review):** (1) the Codex adapter refuses to launch unless the vendor's own `codex login status` reports exactly `Logged in using ChatGPT` (checked every job; a cached API-key login would otherwise bill the paid API) and the invocation also passes `forced_login_method="chatgpt"`; (2) a native job is admitted only for explicit `bounded_job` + `allow_unknown_internal_usage` and enforceable controls (`deadline`, `context_isolation`, `harness_invocations`), never by silently downgrading a strict request; (3) output reported above the requested ceiling fails the step with conservative accounting; (4) native usage is explicit (one observed job, opaque internals, null internal counts, unknown cost).
- **Evidence:** installed 0.163.0: `codex login status` exists (no machine-readable flag) and the binary carries the fixed messages `Logged in using ChatGPT`, `Logged in using an API key - ` and `Not logged in`, among others; `forced_login_method` is in the config schema. The command itself and the key's effect under `exec` were NOT run (they touch the authenticated session), so the gate's stream/format assumptions are fail-closed and unproven: the new control `chatgpt_only_auth_unenforced` keeps the real record unverified.
- **Rejected:** reading or checking any auth file or token ourselves; treating env scrubbing as sufficient; downgrading strict to opaque; unlocking Codex to run a smoke test.
- **Affected:** PR-10, PR-13; src/core/nativeBackends.ts, src/providers/codexCli.ts, src/core/nativeProc.ts, src/core/coordinator.ts; docs/openapi.yaml (see XLOG-017).

## DLOG-020 — Bounded native settlement, per-dispatch abort and honest accounting

- **Date:** 2026-10-22 (follows DLOG-019, unchanged).
- **Decision:** (1) `nativeProc` settles on a bounded grace after `exit` or after a kill request, then force-destroys the owned stdio and reports `streamsForceClosed`/`unreaped`; the adapter turns either into `containment_unverified` (with external work `unknown`) rather than trusting the output or claiming a whole-tree kill. (2) The coordinator creates one abort signal per dispatch, aborts it on hard timeout or run abort, and (native only) waits a bounded 4 s for the adapter before releasing the slot; native external work becomes `unknown` on a launched, unclean job. (3) The Codex adapter fails `model_unconfirmed` unless the transcript reports the pinned model, keys its preflight cache by real path plus file identity and re-checks it right before launch, and spends one shared deadline across probes and job. (4) Live API and native dispatches count one harness invocation per invocation/step and report unknown tokens on failure. (5) `docs/openapi.yaml` carries `x-proofestra-status` per operation, lists only returned fields as required, and documents the emitted `RuntimeEventEnvelope` separately from the design `EventEnvelope`.
- **Rejected:** claiming whole-tree containment (impossible without OS-level isolation); trusting a path-only cache; treating the requested model as the executed one; loosening schemas to make the contract test pass.
- **Unchanged:** both native backends stay `unverified` and refuse real execution; no fallback or weaker admission.

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
[1374641]: https://github.com/jirawatp/proofestra/commit/13746413cbb076c1ec9458090d9c89fdd6178af8
[a96dedf]: https://github.com/jirawatp/proofestra/commit/a96dedf3ae94eb7d07cd971e9cd20886151966ed

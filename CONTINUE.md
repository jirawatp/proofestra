# Continue Proofestra

Checkpoint: **22 October 2026**, after operator verification (latest section below and [release verification](docs/verification/release-verification-2026-10-22.md); the native-backend sections after it and the 21 October coverage sections are preserved history). Start here in a new chat,
coding agent, or checkout. Everything needed for this handoff is in the
repository; chat transcripts, local ZIPs, temporary tabs, generated workspace
paths, and machine-specific tooling are not required, except the OPTIONAL
Poppler/ffprobe system tools described below (PDF text and media metadata are
unavailable without them).

## Release verification checkpoint (2026-10-22, uncommitted on a96dedf; XLOG-020)

> **CI regression (XLOG-021):** after publication on `codex/proofestra-local-v1`
> (commit `e476616`, pull request 1), remote CI failed the same two PDF-metadata tests
> in `tests/integration/content_hardening.test.ts` on Homebrew Poppler 26.09.0
> (1,577 of 1,579 passed). The local checkpoint below used Poppler 26.04.0. The tests
> assumed that older tool's verbatim Title newline; the production parser was not
> defective and is unchanged. The tests now assert the secure outcome for either tool
> behavior, with new deterministic raw-output unit tests. **Fresh CI has not run on the
> correction; no CI pass is claimed.** Next: independent Opus review, then operator CI.
> See [release verification](docs/verification/release-verification-2026-10-22.md).

**Measured (operator, clean isolated locked install, canonical `npm run check`):
PASS**, 1,579 tests in 68 files, 56/56 production TS/TSX files; statements 98.08%
(5,792/5,905), branches 95.17% (4,138/4,348), functions 98.91% (913/923), lines
99.26% (5,111/5,149) against the unchanged **global** 90% floor on each (not
per-file). Lint, three typechecks, build, compiled-JavaScript worker smoke and
parser preflight pass; production dependency audit 0 vulnerabilities; 230 candidate
files hash-unchanged. **Independent Opus 5.5 review closed** (15:04 UTC+7 on the
14:59 fix): the six native-follow-up findings and the clean-checkout 404 are closed,
no code or test blocker; only Low wording/comment/log nits remain. Current-build
HTTP (48 content checks over 40 fixtures, 20 attachment checks with 0 skipped, SSE
tail/replay/resume/security) passed on a disposable dataset served by the same
build; the existing saved data was not mutated (a fixture-mutation attempt against
it was denied before execution and not retried). Native Chrome QA passed picker
upload with full-text preview, a mock Team run (7 steps), the simulated-usage
inspector, reload persistence and the 25 MiB cap. **Still open natively:** clipboard
image paste, mixed multi-selection, throttled progress/retry/cancel and native Thai
input via the driver (HTTP covers related API cases but not native UX). Scope: the
whole v1 application; Apache-2.0 `LICENSE` and `NOTICE` preserved. NOT claimed:
remote CI (at this local checkpoint nothing was published; later publication and CI results belong to the pull-request checks), live-provider behavior, a working Codex or
Antigravity run (both still refuse, fail closed), or re-verification of
documentation edits made after the run. The older "pending/NOT run" wording in the
native sections below describes the earlier checkpoint and is superseded for these
items. Publication remains a human-operator action (DEV-03); no commit, push or PR
was made by an agent.

## Native subscription backends checkpoint (2026-10-22, uncommitted on a96dedf)

Implemented (RLOG-021, DLOG-018, XLOG-016; requirements PR-08..PR-13, DEV-03):
a separate `native_cli` backend kind with reserved IDs `codex-local-cli` and
`antigravity-local-cli`, backend-keyed dispatch, frozen admission policy, sanitized
`native_backends` in `GET /api/v1/providers`, and a supervised bounded Codex
subprocess that relies on the vendor-managed existing ChatGPT login. Files:
`src/core/nativeBackends.ts`, `src/core/nativeProc.ts`, `src/providers/codexCli.ts`,
plus edits to `src/core/{coordinator,adapters,profileConfig}.ts`,
`src/shared/{config,types}.ts`, `src/providers/types.ts`,
`src/server/routes/providers.ts`. Tests: `tests/unit/native_backends.test.ts`,
`tests/unit/native_proc.test.ts`, `tests/adapters/codex_cli.test.ts` (+`_fakeCodex.ts`),
`tests/integration/coordinator_native.test.ts`; real 0.163.0 feature-table captures in
`tests/fixtures/native/`.

**Controls proven for codex-cli 0.163.0** (harmless commands only): invocation flags
exist and are applied (`--ignore-user-config`, `--ignore-rules`, `--ephemeral`,
`--sandbox read-only`, `--json`, `-C`, `-m`, `--disable`, `-c`); 38 features are
disableable and verified off by a pre-launch preflight; env, cwd, stdin, timeout,
process-tree kill, transcript allowlist, exact-model and usage handling are
exercised against fake processes.

**Controls unproven (so Codex is `unverified` / `tool_surface_unproven`, execution
refused with 422 `backend_not_ready`):** the ChatGPT-only authentication control
(`chatgpt_only_auth_unenforced`, DLOG-019); `unified_exec` cannot be disabled;
`apply_patch` and `tool_mode=code_mode_only` are model-catalog properties;
web-search and MCP effects are unobservable without inference; a turn's tool
inventory cannot be listed without inference. Antigravity (`agy` 1.1.5) is
`unverified`: no machine-readable protocol, no tool-deny flags, no auth-status
command, unverified AI-credit overage, unverified officially supported use.

**Corrections of 2026-10-22 (RLOG-022, DLOG-019, XLOG-017), assessed against the
code after two preliminary static reports:** the native per-line byte cap now applies
to every line (it was bypassed by complete newline-terminated lines); each Codex job
first passes the vendor's own `login status` and proceeds only on the exact ChatGPT
message (cached API-key billing can no longer be selected), with
`forced_login_method="chatgpt"` also passed; a Live run with a native agent needs
`bounds_mode=bounded_job` + `allow_unknown_internal_usage=true` and controls within
`deadline`/`context_isolation`/`harness_invocations` (else 422 `unsupported_bounds`),
re-checked at dispatch; output reported above the requested ceiling fails the step
(reservation plus excess charged, totals unknown); native usage is never simulated
or falsely zero at invocation/step/run level; reason code `ready_auth_unchecked`
became `ready_auth_checked_per_job` and `auth_mode_unproven` was added;
`docs/openapi.yaml` now documents `native_backends` and the other implemented
runtime shapes it touches (see XLOG-017 for what is and is not conformant).
Assumptions NOT verified against a real session: that `codex login status` prints as
the installed binary's fixed strings suggest (stream and format) and that
`forced_login_method` is honored under `exec`; both fail closed.

**Opus-review follow-up (RLOG-023, DLOG-020, XLOG-018):** bounded settlement and
`containment_unverified` for a descendant that escaped the process group (the
"whole-tree kill" claim was removed); a per-dispatch abort with a bounded native
settle wait and external work `unknown` for an unclean launched job; a model must be
confirmed by the transcript; the executable is keyed and re-checked by real path plus
file identity; one wall-clock budget covers probes and job; Live API and native
dispatches count one harness invocation per invocation/step and report unknown tokens
on failure; `docs/openapi.yaml` is split into `implemented_v1`/`design_only` with
`tests/integration/openapi_contract.test.ts` validating real responses; permanent
rules no longer embed a one-task publication authorization. Focused checks only
(typecheck of all three tsconfigs, lint, 18 files / 584 tests); the full suite,
coverage gate, build, audit, HTTP and Chrome QA have NOT run on this tree and the
earlier 1537-test baseline is not current proof. A clean-checkout order dependency in the contract test (unknown API
paths returned Fastify's default 404 when no client build existed) is fixed by an
always-installed envelope 404 handler and build-independent tests (XLOG-019). Next:
operator consolidation, then the targeted Opus recheck. Real native execution is still refused.

**State (earlier checkpoint, superseded where it conflicts with the paragraph above):** only focused checks ran (typecheck of all three tsconfigs, lint; after the
corrections 862 tests across 26 integration/adapter/related files pass, plus the
new native proc/backend/adapter/coordinator regressions). NOT run: full `npm run check`,
`npm run test:coverage` (the 1369-test / 98.23-95.36-98.92-99.26 figures below
predate this change and are not current proof), audit, HTTP check, native Chrome QA,
independent Opus review. No server was started or restarted; no model, network or
login was touched; nothing is staged.

**Next:** (1) operator-run consolidated `npm run check` and `npm run test:coverage`
(require >=90 each, all of `src`), then HTTP/native Chrome QA; (2) independent Opus
5.5 review of this change; (3) publication is a human-operator action after final verification (DEV-03);
agents must not stage, commit, push, open a PR, merge or deploy; (4) Codex stays blocked until a CLI version provably
removes the tool surface; then record enforced controls with fresh evidence and run
an operator-approved opt-in test through the signed-in CLI only; (5) Antigravity
needs an officially documented headless protocol, deny controls and overage
state before any code runs it. **Constraints:** no API-key fallback, token bridge,
auth-file read, new login/grant/persistent setting, purchase or session-token
reuse; subscription quota is not API credit and cost is never $0.
**Unresolved choices:** whether to wait for a newer Codex that can drop the tool
surface or accept a weaker, explicitly disclosed posture (not decided; not
authorized by the current rules).

## Latest release gates (2026-10-21, after the coverage implementation pass)

The app is running locally on port 3000 in mock mode. The source remains
uncommitted and unpublished. **The >=90% coverage gate now passes locally**
(numbers below); the independent Opus review is closed with no code/test
blocker, while operator-run native Chrome QA and a current-build HTTP check are
still pending. Always-on project rules are now in AGENTS.md and
`.cursor/rules/proofestra-workflow.mdc`; follow
[development policy](docs/development-policy.md) before new substantive work.

- Final instrumented suite (`npm run test:coverage`, exit 0, run twice with
  identical results): **1369 passed / 63 files**. Statements **98.23%**
  (5191/5284), branches **95.36%** (3742/3924), functions **98.92%** (826/835),
  lines **99.26%** (4586/4620), all 53 production TS/TSX files measured, no
  exclusions, no ignore directives, thresholds still 90 each (a 99.5% statements
  probe correctly exits 1). Not a live-provider or native-browser result: web
  tests are jsdom with a mocked API module; parser tests include direct
  instrumented calls that are NOT child-worker coverage (real Worker tests and
  the fixed-env parser assertion are unchanged; `autoAttachSubprocess` is off).
  The requirement is a global 90% per metric (no per-file floor); four files are
  individually below 90 on one or two metrics: `Markdown.tsx` statements 86.66 and
  lines 85.71 (unreachable `never` guards), `App.tsx` branches 88.45,
  `composerOrder.ts` branches 88.23 and `boundedProc.ts` branches 88.88 (see
  XLOG-015, which corrects XLOG-014's wording). Reports are under ignored coverage/.
- Defects fixed with regression tests this pass (DLOG-017, RLOG-020): XLSX
  shared-string cap now reads Partial; malformed %-encoded session cookie fails
  closed (401 / fresh session); fractional port rejected; invalid cursor 400;
  limit-above-ceiling 422; non-multipart upload 415; root error envelope; SSE
  headers flushed; empty provider answer is a failed step; deferred send /
  cancel / delete after a chat switch no longer touch the other chat; upload
  cancel during session bootstrap settles at once.
- Current lint, server/web/test typecheck, parser preflight, dependency audit
  (0 vulnerabilities), source whitespace and script syntax checks pass. The
  final app build and built-worker smoke also pass after the policy/config step;
  the coverage pass then changed runtime source only for the defects above;
  lint, typecheck, build, built-worker smoke and audit pass again. CI is
  configured but has not run remotely; no push or workflow dispatch occurred.
- *(Historical, pre-coverage; NOT current-build verification.)* Final compiled production server: 48/48 actual content HTTP checks passed,
  including 40 real synthetic fixtures, metadata reload, safe media previews,
  Team mock freeze/export, observed DELETE204/upload409/next201 cancellation,
  and cleanup of only owned conversations/blobs. A separate general attachment
  suite passed 20 checks with 1 explicit skip (global disk snapshot on the shared
  production data directory); owned-blob cleanup was verified in the 48-check
  suite. Actual SSE live tail, ordered terminal, replay/resume, caught-up204,
  future400 and synthetic cleanup passed. All runs were mock-only.
- *(Historical, pre-coverage.)* Independent source-parser/wire suite: 44/44 passed, including exact Gemini
  media bytes/MIME in 12 injected draft/review/synthesis requests. Fake keys and
  injected fetch do not establish live-provider behavior. Real external parser
  checks do not count toward V8 coverage percentages unless instrumented.
- *(Historical, pre-coverage; see the newer read-only diagnostics below.)* Production migrations 1-5 are applied; existing counts remained 15
  conversations / 31 messages before and after final synthetic HTTP checks.
  No active run remained. Existing media without metadata stays download-only
  until re-uploaded. This host reports Poppler and ffprobe available.
- Coordinated native Cursor UI check: Claude Fable 5.1 High, Claude Opus 5.5
  (Medium locally / 1M Max Fast in Agents window), Claude Sonnet 5.5 High.
  User spelling **Sonet 5.5** is preserved; UI label is **Sonnet 5.5 High**.
  Earlier Fable planning returned **Model Blocked** and did not execute. The
  user has now replaced Fable with **GPT Sol** for planner/designer; Opus and
  Sonnet remain. Do not retry Fable. The coordinated native check verified
  **GPT-5.6 Sol Medium / gpt-5.6-sol** and successful planning reads in another
  project. Model-pinned planner/worker/reviewer files are installed in
  .cursor/agents/. Roles executed for this pass (operator-observed in the native
  Cursor UI, no silent fallback shown): GPT-5.6 Sol Medium (`gpt-5.6-sol`)
  planned; Claude Sonnet 5.5 High (`claude-sonnet-5-5`) implemented with two
  pinned `proofestra-worker` delegates; Claude Opus 5.5 1M Max Fast
  (`claude-opus-5-5`) reviewed independently with no delegation. **Independent
  review is closed**: one MEDIUM test gap (fake XHR) was corrected, A/B-proven
  and re-reviewed; no code/test blocker remains. This is model-run evidence, not
  live-provider proof. See development-policy.md and
  RLOG-020/DLOG-017/XLOG-014/XLOG-015.
- Native Cursor control is restored (it was unavailable earlier on 2026-10-21;
  that outage is historical). The operator inspected the earlier uncertain Cursor
  run: completed, no duplicate. **Pending, not run: final visible-Chrome QA
  (clipboard/picker/drop/reload/retry, chat switch during send/stop) and a
  current-build HTTP check.** No browser scripts were used. The long-running
  `:3000` process is a MIXED build: old server modules in memory, but the rebuilt
  static UI and workers loaded from disk. Restarting it needs explicit operator
  approval, which has been requested and is pending; do not stop, restart or
  replace it, and never kill by port. Read-only operator diagnostics of the
  existing data (not a QA pass): 15 conversations, 31 messages, 17 runs, 16
  attachments, 0 active runs, 0 uploading, 0 orphan blobs, 0 missing ready/bound
  blobs, migrations 1-5; no user content was read. The separate audit-plan
  chat/history was not identified here; do not invent its title.
- Live mode remains disabled, catalog built-in, no profile file configured.
  No provider semantic/media-analysis call, new key/grant, spending, deployment,
  commit, push, merge or license change occurred. Live validation requires an
  existing authorized provider setup and explicit approval for any paid calls;
  keep it separate from mock readiness and from Cursor model permissions.

Run from this existing checkout: `npm ci`, `npm run build`, `npm start`;
open the local app on port 3000. Quality gate: `npm run check:parsers`,
`npm run check` (passes locally, including the coverage gate). All paths and
commands are repo-relative so this handoff remains portable after publication.

The dated [verification report](docs/verification/content-analysis-2026-10-21.md)
records current checks and release blockers. The isolated QA server was stopped;
only the app on port 3000 remains running.

## Get this checkpoint

Repository: [jirawatp/proofestra](https://github.com/jirawatp/proofestra).
Branch: `codex/project-traceability` (local, uncommitted v1 implementation on
top of
[`a96dedf`](https://github.com/jirawatp/proofestra/commit/a96dedf3ae94eb7d07cd971e9cd20886151966ed)).
This branch carries project history, continuation instructions, and the
implementation that satisfies the local v1 acceptance; it does not merge itself
into `main`, publish any artifact, or make any paid provider call.

> ⚠️ **The v1 implementation is uncommitted and unpublished at this
> checkpoint.** A fresh `git clone` of the public remote (shown below for
> record) will NOT include the implementation — the remote currently only
> carries the pre-implementation design snapshot at
> [`a96dedf`](https://github.com/jirawatp/proofestra/commit/a96dedf3ae94eb7d07cd971e9cd20886151966ed).
> The clone commands below are documented for the future state after
> someone commits and pushes `codex/project-traceability`. Until that
> happens, work from the existing local checkout where this file lives —
> that checkout is the only place the v1 source currently exists. All
> commands in the rest of this file use repo-relative paths and are
> expected to run from the repository root.

For a new machine (future, after the branch is pushed):

```sh
git clone --branch codex/project-traceability https://github.com/jirawatp/proofestra.git
cd proofestra
git status
nvm use    # Node 22.19.0 per .nvmrc
npm ci
npx vitest run
npm run build
npm start
```

### Optional system tools (PDF text and media metadata)

PDF text extraction needs Poppler (`pdfinfo` and `pdftotext`; verified with
26.04.0) and media metadata needs FFmpeg's `ffprobe` (verified with 7.1.1).
The server looks only at the fixed paths `/opt/homebrew/bin`, `/usr/local/bin`
and `/usr/bin` (never `$PATH`), once at server start, so restart the server
after installing. Examples: `brew install poppler ffmpeg` (macOS);
`apt-get install poppler-utils ffmpeg` (Debian/Ubuntu, installs to `/usr/bin`).
`GET /api/v1/providers` reports availability as the booleans
`capabilities.pdf_text_extraction` and `capabilities.media_metadata_probe`.
Without the tools PDFs and media read "Unsupported", and the real-tool tests
skip visibly (the test count is lower than the 1369 in the latest gate above).

For an existing checkout, preserve local changes first. Fetch the branch, switch
to it, and fast-forward where appropriate; never reset unrelated work to recover
this checkpoint. Repository access is enough to read, build, and run the mock
default. Live mode is opt-in and requires separately supplied credentials.

## Current state (implemented)

- **Server + storage:** Fastify 5.12 app factory (`src/server/app.ts`),
  SQLite via `node:sqlite` with migrations, repositories, SSE writer with
  monotonic Last-Event-ID guards. Loopback-only Host allowlist, CSRF for
  mutating requests, strict CSP, no-store caching.
- **Run coordinator:** `src/core/coordinator.ts` implements the executable
  acceptance for CT-01 through CT-08:
  - Idempotency replay resolved BEFORE catalog / live / policy admission.
  - Infeasible plans rejected at admission
    (`base_planned_calls × max_output_tokens_per_call ≤ total_output_tokens`).
  - Per-provider + global concurrency via counting semaphores.
  - Each `adapter.generate()` wrapped in `Promise.race` with a hard per-call
    timeout; the whole run wrapped in an overall-deadline guard that releases
    the serialized `globalActive` even when an adapter ignores `AbortSignal`.
  - Terminal state immutable; late adapter callbacks are discarded; outstanding
    reservations drain into the conservative numeric ledger at terminal.
  - `events.append` + `runs.updateSnapshot` run in a single SQLite
    transaction; the bus event is emitted only after the commit returns.
    Terminal commit atomically writes the terminal event, snapshot, and final
    assistant message.
  - Token accounting keeps provider-reported `input_tokens`/`output_tokens` as
    `number | null` with sticky-unknown semantics (CT-06) alongside a separate
    conservative numeric `consumed_output_tokens` ledger that charges the full
    reserve for missing/ambiguous outcomes.
- **Profile catalog:** `src/core/profileConfig.ts` validates built-in seeds and
  optional `PROOFESTRA_PROFILES_FILE` through the same Zod schema. Provider /
  api_shape binding enforced; Live providers require non-null `model_id`.
  `src/core/registry.ts :: catalogVersion()` hashes resolved profiles into
  `catalog-v2-local-20261021-<12hex>` so a `model_id` swap under the same
  `profile_id` rotates the version.
- **Live adapters:** `src/providers/openai.ts`, `anthropic.ts`, `gemini.ts`
  carry fixed, upstream-text-free failure messages via
  `src/providers/_sanitize.ts`. Only allowlisted stop/finish/block enums
  reach any emitted message; vendor body text and caught `Error.message` are
  always discarded. Gemini drops `thought: true` parts and `thoughtSignature`.
- **Mock adapter:** deterministic, configurable via `PROOFESTRA_MOCK_LATENCY_MS`
  env + per-profile fixtures. Supports `fail` / `timeout` / `safety_block` /
  `empty` / `unknown_usage` / `late_success` / `never_settle` scenarios so
  tests exercise cancellation, partial failure, sticky-unknown usage, hang,
  and late-success CAS without network. Draft/review/synthesis output is
  concise and deterministic — it never echoes the full reference material
  (the coordinator's complete peer drafts and reviews remain inspectable
  per-step in the UI). The `mock-fail-review` fixture profile's label and
  code paths are consistent: drafts and synthesis succeed, only the review
  stage fails, so Team runs exercise coordinator partial-handling.
- **Web client:** `src/web/App.tsx` implements the single-run inspector:
  defaulted tool-off / helpers-off submits with expected catalog + runtime
  policy pins, Quick exactly-one-root UX, expandable per-step
  agent/model/profile/backend/findings/failure, Live cross-provider
  disclosure, export with privacy notice, EventSource reconnect + snapshot
  fallback with monotonic sequence guards, bounded session bootstrap retry,
  stable idempotency key preserved across network retry, guarded
  per-conversation async, active-run recovery on reload. The selected
  conversation id is persisted to `localStorage` under
  `proofestra:selected-conversation-id:v1`; missing/unknown/deleted ids clear
  themselves on next boot and fall through to the empty state.
- **Context admission:** `src/core/context.ts` uses a documented conservative
  upper bound `max(ceil(utf8_bytes/2), ceil(chars/4))` plus per-message
  framing (`TOKENS_PER_MESSAGE_FRAMING = 8`) and reply framing
  (`TOKENS_FOR_REPLY_FRAMING = 8`), with the derivation written at the top of
  the file. `worstCaseReferenceTokens` returns a token count; the coordinator
  passes it into `evaluateCapacity` via `referenceMaterialTokens` so the
  admission check never double-charges by reifying a synthetic string.
- **Dev plumbing:** Vite 7 dev proxy on 5173 → 3000 with `changeOrigin: true`
  and `Origin` rewrite; security hooks register at app root scope so static
  assets also enforce Host/CSP/no-store. `PROOFESTRA_EXTRA_ORIGINS` accepts
  loopback-only additions.
- **Dependencies:** `npm audit --include=dev` reports **0 vulnerabilities** on
  the full dev tree. Pinned stack: fastify 5.12.7, vite 7.3.7, vitest 5.0.5,
  @vitejs/plugin-react 5.2.0, @typescript-eslint/* 8.72.0, eslint 9.39.5,
  undici 8.12.3, @fastify/static 10.1.6, @fastify/multipart 10.1.4,
  typescript 5.9.3. `@fastify/multipart` is exact-pinned to 10.1.4 to carry
  the upstream fix for
  [fastify-multipart#594](https://github.com/fastify/fastify-multipart/issues/594)
  ([PR #595](https://github.com/fastify/fastify-multipart/pull/595), released
  in v9.3.0 / v9.4.0 and continued in
  [v10.1.4](https://github.com/fastify/fastify-multipart/releases/tag/v10.1.4)).
- **File attachments:** The composer accepts files via native picker, paste,
  and drag-drop; each file is streamed to a signed-conversation blob store
  behind a store-wide upload gate (concurrency 1, 120 s deadline, bounded
  queue), MIME-sniffed, bounded by per-upload / per-store / per-count limits,
  and routed to a provider's native modality or bounded extracted text —
  depending on per-profile capability. The attachment row flips to `ready`
  only after multipart EOF; a trailing invalid part can no longer unlink
  bytes already bound to a sibling tab's user message. Known parser errors
  surface as 4xx (`FST_FILES_LIMIT → 400`, `FST_REQ_FILE_TOO_LARGE → 413`,
  `ERR_STREAM_PREMATURE_CLOSE / FST_PARTS_LIMIT / FST_FIELDS_LIMIT /
  FST_PROTO_VIOLATION → 400 multipart_malformed`), never 500.
- **Typed content parts.** `AdapterRequest.user_messages` carries
  `NormalizedMessage[]` with optional typed `parts: MessageContentPart[]`
  (`text`, `attachment_native`, `attachment_extracted_text`, `attachment_only`).
  OpenAI ChatCompletions receives `image_url` / `file` parts, Anthropic
  Messages receives `image` / `document` blocks with `source.base64`,
  Gemini v1beta `generateContent` receives `inlineData` for image / PDF /
  audio / video. The adapter is the only place that materializes raw bytes;
  nothing is written to run JSON, SSE events, snapshots, or exports.
  Historical user messages are projected through the SAME frozen coverage
  as the current turn's refs: every historical ref is routed via
  `attachment_native`, `attachment_extracted_text`, or `attachment_only`
  by the same per-agent routing decision, so follow-up draft / review /
  synthesis stages can inspect the bytes / extracted text of the file
  the model already saw (not a placeholder). The native byte-budget is
  checked across the full union at admission. The Mock adapter stays
  honest and records `attachment_only` even for OpenAI-profile agents
  because `executionMode === "mock"` routes through
  `effectiveCapabilitiesFor(profile, "mock")`.
- **Preview surface:** `/preview` returns `422 preview_unavailable` with
  no raster bytes when a raster image's persisted sniffed dimensions
  are unknown (JPEG — our head sniff never reaches the SOF marker),
  invalid, or exceed the preview-safety caps (same per-side 4096 /
  pixel-area 16 Mpx caps as native eligibility). `/download` continues
  to serve the same bytes with `Content-Disposition: attachment`.
  The UI's `ComposerAttachmentPreview` mirrors the predicate so the
  `<img>` tag is skipped for unsafe rows and an explicit download-only
  fallback card appears instead.
- **Composer rehydration + settlement:** chat switch merges the server's
  authoritative draft list with the composer's in-memory rows by stable
  `serverId`, preserving `localId` / `fileHandle` / `controller` /
  `progress`. A bounded exponential refetch (1 s / 2 s / 4 s / 8 s /
  15 s) resolves rows the server still shows as `uploading`. Send
  settlement is scoped to the origin conversation + exact submitted
  refs: `activeRun` / prompt clear / composer clear only fire when the
  user is still viewing the chat they submitted from, and the clear
  drops only the rows that were actually submitted. The pending-submit
  digest includes agent display `name`. XHR 401 invalidates the cached
  CSRF token + boot promise (no auto-resubmit).
- **LocalStorage ordering:** `proofestra:composer-order:v1` persists at
  most 16 UUID-shaped ids per conversation. On reload the server list
  wins for identity; the local order wins for arrangement. No bytes,
  display names, MIME types, extracted text, or secrets.

- **Bounded content analysis (2026-10-21, RLOG-017 / DLOG-014 / XLOG-011):**
  - Extractors: PDF text via fixed-path Poppler (`pdfinfo`/`pdftotext`, 20 pages,
    5 s, bounded output); DOCX/XLSX (stored values)/PPTX/ODF text and ZIP inventory + supported
    text entries in a resource-limited, terminable `worker_threads` worker
    (`src/core/{attachmentWorker,workerExtraction}.ts`, hardened
    `src/core/parsers/zipCore.ts`, no `fflate`); media metadata via `ffprobe`
    over the read-only blob descriptor only. No transcription, no new model or
    service.
  - Persisted validated metadata (migrations 4 and 5): pages, duration, streams,
    container format, wire-normalized MIME, re-validated through
    `src/shared/attachmentMetadata.ts` everywhere it is read.
  - Routing/admission: `planAttachmentRoutes` (history first), one shared
    `nativeAttachmentTokenReserve` for admission and dispatch, native PDF at most
    20 pages, Gemini-only native audio/video (120 s, 120 s + 12 MiB per call,
    codec whitelist), 50% native-token profile budget. The caps are proposed
    defaults, not vendor limits.
  - All four adapters frame file content as untrusted data and send
    `wire_mime`; `GET /api/v1/providers` adds two parser booleans.
  - A disconnect during parsing aborts and awaits the child/worker before the
    upload gate is released; `markReady` is never reached. Media `/preview`
    returns JSON `422 preview_unavailable` unless validated (legacy rows are
    download-only until re-uploaded). DELETE of a still-processing row aborts
    its parse and the original request ends 409 `attachment_removed`; a queued
    upload whose client left never holds the gate. The UI shows
    `Processing on server…` (queued or analyzing), semantic coverage labels,
    validated-only media preview, hides cancelled rows, and lists per-agent
    route reasons.
  - Review corrections (2026-10-21): fail-closed PDF metadata and media
    streams, linear Office tokenizer with depth/tag limits, strict UTF-8,
    XLSX stored cell values (cached values; formulas never evaluated), one
    shared preview rule, framed-string token reserves, `/providers`
    `catalog_source.file_configured` (no path).
  - Synthetic fixtures: `tests/fixtures/content/` (README, relative manifests;
    `huge-dimensions-header-only.mp4` is probe-only, never decode/render it).

## Not implemented in this v1

- Subagent **delegation** (`delegation.enabled=true`) is rejected at admission
  with `helpers_not_supported`.
- **Tool execution** (`tool_policy.mode="auto"`) is rejected at admission with
  `tools_not_supported`.
- Native SDK / CLI / desktop-app provider surfaces.
- Native execution tracing (`internal_usage_visibility` remains `complete` for
  mocks and `unknown` for real providers by design).
- Browser-level end-to-end automation. Integration tests use
  `fastify.inject(...)`; a visible-browser pass has not been scripted in this
  checkpoint.

## Validation evidence (content-analysis build, 2026-10-21)

Reproduce from the repo root (needs Node 22.19 and, for the real-tool tests,
the optional system tools listed under "Optional system tools" above):

```sh
npm ci
npm audit --include=dev          # expected: found 0 vulnerabilities
npm run lint
npm run typecheck                # server + web + tests (tsc -p tsconfig.json)
npm test                         # expected: 1369 passed (63 files) with Poppler and ffprobe installed
npm run build                    # emits dist/public + dist/server
node tests/smoke/worker-dist.mjs # built .js worker runs without tsx
PROOFESTRA_PORT=3101 PROOFESTRA_ORIGIN=http://127.0.0.1:3101 \
  PROOFESTRA_DATA_DIR=./data-prod npm start
```

Earlier aggregate (398 tests / 23 files, superseded by the 1369-test gate in "Latest release gates"), agent-run on 2026-10-21 in this checkout (`PROOFESTRA_LIVE_ENABLED=0`,
no credential read, no provider call), against baseline `a96dedf` plus the
uncommitted v1 tree, after all Opus review corrections (see the "Review
corrections" notes in RLOG-017 / DLOG-014 / XLOG-011). Only evidence produced in
this run is listed:

- `npm run lint`: clean. `npm run typecheck` (server, web, tests): clean.
- `npm test`: **398 passed in 23 files, 0 skipped** (Poppler 26.04.0 and
  ffprobe 7.1.1 present, so every real-tool case ran). The prior checkpoint had
  183 tests in 12 files.
- `npm audit --include=dev`: 0 vulnerabilities.
- `npm run build`: ok, about 2.2 s wall time (once, as the last code step).
  `node tests/smoke/worker-dist.mjs`: ok on the real `dist/` (built `.js`
  worker, no tsx).
- `git diff --check` clean; trailing-whitespace `rg` over untracked `src`,
  `tests` and docs clean.
- **Production restart (agent-run):** the owned `npm start` server on
  `127.0.0.1:3000` (default `./data`, live disabled) was identified by command
  line, listening socket and working directory (this repo root), stopped with
  SIGTERM, confirmed exited and the port free, and restarted from the repo root
  with `npm start`. Read-only HTTP checks with correct Host/Origin headers:
  `GET /api/v1/session` 200; `GET /api/v1/providers` -> `live_enabled:false`,
  `capabilities` = `{pdf_text_extraction:true, media_metadata_probe:true}`,
  `catalog_source` = `{source:"built_in", file_configured:false}` (no path);
  `GET /api/v1/attachments/policy` returns the new caps. `sqlite3 -readonly` shows
  migrations 1-5 applied in `./data/proofestra.sqlite`. No conversation, upload or
  other data was created.
- **At the Cursor-only handoff, no HTTP upload QA or browser QA had run** (superseded for HTTP by the latest release-gates evidence above), and
  **no live provider has been called** (payload tests intercept the request with
  an injected transport and fake keys). Not exercised then: any browser or DOM
  (at that checkpoint composer wiring had only typecheck and pure-helper tests;
  jsdom component tests were added later, see the latest release gates), OCR or
  transcription (neither exists), Poppler/ffprobe versions other than the
  development host's. Older media rows have no validated metadata and are
  download-only until re-uploaded, so QA on `:3000` needs freshly uploaded files.

### Earlier checkpoint evidence (183-test build, not re-run)

Agent-run Fastify-inject + localhost-socket QA at the previous checkpoint (183 automated
tests pass across 12 test files; lint, both TypeScript projects, `npm audit
--include=dev`, `npm run build`, and `git diff --check` all clean — all
observations below were executed by the controlling Codex agent in this
checkout, not by a human user). The 183 total adds 45 regressions on top of
the DLOG-012 138 baseline, covering: history-complete typed projection,
normalized-projection capacity math at admission AND dispatch, persisted
sniffed image dimensions, raster preview-dimension refusal (`/preview`
returns `422 preview_unavailable` on unknown / excessive dimensions while
`/download` still serves authenticated bytes), per-profile capability caps
with mock-effective routing + catalog digest, sanitized attachment-read
errors across all three live adapters, composer rehydration that preserves
in-flight tracking, scoped send settlement, XHR 401 cache invalidation,
and opaque ordered-ready-id persistence in localStorage. The latest batch
adds **nine composer-order regressions** in
`tests/unit/composer_order.test.ts` that drive the exact mixed-8
reload sequence: four `shouldPersistComposerOrder` hydration-gate cases;
a positive mixed-8 reload test proving the saved
`unknown.bin, docx, pdf, mp4, wav, zip, txt, png` order survives when
the write effect is gated; an explicit pre-fix doc test reproducing the
scrambled server-default `pdf, mp4, zip, wav, txt, png, unknown.bin, docx`
order when the gate is absent; a chat-switch cross-chat separation case;
the 16-id storage cap + malformed-entry stripping; and a reader-shape
filter case covering path separators, HTML metacharacters, control bytes,
and length outliers.

Independent full-HTTP agent-run harness: **20/20 passed** on the earlier 183-test build
(final attachment-flow guard including the preview-dimension refusal
and the download-attachment fallback), and the production UI session on
`:3000` recorded the following at that earlier checkpoint:

- Mixed-8 picker arrangement
  `unknown.bin, docx, pdf, mp4, wav, zip, txt, png` persists across a
  hard reload (the composer rehydrates in that exact order; the
  server's `ORDER BY created_at` is no longer visible to the user).
- Chat-switch cross-chat separation: switching from conversation A to
  conversation B and back does not leak A's composer rows into B's
  localStorage order slot.
- Remove persistence: removing a composer row before Send drops it
  from both the live view and the saved order; a reload confirms the
  shortened arrangement.
- Native-Chrome clipboard image paste (Cmd+V on a copied PNG) followed
  by reload keeps the pasted row at the position where it was dropped
  into the composer.

SSE replay (monotonic Last-Event-ID, 204 on terminal + caught up,
400 on a future id), the loopback-only Host / Origin / CSRF triad,
no-store caching, and the strict preview CSP all passed on the live
`:3000` surface during that earlier verification.

- Infeasible-plan admission rejects Team-3 when
  `base_planned_calls × max_output_tokens_per_call > total_output_tokens`.
- Team-3 completes in 7 calls (3 drafts + 3 reviews + 1 synthesis) with the
  user-selected second-root profile as synthesizer; the final answer is one
  assistant message per run (no duplicate assistant + RunView bubble);
  frozen history reference matches the user message, every peer-review
  step completes.
- Idempotency replay returns the prior snapshot and only one assistant
  message exists in the conversation.
- Abort-ignoring adapter: `late_success` and `never_settle` both finish via
  the per-call 5s hard timeout + overall-deadline guard; reported Usage
  stays `null` (sticky-unknown) and `consumed_output_tokens` charges the
  full reservation; the next Mock run then succeeds (no stranded
  `globalActive`).
- Terminal accounting is drained ONCE at `finalize()`: the late-success and
  late-failure branches in `runSingleStep` return without mutating usage,
  so cancel → late callback → repeat cancel yields identical, non-negative
  usage and `consumed_output_tokens` is never double-charged.
- Overall-deadline fallback preserves useful work: when the deadline fires
  with ≥1 completed drafts, status is `partial` with a `draft_fallback`
  presentation (not `failed`).
- Same-provider concurrency cap honors `per_provider_concurrency`
  across parallel calls that share a provider.
- Mixed known/unknown Team usage: any contributing unknown invocation
  collapses reported totals to `null` but `consumed_output_tokens` stays
  strictly positive.
- Partial draft / review / synthesis failures leave inspectable artifacts
  and a documented limitation; synthesis-failure falls back to the first
  successful draft.
- Truncated provider output never implies full completion: step findings
  include the truncation note, the final answer carries the truncation
  marker, and run status is `partial`.
- Host / Origin / CSRF mismatches each return 403.
- SSE replay serves monotonically-increasing event ids, returns 204 when
  terminal + caught up, and 400 for a future Last-Event-ID.
- Exactly one assistant message is persisted per terminal run.
- Restart interruption marks running runs `interrupted` with a dated
  `run.terminal` event and `external_work_status = "unknown"`.
- Active-run DELETE and export both return 409; after terminal both
  succeed. The export payload never contains API keys or server secrets
  (scanned for `sk-`, `AIza`, and injected marker strings).
- All fixtures are deterministic mock transports; no network call.

In the actual Chrome dev app (earlier build), Team-3 and follow-up messages work and the
expandable history/inspector shows per-step output, findings and failure.
The Vite dev proxy pattern is `"^/api/"` (not `"/api"`); the old prefix
intercepted `/api.ts` and blanked the page. Keep the regex-anchored form.

The last pass of `npm start` on the earlier build served a complete Quick mock run with
`status=completed`, `input_tokens=115`, `output_tokens=120`,
`consumed_output_tokens=120`, `reserved_output_tokens=0`, and
`catalog_version=catalog-v2-local-20261021-<12hex>` (hex rotates when the
built-in or env-seeded profiles change). No credential or upstream body
text was observed in any logged payload, snapshot, event, or export.

## Decisions to preserve

- Apache 2.0 core; no license change.
- Personal self-hosted, mock-default, Live opt-in via both
  `PROOFESTRA_LIVE_ENABLED=1` AND `execution_mode: "live"` per run.
- Distinct agent identities (same provider allowed), scoped delegation,
  compatible tool routing, permission boundaries, honest native usage, and
  preserved uncertainty.
- Credentials stay server-only; never surfaced in UI, logs, snapshots,
  events, or export.
- Terminal CAS, atomic terminal commit, same-provider concurrency slots,
  explicit tool / delegation policies, sticky-unknown usage (CT-06), and
  content-addressed catalog version remain the acceptance bar.

## Next actionable work (in priority order)

0. **Finish the four remaining native UX gaps** (operator-run, visible Chrome with
   native mouse/keyboard, not agent-driven browser scripts): clipboard image paste,
   mixed multi-selection through the native picker, throttled progress/retry/cancel,
   and native Thai input through the input driver. Everything else from the earlier
   2026-10-21 list was checked at the 2026-10-22 verification checkpoint: the mock
   server was restarted under guard on the current build with the saved data's
   aggregate counts (and session counts) identical before and after; the existing
   data was only read, never mutated; and the HTTP content checks (40 fixtures, 48
   checks), the attachment checks (20, none skipped, with on-disk checks) and the
   SSE tail/replay/resume/security checks passed on a disposable loopback dataset
   served by the same build. The older HTTP upload QA noted in the 2026-10-21
   sections is historical and is superseded by that run. See
   [release verification](docs/verification/release-verification-2026-10-22.md).

1. **Live-mode browser verification (future, separately authorized operator
   work).** Only if the operator separately authorizes it and supplies provider
   credentials out of band, enable `PROOFESTRA_LIVE_ENABLED=1` and exercise a Team-3
   run in a visible Chrome; capture the final answer, Live disclosure, and export
   in a dated log entry under `docs/logs/`. This is never an automatic step: no
   agent creates credentials or grants, enables live mode, substitutes a paid API
   for the subscription-backed native backends, or falls back to an API on its own.
   Do not commit credentials.
2. **Browser-level checks stay visible and native.** Meaningful jsdom component
   tests now exist (`tests/web/*`: send/cancel/chat-switch races, SSE reconnect
   and fallback, composer picker/paste/drop/remove/retry/rehydration, previews,
   export), but jsdom is not a real browser. The remaining checks (default send
   succeeds with no 422; cancel mid-run; stop-on-reload recovery; EventSource
   reconnect in a real browser; expandable step details; export privacy notice)
   are operator-run in visible Chrome with mouse/native UI, not agent-driven
   browser scripts, DOM automation or Playwright. Adding an automated
   browser-E2E suite would be a separate product decision for the user.
3. **Streaming adapter contract.** Current adapters return a single buffered
   result. If streaming is added, extend `_sanitize.ts` and
   `tests/adapters/sanitize.test.ts` to assert partial chunks also carry no
   upstream body text and that aborted streams release reservations
   correctly.
4. **Delegation + tool execution.** Both are rejected at admission in v1.
   When implemented, add admission-time per-depth budgets, scoped grants, and
   extend CT-06 to subagent usage so sticky-unknown continues to behave.
5. **Credentials UX.** The server reads `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
   `GOOGLE_API_KEY` from env today. A keychain or protected-file store is a
   future design decision (append DLOG entry).

## Open choices

- Whether to keep the proposed content-analysis defaults (20 native PDF pages x
  3,000 tokens/page; 120 s per media file and per call; 12 MiB media per call;
  50% native-token profile budget) or retune them after measured live-provider
  testing, and whether a timed-out `pdftotext` prefix should stay `Partial
  (truncated)` or count as a failure (DLOG-014).
- Whether to add a native-browser E2E suite beyond the jsdom component tests that
  now cover the composer states (`tests/web/*`; jsdom is not a real browser, and
  Chrome QA remains operator-run). State names covered:
  `Uploading… N%`, `Processing on server…`, `Metadata only — no transcription`,
  `No text layer (scanned)`, and the per-agent "Attachments by agent" list.
- **Audio with embedded cover art** (for example MP3/FLAC with artwork) is
  refused for native audio, because ffprobe reports the artwork as a video
  stream and a distinguishing `disposition` field would change the ffprobe argv
  the user verified. Conservative default pending the user's choice.
- **XLSX dates** appear as their stored serial numbers (no number-format
  interpretation); cached formula values are read, formulas are never evaluated.
- **Reloading the page while a file is still processing cancels that upload**
  (the browser aborts the request); the server keeps a `failed`
  `client_closed_request` row that the composer hides and deletes best-effort.
- The proposed default caps are admission defaults, not vendor limits, and no
  provider has been shown to understand any native part.
- **Pre-existing, for the user to decide:** an older log entry (RLOG-014 in
  `docs/logs/requirements.md`) contains a local username in an example path.
  It predates this change and was left untouched; redact it or keep it as
  history.

- Final value of `RUNTIME_POLICY_VERSION` and `CATALOG_VERSION_PREFIX` once a
  real external release is cut.
- Whether to persist per-conversation `expected_catalog_version` pins across
  reloads or always refresh them from `/providers`.
- Default fixture latency for test runs vs. local dev (`PROOFESTRA_MOCK_LATENCY_MS`
  is 20ms under `vitest.config.ts` and 50ms otherwise; the unrun CI workflow uses the same config).

## Project history

See [docs/logs/README.md](docs/logs/README.md). The newest entries are
RLOG-020 (coverage gate achieved; XLSX shared-string partiality), DLOG-017
(fail-closed and race fixes) and XLOG-014 / XLOG-015 (coverage evidence, then the
closed independent review and wording corrections), all dated 2026-10-21/22; read
XLOG-015 as the correction layer over XLOG-014. Before them, RLOG-019 / DLOG-016 /
XLOG-013 record the GPT Sol planner replacement. The prior content-analysis entries are
RLOG-017, DLOG-014 and XLOG-011 (bounded real content analysis: Poppler, Office/ZIP
worker, ffprobe metadata, validated native routing, untrusted-content framing),
built on RLOG-016 and DLOG-013, all dated 2026-10-21, which record the
history-complete typed projection, normalized-projection capacity math,
persisted sniffed image dimensions, raster preview-dimension refusal,
per-profile capability caps with mock-effective routing, sanitized
adapter read errors, safe composer previews, merge-based rehydration,
scoped send settlement, XHR 401 handling, and opaque ordered-ready-id
persistence — all on top of the attachments baseline recorded by
RLOG-015 / DLOG-012 / XLOG-010.

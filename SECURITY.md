# Security policy

## Current status

A local-only, mock-first v1 implementation now exists in this working tree on
branch `codex/project-traceability` and is **uncommitted and unpublished**:
until this work is committed and pushed, a fresh `git clone` of the public
remote does not include the implementation source. The implementation source
lives in-tree under `src/`, `tests/`, `docs/`, and the top-level
configuration files; the `data/` directory is a `.gitignore`-excluded
generated local-state folder that the server creates at startup for its
SQLite database (schema in `src/storage/migrations.ts`) and is not the
implementation itself. There is still no hosted service, no supported
release, and no third-party security audit; architecture documents describe
intended controls, not guarantees of audit.

### What the current v1 enforces today

- **Loopback-only HTTP surface:** Fastify rejects requests whose `Host` header
  is not an allowlisted loopback entry (403), whose `Origin` is cross-origin
  (403), whose session cookie is missing (401), or whose `X-CSRF-Token` does
  not match the server-issued token on this session (403). Covered by
  `tests/integration/acceptance.test.ts` and reproduced over a real
  localhost socket in an agent-run 2026-10-21 QA session executed by the
  controlling Codex agent in this checkout. That socket session ran on the
  EARLIER 183-test build and was NOT re-run on the content-analysis build.
- **Server-only credentials:** Provider API keys are read from `OPENAI_API_KEY`
  / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` (via `.env.example`), never shipped
  to the browser bundle, never written to SSE events, never persisted in
  `runs.snapshot_json`, and never included in `/api/v1/conversations/:id/export`.
  Export privacy is covered by a regression that injects an `sk-`-shaped marker
  into every live key and asserts it does not appear in the export payload.
- **Mock-first dispatch:** Live mode is double-gated — both
  `PROOFESTRA_LIVE_ENABLED=1` AND the per-run `execution_mode: "live"` are
  required before any live-provider HTTP call can occur. The default
  development configuration keeps live off. No automated live-provider
  end-to-end test has been run in this working tree.
- **No tool/delegation execution:** `tool_policy.mode = "off"` and
  `delegation.enabled = false` are enforced at admission; a run that attempts
  to turn either on is rejected 422. The v1 ships no helper spawning, no MCP
  bridge, no SDK/CLI job backend, and no tool routing.
- **Terminal-state atomicity:** Cancel, overall-deadline, failure, and
  restart-interruption paths all share one `settleRunAtTerminal()` helper so
  the ledger drain (reserved → consumed, reported totals null) and
  step/invocation normalization happen in the same SQLite transaction as the
  `run.terminal` event + final assistant message. Late adapter callbacks are
  CAS-discarded without mutating usage. Covered by the acceptance regressions
  in `tests/integration/acceptance.test.ts` (terminal accounting, Team cancel
  step normalization, restart-interruption settlement).
- **File attachments:** per-conversation uploads sit behind a store-wide gate
  (concurrency 1, 120 s deadline, bounded waiting queue) that aborts the
  request stream and awaits writer / extraction cleanup before releasing. The
  attachment row flips to `ready` only after multipart EOF; cleanup never
  unlinks `ready` or already-bound blobs. Known @fastify/multipart /
  @fastify/busboy parser errors map to 4xx (`FST_FILES_LIMIT → 400`,
  `FST_REQ_FILE_TOO_LARGE → 413`, `ERR_STREAM_PREMATURE_CLOSE /
  FST_PARTS_LIMIT / FST_FIELDS_LIMIT / FST_PROTO_VIOLATION → 400
  multipart_malformed`), never 500. `@fastify/multipart` is exact-pinned to
  [v10.1.4](https://github.com/fastify/fastify-multipart/releases/tag/v10.1.4)
  for upstream
  [issue #594](https://github.com/fastify/fastify-multipart/issues/594)
  ([PR #595](https://github.com/fastify/fastify-multipart/pull/595), released
  in v9.3.0 / v9.4.0) so a malformed body does not crash the Node process via
  an unhandled FileStream `error` event. Defense-in-depth per-part +
  per-request error listeners guard a future regression. Preview + download
  routes set a strict sandboxed CSP that the global `onSend` hook preserves;
  `X-Content-Type-Options: nosniff` + `Cache-Control: no-store` are always
  present. HTML / SVG / XML / office content is never rendered as active
  content. Exports persist only attachment metadata (id, display name,
  sniffed MIME, kind, byte size, hash, state, extraction status/coverage,
  image dimensions, PDF pages, media duration/streams/format/normalized
  MIME); no bytes, base64, extracted text, blob paths, or credentials are
  included.

  **Uploaded content is untrusted data.** Extracted text and native parts
  are always preceded by the same notice in every adapter, and nothing in a
  file can grant tools, permissions, or credentials. Parsers are bounded and
  isolated: `pdfinfo`/`pdftotext`/`ffprobe` run from fixed absolute paths with
  `shell:false`, a fixed environment, a timeout, output caps and an abort
  signal that kills the child before the upload gate is released; `ffprobe`
  only ever sees the read-only blob descriptor (`-protocol_whitelist fd`);
  Office/ZIP parsing runs in a `worker_threads` worker with resource limits
  that is terminated (awaited) on abort or timeout. DTDs, entity declarations,
  external references, macros and formulas are never processed; ZIPs are never
  unpacked to disk, recursed into, or executed; entries are CRC-checked and
  cross-checked against local headers; parser stderr and file paths are never
  surfaced; `/providers` exposes only two parser-availability booleans and
  whether a profiles file is configured (never its path). Media is previewed
  only after structural validation. See `tests/integration/content_parsers.test.ts`
  and the real-HTTP regressions in
  `tests/integration/attachments.test.ts` and the native-wire contract tests
  in `tests/adapters/native_attachments.test.ts`.

**Residual risk (attachment analysis).** Poppler and ffprobe run unsandboxed
  with the server user's OS privileges and filesystem access; a vulnerability
  in either would run with those privileges, so keep them patched and run the
  server as an unprivileged user. The worker thread bounds CPU and heap but is
  NOT a security boundary (it shares the server process, and `resourceLimits`
  do not cap Buffer memory). The untrusted-content notice is advisory to the
  model, not a guarantee: file text can still steer answers, and agreement
  among agents does not establish truth.

### What is still deferred

- No external security review. No automated live-provider contract tests. No
  CI publishes releases from this repository today. No hosted deployment, no
  multi-user identity. Rate limits and cost controls apply only within one
  local instance.
- See `docs/design-review.md` for the full tested-vs-deferred inventory.

## Reporting a vulnerability

If enabled, use [GitHub private vulnerability reporting](https://github.com/jirawatp/proofestra/security/advisories/new)
to share a suspected vulnerability privately. Include affected files or versions,
reproduction steps, likely impact, and a minimal example with secrets removed.

If private reporting is unavailable, open a minimal public issue requesting a
private contact channel. Do not include exploit details, API keys, personal
conversations, sensitive traces, or other confidential information in that issue.
Wait for a private channel before sharing those details.

This is an early personal project; no response-time or remediation service level
is currently promised. Please avoid testing systems or accounts you do not own
or have permission to test.

## Security goals for future implementation

- Keep provider API credentials on the server side. Do not embed them in browser
  bundles, expose them to agents, or include them in logs, exports, or traces.
- Treat user prompts, retrieved text, tool results, and model output as untrusted.
  They must not grant permissions or override application security boundaries.
- Require explicit permission boundaries for tools and external side effects.
  Matching task grants permit automatic work; missing scope requires an approval
  bound to the concrete action. Children and tool output cannot enlarge a grant.
  Recheck revocation before dispatch and isolate approval credentials/control
  surfaces from agent-operated browsers or CLIs, including the authenticated UI.
- Validate tool/model/backend compatibility and constrain provider-hosted tools
  before dispatch. Use supervised, scoped SDK/CLI workers with supported auth;
  never scrape session tokens or launch unrestricted model-generated shell commands.
- Keep imported skills/plugins and custom MCP contributions scoped and versioned.
  Loading instructions or a manifest grants no authority or script execution.
  Store server credentials centrally, namespace tools, and isolate branch scratch
  state/results even when agents share one registration. Recheck enablement,
  version/digest and revocation before dispatch; preserve uncertain remote effects.
- Minimize retained conversation data and make retention and deletion behavior
  clear. Exports and traces may contain sensitive data and need careful handling.
- Apply provider request limits and cost controls, and handle provider failures
  without silently presenting an incomplete review as a completed check.
  Separate visible requests, observed tools, native jobs, and unknown internal
  usage. Exclude a backend when it cannot enforce a required policy boundary.
- Stop local process trees and request supported remote interruption. Preserve
  uncertain external completion and reconcile it before a side-effecting retry.
- Preserve uncertainty and disagreement. Model agreement is not proof of
  correctness, and cross-checking is not a substitute for independent evidence.

These goals require implementation and verification before deployment with real
credentials or sensitive data.

## Native CLI backends

Codex can be wired as a subprocess that uses the CLI's own existing login. The
application never reads, stores or forwards that login or any token, passes a
credential-free environment, requires the CLI's own status to report a ChatGPT login
before every job (never an API-key login), and keeps execution fail-closed (`unverified`) until
the tool surface is proven disabled for the installed version; it is currently
refused for codex-cli 0.163.0. Antigravity is never executed. A native backend
never falls back to a paid API. Report a suspected bypass privately as described
above. See PR-08..PR-13 and DLOG-018.

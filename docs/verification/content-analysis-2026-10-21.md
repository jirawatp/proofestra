# Proofestra content-analysis verification — 2026-10-21

Local uncommitted branch `codex/project-traceability` on baseline
`a96dedf3ae94eb7d07cd971e9cd20886151966ed`. Existing origin resolves to
`jirawatp/proofestra`. The application implementation was developed in Cursor;
the later requested quality/rule configuration used an explained local-file
fallback because native Cursor control was unavailable in the verifying session at
that time (historical; native control has since been restored). No app
implementation was changed in that fallback.

> **Superseded for current results (2026-10-22):** see
> [release verification](release-verification-2026-10-22.md) for the current
> measured gate, the closed Opus review and the current-build HTTP/UI checks. This
> page is preserved as the 2026-10-21 record.

## Current result

The compiled local app runs on loopback port 3000 with live mode disabled. Real
bounded PDF, Office and ZIP extraction works on the synthetic fixtures. Validated
short audio/video is eligible for native Gemini payloads; it is not locally
transcribed, and no provider has been shown to understand it. Unsupported,
encrypted, partial and unsafe content remains explicitly labeled. No arbitrary
archive execution, recursive extraction, OCR or general media transcription exists.

The coverage requirement is **met locally** after the 2026-10-21 coverage pass
(see the table). Independent Opus review is closed with no code/test blocker;
operator Chrome QA and a current-build HTTP check remain pending. The three-model
workflow executed for this pass (operator-observed in the native UI): GPT-5.6 Sol
Medium planned, Claude Sonnet 5.5 High implemented with two pinned delegates, and
Claude Opus 5.5 reviewed independently. Mock/local verification and Cursor
model-run evidence are not live-provider readiness.

> **Historical vs current.** The rows marked *(historical, pre-coverage)* below
> (production content HTTP, general attachment HTTP, real SSE socket, independent
> source-parser/wire suite) were run on the build BEFORE the coverage pass and the
> fixes in DLOG-017. They are NOT current-build verification. The data-count
> figures further down are likewise from that earlier time.

## Final checks

| Check | Actual result |
| --- | --- |
| Unit/integration/adapter/web tests | 1369 passed, 63 files, under final V8 coverage; two consecutive runs identical (earlier baseline: 398 / 23 files) |
| Statements | 98.23% (5191/5284), passes 90% (baseline 60.70%) |
| Branches | 95.36% (3742/3924), passes 90% (baseline 57.04%) |
| Functions | 98.92% (826/835), passes 90% (baseline 58.82%) |
| Lines | 99.26% (4586/4620), passes 90% (baseline 63.26%) |
| Denominator | All 53 production TS/TSX files measured, no exclusions, no ignore directives; a 99.5% statements probe exits 1 |
| Lint / server+web+tests typecheck | Pass |
| Parser-capability preflight | Pass: Poppler 26.04.0 and ffprobe 7.1.1 on this host |
| Full dependency audit after coverage provider install | 0 vulnerabilities |
| Production build / built-worker smoke | Pass after final configuration, and again after the coverage pass (2026-10-21) |
| Whitespace / helper script syntax | Pass |
| Production content HTTP suite *(historical, pre-coverage)* | 48 pass, 0 fail, 0 not run; not re-run against the changed server code |
| Production general attachment HTTP suite *(historical, pre-coverage)* | 20 pass, 0 fail, 1 explicit skip: shared-directory global disk snapshot |
| Real production SSE socket *(historical, pre-coverage)* | Live tail, ordered terminal, replay/resume, caught-up204, future400 and own cleanup pass |
| Independent source parser + injected-wire suite *(historical, pre-coverage)* | 44 pass, 0 fail; 12 injected Gemini requests preserve bytes/MIME |
| Remote CI | Configured, not executed; no push or dispatch |

*(Historical, pre-coverage.)* The 48-check production suite uploaded 40 synthetic PDF/Office/ZIP/media cases,
checked real extracted markers using only owned rows, reloaded metadata, verified
safe previews and unsafe422 refusals, froze eight mixed refs in a seven-call mock
Team run, checked metadata-only export, and observed cancellation after the body
finished: DELETE204 / upload409 / nextupload201. It cleaned six owned conversations
and verified 42 owned blob keys absent. Existing production totals stayed 15
conversations and 31 messages; migrations1-5 are applied and no active run remains.

*(Historical, pre-coverage.)* The general suite covers authentication/Origin/CSRF, Thai text, mixed files,
limits, hashes, immutable refs/idempotency/foreign and reused refs, follow-up Team
history, unsupported coverage, exports, MIME spoofing, huge raster guard,
hostile ZIP, oversize, malformed and interrupted multipart, retry and own cleanup.
Its single skipped global snapshot was intentionally omitted on shared user data;
the content suite verifies ownership-scoped blob cleanup separately.

All provider calls in these checks were mocked or intercepted with fake keys.
External fixture HTTP/source checks do not contribute to coverage percentages
unless instrumented. V8 automatic subprocess attachment is disabled because it
injects an environment variable into fixed-env children; the security assertion
was preserved and worker-only code remains included even when uncovered.

## Release blockers and exact status

1. **Coverage: passes locally.** The 90% thresholds stay active in local scripts
   and CI with auto-update disabled. Web coverage is jsdom with a mocked API
   module and parser coverage includes direct instrumented calls (not child-worker
   coverage); neither is native-browser, live-provider or remote-CI evidence.
   Defects fixed: DLOG-017 / RLOG-020. Independent review is closed. Remaining: a
   current-build HTTP check and visible-Chrome QA, both pending operator approval of
   a restart (the `:3000` process is a mixed build; see CONTINUE.md).
2. **Model workflow: executed; independent review closed.** Operator-observed in
   the native UI (no silent fallback shown): GPT-5.6 Sol Medium (gpt-5.6-sol)
   planned; Claude Sonnet 5.5 High (claude-sonnet-5-5) implemented with two pinned
   delegates; Claude Opus 5.5 1M Max Fast (claude-opus-5-5) reviewed independently
   without delegation, found one MEDIUM test gap (fake XHR), and approved the
   correction. Historical facts preserved: an earlier Claude Fable 5.1 High
   planning request in another project returned **Model Blocked** ("Please ask
   your admin to enable access to Claude Fable 5.") and did not run; the user then
   replaced Fable with GPT Sol and Fable must not be retried. The user's spelling
   Sonet 5.5 is preserved; the UI says Sonnet 5.5 High.
3. **Native final UI QA: pending, not run.** Native control was unavailable during
   the original verification (historical) and is now restored, and the operator
   confirmed the earlier uncertain Cursor run completed without a duplicate.
   Final clipboard/picker/native drag-drop/reload/retry UI QA has not run. No
   browser scripts, DOM automation or shell-driven UI substitutes were used.
4. **Live provider: not run.** App live mode is disabled and built-in live
   profiles report disabled; no profile file is configured. This does not reveal
   secret presence in the running process. No new credentials, OAuth grants,
   services, paid calls or use of Google credits is authorized. Live media
   semantics require an authorized Gemini setup and a separately approved bounded
   test; wire-contract success alone is insufficient.

5. **Runtime state: mixed build, restart pending.** The long-running `:3000`
   process keeps the old server modules in memory while serving the rebuilt static
   UI and loading workers from disk. A restart plus current-build HTTP check awaits
   explicit operator approval (requested, pending); nothing here stopped,
   restarted or replaced it. Operator read-only data diagnostics (not a QA pass):
   15 conversations, 31 messages, 17 runs, 16 attachments, 0 active runs, 0
   uploading, 0 orphan blobs, 0 missing ready/bound blobs, migrations 1-5; no user
   content read.
6. **Remote CI: configured, not run.** Live providers remain unverified.

The Fable denial is Cursor account policy, not an automatic sandbox-approval
rejection. No public deployment, commit, push, merge or license change occurred.
The isolated QA server was stopped; production port3000 was left running.

## Run and reproduce

Use this existing local checkout; a fresh public clone still lacks the uncommitted
implementation. Node22.19.0 is pinned in .nvmrc. Install dependencies with
`npm ci`, then `npm run build` and `npm start`; open loopback port3000.
Optional Poppler and ffprobe enable PDF text and media metadata, respectively.
Office/ZIP text extraction needs no additional external parser service.

Quality: `npm run check:parsers`, `npm run check`. The latter passes locally,
including the coverage gate. `npm run test:coverage` produces ignored
HTML, JSON, JSON-summary and LCOV reports under coverage/. See
[development policy](../development-policy.md) and [CONTINUE](../../CONTINUE.md).

Latest correction: the user explicitly replaced Fable with GPT Sol; Opus 5.5 and
Sonnet 5.5 roles remain. See RLOG-019/DLOG-016/XLOG-013 and the current development
policy. Historical Fable denial is no longer a request to enable Fable access.

Model-pinned project agents are installed with gpt-5.6-sol planner,
claude-sonnet-5-5 worker and claude-opus-5-5 reviewer. All three executed for the
coverage pass (operator-observed in the native UI) and independent review is
closed. Visible-Chrome QA and a current-build HTTP check are pending.

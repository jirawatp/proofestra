# Proofestra release verification — 2026-10-22

At this checkpoint: local, uncommitted branch `codex/project-traceability` on baseline
`a96dedf3ae94eb7d07cd971e9cd20886151966ed`. Scope: the **whole v1 application**
(mock-by-default chat, attachments and content extraction, Live API adapters behind
explicit opt-in, and the fail-closed native backends). The Apache License 2.0
`LICENSE` and `NOTICE` files are preserved unchanged.

This record states what was measured and what was not **at this local verification
checkpoint** (the work was uncommitted and unpublished when it was made). It is not
evidence of remote CI, of live-provider behavior, or of a working native
subscription backend; any later publication and remote CI results belong to the
pull-request checks, not to this record. Everything below was run locally by the
operator against fixtures, fake processes and an isolated disposable dataset.

## Result summary

| Gate | Result |
| --- | --- |
| Canonical `npm run check` (clean isolated, locked install) | **PASS**: 1,579 / 1,579 tests in 68 files |
| Production source inventory | 56 / 56 TS/TSX files in the coverage report; none missing or extra |
| Statements | 5,792 / 5,905 = **98.08%** (required ≥ 90%) |
| Branches | 4,138 / 4,348 = **95.17%** (required ≥ 90%) |
| Functions | 913 / 923 = **98.91%** (required ≥ 90%) |
| Lines | 5,111 / 5,149 = **99.26%** (required ≥ 90%) |
| Other stages of the gate | parser-tool preflight, lint, all three typechecks, server and web build, compiled-JavaScript worker smoke (no `tsx`): all pass |
| Production dependency audit | 0 vulnerabilities (info, low, moderate, high, critical all 0) |
| Input integrity | 230 candidate files hash-checked before and after the run: 230 unchanged, none added, missing or changed |
| Independent Opus review | closed, no code or test blocker (see below) |
| Current-build HTTP/SSE/security checks | pass on a disposable dataset (see below) |
| Native Chrome QA | partly complete (see "Not completed") |

The 90% thresholds are **global** across all production `src/**/*.{ts,tsx}` files
for each of the four metrics; there is no per-file 90% floor and none is claimed.
Thresholds, the all-source denominator and the `exclude: []` setting were not
changed by the fix described below. The earlier 1,537-test and 1,369-test figures in
older records are historical and are not current proof.

## How the canonical run was made

The run used a clean snapshot of the 230 non-ignored candidate files (no ignored
build output, dependencies, application data, authentication files, databases,
sessions, Git metadata or runtime logs), Node 22.19.0 and npm 10.9.3, an isolated
home and temporary directory, empty user/global npm configuration, lifecycle
scripts disabled (`npm ci --ignore-scripts`, installed offline from a public-registry
cache; no lockfile repair), and live/native execution disabled. The only external
network operation was the explicitly authorized production dependency audit.
Tests used synthetic fixtures, temporary SQLite stores, fake vendor executables,
the tests' own child processes and ephemeral loopback traffic. No real vendor CLI,
provider key, subscription inference, login or grant, or physical device was used.

### The clean-checkout correction this run follows

An earlier canonical run in the same clean setting failed one test: the OpenAPI
contract test asserted that a design-only route (`GET /extensions`) is not served,
and it expected the documented 404 error envelope. In a checkout without a client
build, the server answered an unknown API path with Fastify's default 404 body,
because the custom not-found handler was only installed when static client assets
existed. The route did not exist; the defect was the inconsistent 404 body (see
XLOG-019). The fix always installs the handler (an unknown `/api/` path returns the
documented envelope with or without a build; non-API paths still fall back to the
SPA only when a build exists), and the contract test now constructs both a built
and an unbuilt state explicitly. The failed run is preserved in the operator's
records and is not represented as passing.

## Independent review

Claude Opus 5.5 reviewed the follow-up change independently (native Cursor UI, as
observed by the operator; no silent fallback shown). Closure was completed at
15:04 (UTC+7) on 2026-10-22 against the 14:59 fix: **all six earlier findings and
the clean-checkout 404 are closed with no code or test blocker.** Remaining items
are Low severity wording/comment/log nits, not missing features. Roles for this
cycle: GPT-5.6 Sol (planner, earlier pass), Claude Sonnet 5.5 High (worker),
Claude Opus 5.5 (reviewer). This is evidence of the Cursor model runs, not of
application-provider behavior.

## Current-build runtime checks

The original mock-mode server was restarted under guard on the current 53-file
build output (the build fingerprint matched the one that was checked); the saved
data counts and session counts were identical before and after the restart, and the
restarted process answered unauthenticated provider requests with 401 as expected.

A fixture-mutation script aimed at the **existing** saved data was denied by
automated review before it executed and was never retried. The checks therefore ran
against a freshly created, disposable, loopback-only dataset served by the **same
build**; the existing data was not mutated.

| Check | Result |
| --- | --- |
| Content HTTP checks over 40 synthetic fixtures | 48 passed, 0 failed, 0 not run |
| Attachment HTTP checks, with on-disk blob checks | 20 passed, 0 failed, 0 skipped |
| SSE tail, replay, resume and security checks | pass |
| Cleanup of the server process the operator owned | pass |

Setup problems in the first isolated attempt (eight Office fixture paths) were
fixed by relocating a hash-verified copy of the fixtures; application source was
unchanged.

### Native Chrome QA (screenshots and native mouse/keyboard; no DOM or Playwright automation)

Completed on the isolated dataset: text-file picker upload with the 89-byte file's
full-text preview; a mock Team run (3 drafts, 3 reviews, 1 synthesis, seven steps,
all Done); the run inspector showing simulated accounting for the mock run; reload
with conversation history and attachment persisting; and a 26 MiB fixture visibly
refused by the 25 MiB cap.

**Not completed in the native pass:** clipboard image paste, mixed multi-selection
through the native picker, throttled progress/retry/cancel, and native Thai text
input through the input driver. The HTTP checks above cover the relevant UTF-8,
multipart and cancellation cases at the API level, but they do **not** prove the
native user experience for those four interactions; they remain open.

## Limits and non-claims

- No real provider inference or paid call occurred. Mock and intercepted-wire tests
  are not live tests.
- Real Codex execution is `unverified` / `tool_surface_unproven` (and its
  ChatGPT-only authentication control is unproven) for codex-cli 0.163.0; Antigravity
  is `unverified` / disabled. Both refuse to run, fail closed, by design. Fake-process
  tests establish supervision and accounting behavior, not that a real subscription
  job is safe.
- Containment of a native job's descendants is reported unverified, not guaranteed.
- At this local checkpoint remote CI had not run: the workflow was configured
  locally and nothing was published. This record claims no remote pass; later
  publication and CI results belong to the pull-request checks.
- This evidence certifies the captured source checkpoint. Later edits, including
  documentation edits made after the run, need their own verification.
- Bounded static scans for secrets and private paths are not a guarantee against
  every possible encoding. No credentials, private conversations or raw
  reasoning/traces are stored in this repository.

## Related records

[RLOG-023](../logs/requirements.md), [DLOG-020](../logs/decisions.md),
[XLOG-018, XLOG-019 and XLOG-020](../logs/design.md), [CONTINUE.md](../../CONTINUE.md),
[development policy](../development-policy.md) and the earlier
[content-analysis verification](content-analysis-2026-10-21.md).

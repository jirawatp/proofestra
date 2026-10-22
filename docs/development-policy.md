# Development workflow and release gate

Confirmed user requirements on 2026-10-21; current planner correction is RLOG-019 / DLOG-016 / XLOG-013 (supersedes the planner portion of RLOG-018 / DLOG-015 / XLOG-012).

## DEV-01 — Model roles

Use the user's current requested development roles: **GPT Sol** for planner and
designer, **Opus 5.5** for reviewer and advisor, and **Sonet 5.5** (the user's
exact spelling) for worker. Before assigning substantive new implementation,
inspect Cursor's actual available model names and record the selected model for
each role. If the UI identifies **Sonnet 5.5** as the intended worker, record that
verified mapping explicitly. Do not silently substitute another model or claim
these models ran merely because this instruction exists. An unavailable model or
unavailable model picker is a specific blocker for that role; continue independent
verification and preparation, then report the blocker. Never create a new grant,
subscription, paid API call or spending authorization to satisfy this rule.

At initial configuration (historical, 2026-10-21), native Cursor UI control was
unavailable; a coordinated task then supplied the picker/access evidence below,
and native control has since been restored. No claim is made that the requested
models performed that configuration change. Existing app
implementation was developed through Cursor before this new requirement. Record
model, role and the concrete result of each pass; public documentation cannot
establish account permission.

The always-on file is `.cursor/rules/proofestra-workflow.mdc` with
`alwaysApply: true`; AGENTS.md carries the same policy for other agents.
This is an instruction mechanism, not a programmatic model selector or security
boundary. No global settings, approvals or credentials are changed.

## DEV-02 — Coverage

`npm run test:coverage` uses matching Vitest/V8 coverage version 5.0.5 and
fails unless **statements, branches, functions and lines each reach 90%**.
All production `src/**/*.{ts,tsx}` files are included, even if no test imports
them. No production path is excluded. Generated output, tests and dependencies
are outside that explicit production-source glob. Type-only source has no
executable statements to cover. No automatic threshold updates are permitted.

V8 automatic subprocess/worker attachment is disabled: its injection of
NODE_V8_COVERAGE violates the tested fixed-environment parser boundary and did
not collect the native worker's source execution in the first measurement. That
security assertion remains unchanged. Worker-only code remains in the denominator
and may report zero until meaningful instrumented tests cover it safely; do not
exclude it or infer collection from successful parser checks. JSON summary, full JSON, LCOV and HTML
reports are generated under ignored `coverage/`, including on threshold failure.
External HTTP checks and native UI checks are useful separate evidence; they are
not included in percentages unless actually instrumented by this runner.

Run `npm run check` for lint, server/web/test typecheck, the coverage gate, build
and built-worker smoke. CI runs the same checks with a parser-capability preflight
using Poppler and ffprobe. CI intentionally fails if tools are missing instead of
claiming skipped real-tool tests passed. No CI run or publishing is triggered by
creating the workflow locally. No provider secret is passed to CI and live mode
stays disabled; provider contract tests use injected transports and fake keys.

Coverage is **configured and, as of the 2026-10-21 coverage pass, achieved
locally**: 98.23% statements, 95.36% branches, 98.92% functions and 99.26% lines
over all 53 production files (63 files / 1369 tests; RLOG-020, XLOG-014, XLOG-015).
The requirement is a global 90% on each metric; no per-file 90% floor exists. That is a
mock/jsdom/instrumented-parent-process result; direct Office/ZIP/worker-entry
tests are not child-worker coverage. See CONTINUE.md for remaining release gates. Add behavior tests for uncovered
user flows and failure paths; do not hide gaps by excluding UI, workers, parsers,
entry points or adapters, or by adding meaningless tests.

References: [Cursor project rules](https://cursor.com/docs/rules.md),
[Vitest coverage configuration](https://vitest.dev/config/coverage.html).

## Earlier coordinated Cursor model check (Fable superseded)

A separate task with working native UI control observed these account-specific
picker labels. This Proofestra session has no working native UI tool and did not
repeat the selection or submit another prompt.

| Requested role/model | Observed Cursor label | Evidence and limit |
| --- | --- | --- |
| Planner/designer: Fable 5.1 | Claude Fable 5.1 High | Listed, but a planning submission in another open Cursor project returned **Model Blocked**: "Please ask your admin to enable access to Claude Fable 5." The planning model did not execute. No retry or substitute was made. |
| Reviewer/advisor: Opus 5.5 | Claude Opus 5.5 (Medium in local IDE; 1M Max Fast in Agents window) | Picker availability observed; no Proofestra role execution or permission check is claimed for this new requirement. |
| Worker: user-spelled Sonet 5.5 | Claude Sonnet 5.5 High | The UI uses **Sonnet**, not the user's **Sonet** spelling. Preserve the original request and record this UI-label mapping; no new Proofestra worker run is claimed. |

The user subsequently replaced Fable with GPT Sol; Fable access is no longer a
required current dependency. The denial remains historical evidence and must not
be retried. Do not create credentials, enable billing, buy access, or infer
permission from picker visibility. Independent checks/reporting may continue.


Verified parameter-menu IDs from the coordinated native check: Fable
`claude-fable-5-1`, Opus `claude-opus-5-5`, Sonnet
`claude-sonnet-5-5`. These are observed picker IDs, not new configured API
models or evidence of execution. The user has explicitly changed the planner to GPT Sol; do not retry denied
Fable through another route.

## Current planner replacement (2026-10-21)

The user's latest instruction, preserved exactly, was: "ง้้นเปลี่ยนจาก Fabel เป็น GPT Sol".
GPT Sol replaces Fable for planner/designer. Opus 5.5 remains reviewer/advisor;
Sonnet 5.5 remains worker (the original request spelled Sonet). The coordinated native UI check verified **GPT-5.6 Sol Medium**, internal ID
**gpt-5.6-sol**, and reported a successful native planning run. Do not guess a version, equate it with this Codex session's
model, or claim a planner run. This changes no 90% coverage requirement or approval boundary.

## Installed model-pinned project agents

| Role | Project definition | Exact model ID | Execution evidence |
| --- | --- | --- | --- |
| Planner/designer | .cursor/agents/proofestra-planner.md | gpt-5.6-sol | Operator-observed native UI: GPT-5.6 Sol Medium selected, parameter ID verified, plan produced successfully (2026-10-21) |
| Worker | .cursor/agents/proofestra-worker.md | claude-sonnet-5-5 | Operator-observed native UI: Claude Sonnet 5.5 High selected and executed the implementation, plus two pinned worker delegates (a parser child's native header showed Claude Sonnet 5.5) |
| Reviewer/advisor | .cursor/agents/proofestra-reviewer.md | claude-opus-5-5 | Operator-observed native UI: Claude Opus 5.5 1M Max Fast selected and executed the independent review without delegation; one MEDIUM test gap found, corrected, A/B-proven and re-reviewed; no code/test blocker remains |

Definitions use documented Cursor project subagent frontmatter; planner/reviewer
are read-only. Plain model IDs pin identity but do not pin the observed effort
preset. Cursor documents possible model fallback under access/plan restrictions;
the always-on rule requires checking actual execution and reporting a mismatch.
A rule file alone does not prove the workflow ran; for the 2026-10-21 coverage pass
the operator observed all three role executions in the native UI (no silent
fallback shown). That is Cursor model-run evidence, not live application-provider
proof. Native control is restored. The 2026-10-22 operator verification
(current-build HTTP checks and a native Chrome pass on an isolated dataset, with four
interactions still open) and the closed Opus review are recorded in
[release verification](verification/release-verification-2026-10-22.md).
Reference: [Cursor subagents](https://cursor.com/docs/subagents).

## DEV-03 — Publication and subscription constraints

Worker, planner and reviewer agents never stage, commit, push, open a pull request,
merge or deploy. Publication is a human-operator action after final verification
(full `npm run check`, `npm run test:coverage` at >=90% each, audit, HTTP and native
Chrome QA, and the independent Opus review); any authorization the operator holds
for a session lives outside this repository and is not recorded here as a standing
permission. (An earlier revision of this section recorded a one-task authorization;
it was removed on 2026-10-22 because a permanent rule must not embed task-scoped
permission. See RLOG-023.) Subscription-backed tests must use an officially
supported, already-signed-in vendor surface; paid API substitution, purchases, new
credentials/OAuth grants, persistent access, security-setting changes, token or
auth-file reads and session-token reuse remain prohibited. See PR-08..PR-13 and
DLOG-018 for the native backend design and its fail-closed states.

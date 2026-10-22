# Working on Proofestra

Read [CONTINUE.md](CONTINUE.md) and [the project history index](docs/logs/README.md)
before resuming work. Inspect the current branch, Git status, and recent commits;
preserve unrelated changes. The handoff's branch/date is a checkpoint, not a reason
to reset a newer checkout.

## Source of truth

- The current user request takes precedence over earlier design choices.
- [Requirements](docs/requirements.md) use stable IDs and named acceptance scenarios.
- [Decisions](docs/decisions.md) distinguish confirmed choices from proposed defaults.
- Current architecture, technical/API design, and agent/tool policies describe
  intended behavior. Dated [logs](docs/logs/README.md) explain its evolution.
- [Design review](docs/design-review.md) distinguishes tested artifacts from
  unimplemented capabilities. Do not turn documented provider support or a mock
  result into a claim that a live integration works.

## Traceability and handoff

For a material requirement, decision, or design change, update its current spec
and append an entry to the corresponding log. Preserve existing requirement/log
IDs. Reference affected requirements, files, source/evidence, validation, and any
superseded entry. Do not rewrite history to hide changed decisions.

Before handing off, update CONTINUE.md with the actual implementation state,
next actionable work, and unresolved choices. Use repository-relative paths and
Git revisions; do not rely on a chat transcript, local preview URL, generated
workspace path, or another machine's installed tools. Record new validation
evidence for changed behavior rather than reusing an older pass as current proof.

## Project boundaries

Keep the published core fully Apache 2.0. Preserve distinct agent identities,
same-provider teams, scoped delegation, compatible tool routing, permission
boundaries, honest native usage, and uncertainty. Review and agreement do not
establish truth. Keep credentials, private conversations, and raw reasoning/traces
out of the repository. Default development uses mocks; live calls remain opt-in.

Read CONTRIBUTING.md and SECURITY.md for contribution, validation, and security
expectations. Follow the user's requested task and branch scope; this file does
not authorize publishing, deployment, paid runs, or changes to external services.

## Publication and subscription constraints (DEV-03)

Agents working here never stage, commit, push, open a pull request, merge or
deploy. Publication is an action of the human operator after final verification;
whatever authorization the operator holds for a given session lives outside this
repository and is not a standing permission recorded here. Subscription-backed
testing (existing signed-in ChatGPT Codex / Gemini Antigravity) is allowed only
through officially supported vendor surfaces that keep their own login: never a
paid API substitute, purchase, new credential/OAuth grant, persistent access,
security-setting change, token or auth-file read, or session-token extraction.
Subscription quota is not API credit and cost is never reported as $0.

Actual blocked states: Codex execution is `unverified` / `tool_surface_unproven`
for codex-cli 0.163.0 (the exec/unified_exec, apply_patch and code-mode tool
surface cannot be proven off, ChatGPT-only authentication is not proven enforced,
and a read-only sandbox is not no-tools) and is refused fail-closed. Antigravity is unverified/disabled. Do not weaken either without fresh
evidence recorded in the verification record, docs and logs (RLOG-021, DLOG-018).

## Required development models and coverage

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

These project-scoped requirements apply to every agent working here. Use the
plan → worker → independent review/advice workflow and preserve recorded model
identity and limitations. This changes no global approval or security policy.

Run `npm run test:coverage` and require **at least 90% statements, branches,
functions and lines**, including every production TS/TSX file. Keep the gate in
CI. Never dilute its denominator through broad exclusions, lowered thresholds,
coverage-ignore directives or trivial tests. Passing tests alone do not establish
coverage. See [development policy](docs/development-policy.md) for scope, commands,
model verification status and the distinction between configured and achieved.

Verified project agent definitions: use proofestra-planner
(gpt-5.6-sol; observed UI GPT-5.6 Sol Medium) for planner/designer,
proofestra-worker (claude-sonnet-5-5) for implementation, and
proofestra-reviewer (claude-opus-5-5) for independent review/advice. Definitions
live in .cursor/agents/.

Role execution for the 2026-10-21 coverage pass, as observed by the operator in
the native Cursor UI (model labels and parameter IDs; no silent fallback shown, no
Fable retry): planner GPT-5.6 Sol Medium (`gpt-5.6-sol`) produced the plan; worker
Claude Sonnet 5.5 High (`claude-sonnet-5-5`) implemented it with two pinned
`proofestra-worker` delegates (a parser child's native header showed Claude Sonnet
5.5); reviewer Claude Opus 5.5 1M Max Fast (`claude-opus-5-5`) reviewed
independently without delegation. The review found no blocking defect and one
MEDIUM test gap (a fake XHR that always emitted `abort`), which was corrected,
A/B-proven and re-reviewed; no code or test blocker remains. This is evidence of
the Cursor model runs, not of live application-provider behavior. Still check
actual model identity each run; do not accept Cursor fallback as the requested
model. Exact effort presets are not pinned by the plain model ID.

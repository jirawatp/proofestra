# Contributing to Proofestra

Proofestra now has a working local-only, mock-first v1 implementation on
branch `codex/project-traceability` in this checkout. The source is
**uncommitted and unpublished**: a fresh clone of the public remote will not
include it until the branch is pushed and merged. Until then, the installed
copy in this checkout is the only working build. A standalone simulated
interface at `docs/prototype/` remains the previous published entry point.

## Current implementation and supported subset

Delivered in this working tree (verified by the test matrix in [docs/design-review.md](docs/design-review.md)):

- Fastify + SQLite backend with REST + SSE, Vite React UI, TypeScript end-to-end.
- Mock-default execution with opt-in live mode (`PROOFESTRA_LIVE_ENABLED=1`
  AND per-run `execution_mode: "live"`).
- OpenAI / Anthropic / Gemini adapters with shared safe-non-negative-integer
  usage-counter validation; Gemini accounting includes `thoughtsTokenCount`.
- Terminal-state settlement shared between `finalize()`, `cancelAndFinalize()`,
  and `markInterruptedOnStartup()`: reservation drain, sticky-unknown usage
  nulling, step/invocation normalization, atomic snapshot + terminal event
  commit.
- Loopback-only HTTP boundary (Host + Origin allowlist, session cookie, CSRF).

- Bounded content analysis of attachments (PDF via Poppler, DOCX/XLSX/PPTX/ODF,
  ZIP text entries, `ffprobe` media metadata; no transcription), validated
  native routing, and untrusted-content framing. Parser tests use synthetic
  fixtures in `tests/fixtures/content/` (see its README; never decode or render
  the hostile `huge-dimensions-header-only.mp4`) and skip visibly if Poppler or
  `ffprobe` is not installed (so test counts differ without them). After `npm run build`, `node tests/smoke/worker-dist.mjs`
  proves the built worker runs without tsx.

Not implemented in v1 (explicitly deferred):

- Tool execution, MCP bridges, SDK/CLI job backends, delegation/helper spawning.
- Live-provider end-to-end automated tests. The adapters have deterministic
  mocked-HTTP contract tests; a CI workflow (`.github/workflows/quality.yml`) is
  configured but has not run remotely, and the "live" path has never been
  exercised.
- Hosted deployment, multi-user identity, external security audit, published
  releases from this repository.

For a new checkout or chat, begin with [CONTINUE.md](CONTINUE.md) and
[AGENTS.md](AGENTS.md). Use the [project logs](docs/logs/README.md) to understand
changes without relying on the original conversation.

## Optional system tools

PDF text and media metadata need Poppler (`pdfinfo`, `pdftotext`; verified
26.04.0) and FFmpeg's `ffprobe` (verified 7.1.1) in `/opt/homebrew/bin`,
`/usr/local/bin` or `/usr/bin` (fixed lookup, never `$PATH`, once at server
start; restart after installing). `GET /api/v1/providers` shows availability
as booleans. Real-tool tests skip visibly when a tool is absent. Local
validation is `npm run lint`, `npm run typecheck` (server, web and tests),
`npm run test:coverage` (>=90% statements, branches, functions and lines),
`npm audit --include=dev` and `npm run build`. `.github/workflows/quality.yml`
runs the same gate (`npm run check`) but is configured only, never yet run
remotely.

## Useful contributions

- Clarify the product goals, architecture, or roadmap with concrete examples.
- Identify gaps in provider compatibility, privacy, cost controls, or evaluation.
- Improve accessibility, onboarding, and documentation.
- Propose a small implementation milestone with clear acceptance criteria.

Open an issue before starting substantial work so we can agree on its scope.
Keep pull requests focused and explain the problem, proposed behavior, and any
tradeoffs. Separate unrelated changes into separate pull requests.

For material requirement, decision, or design changes, update the current
specification and append a dated entry to its project log. Preserve stable IDs,
link affected requirements and evidence, and reference superseded entries rather
than overwriting their history. Update the continuation checkpoint with actual
results, validation limits, and next work before handing off.

## Validation

For documentation, check links, keep statements consistent with the project's
actual state, and run `git diff --check` before submitting. Do not describe
planned functionality as available.

When runnable code is added, include tests appropriate to the change, including
failure cases. Provider-related tests should use mocks or fixtures by default;
live, paid API calls must be explicitly opted into. Never commit API keys,
personal conversations, or sensitive traces. Report what you tested and any
checks you could not run.

Treat prompts, retrieved content, and model output as untrusted input. Multiple
models agreeing does not establish correctness; preserve evidence,
disagreements, and uncertainty in proposed behavior.

## License

The open-source core is licensed under [Apache License 2.0](LICENSE). Contributions
intentionally submitted for inclusion are covered by Section 5 of that license,
subject to its terms. No separate CLA or DCO process is currently required.

Potential paid products must preserve the Apache 2.0 licensing of the published
core. Discuss changes to project boundaries before proposing commercial-only
features here.

## Required model roles and coverage gate

Follow [AGENTS.md](AGENTS.md) and [development policy](docs/development-policy.md).
Use `npm run check:parsers` and `npm run check`; `npm run test:coverage`
enforces 90% each for statements, branches, functions and lines across all source.
An unfulfilled model role or failing measured coverage is an explicit release gate.
The workflow file is local until published through a separately authorized action.

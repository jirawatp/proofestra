# Design review record

Reviewed 17 October 2026, updated 21 October 2026 to reflect the local
mock-first v1 implementation on branch `codex/project-traceability`. The 17
October entries below cover the standalone design package / simulated
interface; the "Implementation status" section at the bottom records what the
v1 implementation now tests versus what remains deferred.

> The v1 implementation is **uncommitted and unpublished** at this checkpoint
> — a fresh clone of the public remote does not include it. Everything the
> implementation section describes runs only against the installed local
> working tree in this checkout.

## Scope

The user confirmed personal self-hosting, own provider keys, and OpenAI,
Anthropic, and Gemini together in the first live version. The requirements,
experience, technical design, API contract, evaluation plan, and roadmap use that
scope. Users can configure multiple agents from one provider and every provider's
agents can request bounded subagents. Other defaults remain proposed choices,
recorded in [decisions](decisions.md) and [agent policy](agents.md).
The latest direction adds extensible provider/tool/backend registries and
automatic capability routing within task grants. The user confirmed all tool
surfaces: API tools, local agent apps/SDKs/CLIs, functions/MCP/local tools, and
supported hosted agent services. Each integration still needs compatibility tests.
The initial three API adapters remain the first live targets.
The next user-confirmed scope adds shared skills, plugin bundles, and custom MCP
registrations usable through connected provider adapters. See
[extensions](extensions.md), EX-01–EX-08, A21–A25, and XLOG-006.

## Checks performed

- OpenAPI 3.1.1 validation, twenty-two embedded request/schema/event examples, and
  twenty-four rejected invalid-schema cases passed. The contract has fifteen
  paths and seventy-one schemas. Checks cover
  extensible provider IDs, capability/runtime-policy metadata, tool execution,
  exact-action approvals, and native usage visibility. Semantic fixtures cover
  repeated profiles, unique IDs, synthesizer membership, lineage/cycles, dynamic
  policy, and invocation-scoped spawn deduplication. These are design-contract
  checks, not backend tests.
  Seventeen semantic design fixtures passed, including shared direct/bridge
  registrations, unsupported profiles, namespace/provenance, pinned-version
  lifecycle, grants, helpers-off, and branch isolation. Invocation-scoped spawn
  identity, exact-action argument digests, null opaque usage and native-job
  defaults were preserved. These fixtures are transient design checks; there is
  no reusable backend acceptance suite yet.
- Relative documentation links, referenced anchors, and whitespace were checked.
- The prototype's embedded JavaScript passed a syntax check.
- Browser checks preserved two OpenAI roots with different profiles, exact
  synthesizer-agent selection, and two same-provider helper children. The Team
  sample used ten calls: seven base, two helpers, one parent continuation. Sources
  remained unverified; no external requests or script errors were observed.
- Two OpenAI roots with the same profile stayed distinct and completed five
  base calls; selecting the second root as synthesizer targeted its ID.
- Quick completed with one call/cap one. Quick + helpers completed with four
  calls and no peer review. The prototype's script behavior checks also cover
  six roots and base/delegation modes.
- Quick + helpers was exercised separately with OpenAI, Anthropic, and Gemini
  parents. Each sample preserved the parent's provider for both children and used
  four calls. Observed shared scheduling peaked at three globally/two per provider.
- One unavailable OpenAI root did not invalidate its same-provider sibling.
  Selected synthesis was skipped rather than substituted, preserving the other draft.
- Stop during helper execution canceled both children, held the dispatched count
  at four, and scheduled no parent continuation after pending timers elapsed.
  The downloaded canceled JSON preserved ancestry/status and had no final answer.
- Desktop and 390-pixel mobile layouts were reviewed without horizontal overflow.
  Native keyboard/control behavior is retained; this is not a full accessibility audit.
- Automatic web/code routing completed with ten simulated API invocations, two
  known tool operations, and one managed same-provider helper. Direct web used the
  current mock profile; scratch work used a permitted helper. These fictional
  mappings make no vendor capability claim. Retrieval stayed support-unverified.
- The workspace-agent sample recorded eight simulated API invocations and one
  SDK/CLI job with unknown internal usage. It remained partial with live admission
  unvalidated; no SDK/CLI ran or filesystem work occurred. Strict versus explicitly
  admitted bounded-job policies are distinguished in the copy.
- Tools/helpers-OFF Quick used one request/cap one. Tools-ON/helpers-OFF Quick
  used direct web, blocked scratch helper creation, and created zero children.
  Helper depth, fan-out, total-node, and observed-tool quota checks passed in
  the embedded-script behavior fixtures.
- The permission scenario displayed exact mock publish content/destination and
  dispatched no tool/job; it illustrates a pause and has no real approval executor.
  An unsupported image capability added no backend or provider. These scenarios
  produced no external page requests or script errors during browser inspection.
- Stop during a tool operation preserved canceled state and four dispatched API
  invocations after pending timers elapsed, with no further continuation.
- Shared extensions completed with ten simulated API requests, three MCP
  operations, and three shared-skill instruction loads across OpenAI, Anthropic,
  and Gemini. All used one registration and namespaced tool ID; each root had
  a distinct branch/request/result and its own continuation before cross-review.
  Helpers were off and no child was created. No external page requests or script
  errors occurred in this browser check.
- A disabled MCP binding dispatched no operation. Removing the scoped read grant
  paused on the concrete action after three initial requests, with no MCP call or
  peer review. Quick tools-off loaded one skill context with one request/cap one,
  zero MCP operations, and no continuation. A blocked optional workflow stayed
  visibly partial rather than claiming a completed shared-tool check.
- Stop during shared MCP work canceled the two then-dispatched simulated
  operations and held the API count at three with no continuation after timers
  elapsed. Nonsecret connection labels replace internal credential references
  in the mock catalog/export; real auth configuration is specified as broker-only.

The design distinguishes provider/profile from agent identity, root reviewers
from helper artifacts, and the base call plan from dynamic total usage. Spawn
identity includes the immutable parent invocation because tool IDs can repeat
between responses. Waiting parents release execution slots, and all descendants
share quotas, context permissions, cancellation, and the run deadline.
Provider/tool IDs are extensible; finite personal defaults and the demo editor
cap are separate from deployment ceilings. Initial allowlists/grant references
are snapshotted, current grants are rechecked, and exact-action user approval
cannot add providers or mint a blanket grant. Helpers-off also requires native
helper suppression or route rejection. Approval credentials/control surfaces
must be isolated from agent-operated browsers and CLIs.

Official provider research is recorded in [provider capabilities](provider-capabilities.md).
Documented compatibility is not live readiness. Postman discovery's public Orbit
lookup returned HTTP 403; official documentation supplied the research fallback.

## What remains unverified

There is no backend, persistence implementation, provider integration, live
credential handling, or production security test. No model API calls, paid
evaluation, provider availability tests, or agent source-retrieval tools ran.
Official documentation was browsed for design research. The
standalone mockup keeps chat text in tab memory and exports only on user action.
Its delegation example shows two direct children. The nested policy and alternate
profile admission still require implementation; no arbitrary recursive runtime
or provider-native subagent system has been tested. Native SDK/CLI permission
hooks, auth, hidden loops, whole-tree usage, cancellation, remote cleanup, and
approval-channel isolation all need implementation-specific tests. Larger-team
review graphs and hierarchical synthesis remain extensions, not a measured
capacity claim. API tools, SDK-local MCP, remote connectors, and hosted agent
services must not be treated as equivalent execution surfaces.
Shared extension imports, package-manager write endpoints, native plugin-format
adapters, skill execution, MCP protocol/transport/auth compatibility, lifecycle
enforcement, and real cross-provider broker isolation remain unimplemented.
Current shared-catalog checks establish design/demo behavior only; no package was
installed and no custom MCP server was contacted.

The package is ready to guide the first mock-backed implementation slice. It is
not a claim that the proposed limits, security controls, or answer-quality gains
have been achieved. Live adapters and evaluation follow the [roadmap](roadmap.md).

## Implementation status (2026-10-21)

The local mock-first v1 implementation delivered in this working tree now
exists and the test matrix below documents the exact behaviours it exercises.
Branch: `codex/project-traceability`. **Not yet committed or pushed**; a fresh
remote clone will not have this code.

> **Update 2026-10-22:** the current measured results (1,579 tests in 68 files; 98.08 / 95.17 / 98.91 / 99.26 percent statements / branches / functions / lines) are in [release verification](verification/release-verification-2026-10-22.md). The 2026-10-21 figures in the heading below are preserved history.

### Tested locally (agent-run `npm run test:coverage`, 2026-10-21): 1369 tests across 63 files (the matrix below lists the earlier 398-test areas; later areas: `tests/web/*` jsdom component/API tests, `tests/unit/parsers_*`, `tests/integration/server_*`/`coordinator_*`, `tests/adapters/provider_*`) (a CI workflow is configured locally but has not run remotely)

| Area | Covering regressions |
| --- | --- |
| Context admission / token estimator | `tests/unit/context.test.ts` (framing-aware, ASCII/Thai/emoji, Team-3 worst case). The estimator is a conservative upper-bound heuristic, not a mathematical guarantee for proprietary provider framing; it CAN reject valid inputs. Provider-side `context_too_large` remains the authoritative final bound. |
| Schema / limits / idempotency | `tests/unit/{schema,limits,ids}.test.ts`. |
| Provider usage sanitization | `tests/adapters/sanitize.test.ts`. 62 fixtures across OpenAI / Anthropic / Gemini covering safe-integer validation of every usage counter (negative, fractional, non-finite, unsafe-integer, missing all return null); Gemini `thoughtsTokenCount` combined with `candidatesTokenCount`; `totalTokenCount - promptTokenCount` fallback only when strictly valid; candidate-only usage is NOT treated as "complete" when thoughts absent and no derivable total; overflow-protected `safeUsageSum`. |
| Provider native-attachment wire payloads | `tests/adapters/native_attachments.test.ts`. 12 tests assert the EXACT body shape sent to each vendor endpoint using an injected capturing `fetch`: OpenAI ChatCompletions `image_url` + `file` (data-URL base64), Anthropic Messages `image` + `document` with `source.base64`, Gemini v1beta `generateContent` `inlineData` for image + PDF + audio, and an honest `attachment_only` text note (no bytes sent). No live key. |
| Real-fixture content parsers | `tests/integration/content_parsers.test.ts`, `tests/unit/zip_core.test.ts`, `tests/unit/bounded_proc.test.ts`, `tests/fixtures/content/**` (synthetic only; relative-path manifests; the hostile `huge-dimensions-header-only.mp4` is probed only, never decoded or rendered). Every manifest entry is mapped to a test and an assertion fails if a fixture is unmapped. Poppler and ffprobe cases are real-tool tests with `skipIf` on the capability booleans, so a skip is visible in the report; mocked parsers never count as real parser validation. Covers PDF text/partial/scanned/malformed/empty/encrypted, 13 hostile ZIPs + encrypted ZIP, DOCX/XLSX/PPTX/ODT (including the `doc:` namespace variant, DTD and external-entity refusal, and bounded large sheets), media probing and routing decisions, worker abort/timeout/termination ordering, and a post-build worker smoke (`tests/smoke/worker-dist.mjs`). |
| Review-hardening tests | `tests/integration/content_hardening.test.ts` (builds hostile variants at test time in a temp directory from the committed fixtures: PDF metadata spoofing, scrambled codec tags, quadratic-XML inputs, XLSX stored values, strict UTF-8, ZIP text-entry hygiene, qt-brand patching, mid-run Poppler/ffprobe aborts with the blob descriptor released, PPTX slide order, an external entity with a real sentinel file beside it). |
| Coordinator-level provider payload contracts | `tests/integration/content_delivery.test.ts`. An explicit config literal with literal FAKE keys and an injected `fetchImpl` (global `fetch` stubbed to throw) capture every draft, review, synthesis and follow-up request for OpenAI, Anthropic and Gemini Teams and assert byte-exact native parts, the exact framed extracted text, the untrusted-content notice before native parts, history re-delivery, unsupported-media reasons, and the absence of paths, storage keys and keys. These are intercepted-request contracts: they prove what Proofestra sends, not that any provider understands it. No live call was made. |
| Attachment upload admission | `tests/integration/attachments.test.ts`. 24 real-HTTP regressions (the original 6 plus disconnect-during-parse abort for an injected slow extractor and for a real worker that is proven to have exited before the next upload is admitted, cancelling a queued upload (socket test), DELETE of a still-processing row and of its whole conversation (clean 409, no orphan blob), a row that vanishes without an abort, validated-metadata persistence, the media preview 422 guard including legacy rows, two-track and codec-scrambled media, and the `/providers` boolean and no-path exposure). The original 6 on an isolated port + dataDir: happy-path upload + ready publication, oversize → 413, too-many-files → `400 too_many_files`, malformed multipart → `400 multipart_malformed` (never 500), premature-close cleanup leaves no orphan + subsequent valid upload succeeds, draft delete cascades to attachments. |
| Coordinator terminal invariants | `tests/integration/acceptance.test.ts`. Terminal accounting (no double-charge after cancel + late callbacks), overall-deadline Partial fallback with draft fallback, truncated output ≠ full completion, Team cancel step/invocation normalization, restart-interruption settlement (reservation drain, sticky-unknown nulling, step normalization, ordered atomic terminal event, idempotent on repeat startup, no resume/dispatch). |
| HTTP boundary | `tests/integration/acceptance.test.ts` Host/Origin/CSRF/session rejection; `GET /conversations/:id` 200 for a conversation beyond the first history page and 404 for a confirmed-deleted one. |
| SSE replay | `tests/integration/coordinator.test.ts` monotonic sequence guards, snapshot fallback, future `Last-Event-ID` rejection. |
| Export privacy | `tests/integration/acceptance.test.ts` export never surfaces API keys, `sk-`-shaped markers, or injected test secret markers. The export bundle is `export_version`, `exported_at`, `conversation`, `messages` and `runs`; attachment refs carry only id, display name, sniffed MIME, kind, byte size, hash, extraction status/coverage, image dimensions, PDF pages, media duration/streams/format/normalized MIME — never raw bytes, base64, extracted text, or blob paths. |
| Active-run guards | `tests/integration/acceptance.test.ts` delete + export rejected 409 while running; succeed after terminal. |

In the earlier 398-test validation all tests passed (Poppler/ffprobe-dependent cases skip visibly, with the tool named in the test title, where a tool is missing; none were skipped in the 2026-10-21 validation run), lint and both TypeScript projects compile clean,
`npm audit --include=dev` reports 0 vulnerabilities after
`@fastify/multipart` was exact-pinned to
[v10.1.4](https://github.com/fastify/fastify-multipart/releases/tag/v10.1.4)
for upstream
[issue #594](https://github.com/fastify/fastify-multipart/issues/594)
([PR #595](https://github.com/fastify/fastify-multipart/pull/595), released in
v9.3.0 / v9.4.0 and continued in 10.1.4), `npm run build` succeeds,
and `git diff --check` is clean on the working tree.

### Earlier checkpoint evidence (183-test build, not re-run): observed by agent-run QA over a real localhost socket on 2026-10-21

**No HTTP-socket or browser QA has been run on the content-analysis build.** The observations below were produced on the earlier 183-test build and were NOT repeated after the content-analysis work.

All checks below were executed by the controlling Codex agent in this
checkout via Fastify-inject against `buildApp()` and against a running
`npm start` process on the loopback interface. None of them are user
confirmation; a human user has not been asked to attest to any specific
item below.

- Live-SSE through sequential terminal event IDs 1..5 over a real socket.
- `Last-Event-ID` strictly greater than cursor replays matching events;
  caught-up returns 204; future value returns 400.
- Explicit HTTP bad `Host` → 403, missing session → 401, missing / bad
  `Origin` → 403, bad `X-CSRF-Token` → 403.
- Server-side cancel path leaves zero assistant messages for the canceled
  run; a subsequent Quick run then succeeds (no stranded `globalActive`).
- Hydration endpoint `GET /conversations/:id` returns 200 for a stored
  conversation beyond the first history page and 404 for a confirmed
  deletion, so the UI can distinguish "still valid, just paginated out"
  from "truly deleted".
- Terminal-step normalization: Team cancel collapses review/synthesis
  steps to `canceled` (not left `running`/`queued`) when a Team run commits
  terminal; late adapter callbacks do not mutate the terminal snapshot.
  Covered by the `Team cancel normalizes review + synthesis steps`
  regression; restart-interruption shares the same settlement path and is
  covered separately.
- Production socket re-check against `npm start` on `127.0.0.1:3000` with
  normal 50ms mock latency: Team-of-3 completed in 7 calls (3 drafts + 3
  reviews + 1 selected-synth) with the expected artifacts and usage ledger;
  SSE replay, caught-up 204, future 400, bad `Host` 403, missing session
  401, bad `Origin` 403, bad `X-CSRF-Token` 403 all passed against the
  running production build.

### Not verified (deferred)

- **No automated live-provider end-to-end tests.** Provider adapters are
  contract-tested with deterministic mocked HTTP only. The "live" code path
  has never been exercised (the CI workflow is configured but has not run remotely). `PROOFESTRA_LIVE_ENABLED=0`
  during all automated validation.
- **No provider has been shown to understand native PDF/image/audio/video
  content.** The content-delivery tests intercept the request each adapter
  builds (injected transport, fake keys) and prove the bytes, MIME, framing and
  routing; they do not prove live acceptance, quality, token cost or the 20-page
  / 120 s / 12 MiB / 3,000-token-per-page defaults, which are proposed
  admission policy, not vendor limits. Nothing is transcribed.
- **Parsers were verified only on the development host's Poppler 26.04.0 and
  ffprobe 7.1.1** over synthetic fixtures. The Office/ZIP/XML handling is a
  bounded linear tokenizer, not a general XML parser; strict-OOXML namespaces
  are not read; XLSX reads stored cell values (cached formula results
  included, formulas never evaluated, dates as serial numbers). Media uploaded
  before this change has no validated metadata and is download-only (re-upload
  to preview).
- **Known limitations.** Audio with embedded cover art is refused for native
  audio (ffprobe reports the artwork as a video stream; telling them apart
  would change the user-verified ffprobe argv). Reloading the page while a file
  is processing cancels that upload. The proposed default caps are admission
  defaults, not vendor limits.
- **No external security review**; no formal penetration test.
- **No tool execution, delegation/helper spawning, MCP bridge, SDK/CLI job
  backend, or hosted-service backend.** Admission rejects any run that tries
  to turn these on. See `src/core/limits.ts` and the `tool_policy` /
  `delegation` fields in `src/shared/schema.ts`.
- **No Playwright / visible-browser E2E (and CI is configured but not yet run remotely).** The browser behaviours
  described above (reload hydration, Stop semantics) are verified only by
  agent-run server-side regressions that drive the same code paths through
  Fastify-inject or a loopback socket; this harness does not script Chrome
  itself.
- **No published release from this repository today.** The v1 implementation
  is uncommitted; a fresh clone will not have it.
- **Shared extensions, package-manager write endpoints, native plugin-format
  adapters, skill execution, MCP protocol/transport/auth compatibility, and
  real cross-provider broker isolation remain unimplemented** — these were
  design fixtures only before the v1 implementation and remain out of scope
  for it.

## Native CLI backends (2026-10-22)

Tested with fake processes only: backend-keyed dispatch, frozen admission policy,
sanitized readiness, supervised Codex job (timeout, cancel, process-tree kill,
output allowlist, usage handling) and the fail-closed ladder. **Not verified:** any
real Codex or Antigravity execution. Against codex-cli 0.163.0 the tool surface
cannot be proven off, so Codex admission is `unverified` (`tool_surface_unproven`);
Antigravity is unverified/disabled. Evidence: XLOG-016, DLOG-018; nothing here is a
live-integration claim.

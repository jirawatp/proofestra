# Design decisions

Recorded 17 October 2026. This file separates the user's decisions from proposed
engineering defaults. Requirements and design do not establish implementation.
For dated changes and source revisions, see the [decision log](logs/decisions.md).

## Confirmed direction

| Decision | Consequence |
| --- | --- |
| Personal, single-user, self-hosted web app | Start with one local instance; no account system or billing in the first version. |
| Bring your own API credentials | Keys remain on the server; provider use may be billed by the provider. |
| OpenAI, Anthropic, Gemini together in the first live version | All three adapters are release requirements, even though individual runs can use fewer providers. |
| Multiple agents may share a provider | Agent IDs are independent of provider/model; same-provider agents can share a profile or select different configured models. |
| Every agent can request subagents | All three adapters support the same harness-managed delegation; child agents can also delegate within shared limits. |
| Broad provider/tool coverage and automatic use of agent tools | Use extensible capability registries; individual provider/model/tool combinations need validation before availability is claimed. |
| All provider tool surfaces in design scope | Cover built-in API tools, local agent apps/SDKs/CLIs, functions/MCP/local executors, and supported hosted agent services; activate tested integrations in stages. |
| Shared skills, plugins and custom MCP | One harness catalog makes authorized compatible extensions eligible across connected providers; separate manual vendor installations are not the sharing mechanism. |
| Friendly chat with independent cross-review | Keep final answers readable and make drafts, findings, uncertainty, and failures inspectable. |
| Full Apache 2.0 core | UI, orchestration, adapters, verification, history/export, self-hosting, and evaluation stay open. |

## Proposed defaults for implementation

The user confirmed all tool surfaces, including API tools and SDK/CLI agent
backends. Hosted agent services are also in design scope; individual integrations
remain candidates until validated. The three core API adapters remain the first
live milestone; API tools precede validated SDK/CLI and hosted backends.

| Default | Reason |
| --- | --- |
| Separate provider, profile, backend and agent identities | Repeat providers/models freely; agent IDs address roots and synthesis. Backends declare different execution/credential boundaries. |
| Default three roots and one all-peer review round | Seven base root requests; 2n+1 applies only to this small-team plan. Larger bounded fanout/hierarchical plans must record coverage. |
| Quick tools/helpers OFF; Team tools AUTO and helpers ON | Quick has exactly one observable request/no retry only when both are OFF; opt-ins add work without root peer review. |
| Automatic capability routing within prior grants | Use ready current-profile tools; fallback creating a managed helper requires helpers enabled. Tools ON/helpers OFF creates no managed child; never silently change roots, synthesis, destinations, installs or authentication. |
| Lazy bounded top-K tool selection | Registry breadth must not load every tool into every prompt; selection is separate from permission. |
| Shared global/workspace extension catalog | Skills progressively supply versioned instructions/resources; plugin manifests bundle references; central MCP brokering supplies capabilities through model adapters or approved enabled helpers. Skills/imports never grant permission. |
| Canonical namespaces and immutable versions/digests | Collision-checked provider aliases respect wire limits and resolve to shared identities/grants. Reject silent overwrite/hot-swap; disabled/revoked/removed/superseded versions block dispatch unless the pinned old version remains explicitly enabled/authorized. |
| Trusted imports and transport-specific MCP | Local STDIO and supported negotiated HTTP use scoped broker auth/workers. No import-time execution, universal vendor-plugin importer, exclusive hosted-tool portability, or model-visible credentials is assumed. Shared registration does not share branch scratch/handles/results. |
| Reuse matching task grants | Covered reads, sandbox and reversible workspace work proceed automatically. Pause only on missing/revoked/exceeded grants or consequential actions outside them. |
| Fixed allowlists, current permission checks | Freeze route/tool/backend/profile/destination allowlists and initial grant references. Recheck validity/revocation before dispatch; exact-action approval inside those routes creates no blanket grant. Broader allowlist/provider/destination choices need a new user-configured run. |
| Inherit child profile/backend and narrowed scope | Alternates need user preapproval; tool/model output cannot expand permissions or destinations. |
| Backend-specific server credential setup; mock default | API keys, approved SDK/CLI account flows and local MCP have different requirements; no other-app session scraping or blanket approval modes. |
| Personal defaults: 32 requests, 64 observed tool operations, 4 native jobs | Separate ledgers; root/child/continuation/retry requests count when observable. Native inner model/tool counts may be unknown; one job is not one total call. |
| Personal managed-tree defaults: 6 roots, 12 total, 6 spawned, 2 children/parent, depth 2 | Configurable finite caps cover managed nodes, not opaque native inner agents; the demo's six-root editor cap does not constrain the product. |
| Concurrency 3 global/2 per provider; run 300s; request 45s; native job 120s | Controls cover observable harness work; native scope/deadline support is checked, otherwise strict policy refuses the job. |
| Output 2,048/request and 65,536 total | Bound observable scheduling/requested output; report native inner tokens/cost as unknown when unavailable. No opaque internal cap or rollback guarantee. |
| Reserve remaining root work before accepting children | A spawn needs room for child work and parent continuation. Waiting parents release slots so children can progress. |
| React/Vite + TypeScript, Fastify/Node, SQLite | One local application process with simple persistence and explicit run control. |
| Stage events over SSE | Reload/reconnect can recover progress without duplicating model calls. |
| One global active run | Simpler personal cost and concurrency control. |
| Entire visible history or explicit context rejection | Every agent sees the same frozen history; no hidden trimming. |
| Local history until deliberate deletion | No hidden retention service or automatic data upload; backups/exports remain the user's responsibility. |
| Search, code, files, functions/MCP and native tools inside explicit grants | Retrieval status is separate from claim support; retrieved sources are not automatically verified evidence. |

Detailed limits and failure semantics are in [requirements](requirements.md) and
[agent policy](agents.md). The scheduler deduplicates spawn callbacks; denial is a
notice without a child or additional provider call; the requesting call still
counts, as does any subsequent parent continuation. An accepted child's failure
makes the run partial. Stop prevents new harness work and attempts whole-tree/job
cancellation; native inner work may remain unconfirmed and completed actions are
not rolled back. Restart interrupts active work without automatic resume.

Native capabilities do not have identical semantics. In particular, documented
[Gemini CLI subagents](https://geminicli.com/docs/core/subagents/) cannot spawn
other subagents. Use approved harness-managed nesting or report unsupported.
Additional provider plugins and OpenAI-compatible adapters remain candidates until
contract tests pass. See [tool policy](tools.md), [scaling](scaling.md), and
[provider capabilities](provider-capabilities.md). Choices remain provisional.
The [extension policy](extensions.md) defines the shared catalog and lifecycle;
it does not assert that any plugin, skill script or custom MCP connection is installed.

## Attachment content analysis (see DLOG-014)

**Specified by the user (2026-10-21 requests, 2:52 PM scope and 2:59 PM
corrections, UTC+7):** bounded real content analysis using the installed
Poppler (fixed path, no shell, UUID blob path only), Office/ODF/ZIP text with no
DTD/entity/external reference/macro/formula execution, `ffprobe` over the
read-only blob descriptor with the verified argv ending `-fd 0 -i fd:`,
kill-then-await-close for subprocesses, a terminable worker with resource
limits and awaited termination, persisted validated metadata, QuickTime to
`video/mov` only when validated, Gemini-only native audio/video for known
codecs with finite caps, untrusted-data framing for uploaded content, history
delivered to every stage, and no transcription, model or service install.

**Engineering choices (implemented; not separately confirmed by the user):**

| Choice | Rationale |
| --- | --- |
| `node:zlib` raw inflate (`inflateRawSync` with `maxOutputLength`) plus `crc32`; `fflate` removed | Node 22.19 already provides both; ZIP entries are raw deflate; smaller audit surface. |
| Migration 5 adds `validated_media_format` and `normalized_media_mime`; applied migrations are never edited | A database outside the inspected files may already have migration 4. |
| Original `sniffed_mime`, validated container `format_name`, and wire-normalized MIME are three distinct values | Native routing may use the normalized MIME only after a successful probe. |
| Keep `audio/mpeg` on the Gemini wire | Gemini's public documentation lists it. |
| One `nativeAttachmentTokenReserve` used by admission and dispatch; `nativeNonImageTokenReserve` deleted; extracted-text and attachment-only notes are priced on the exact framed string | They cannot drift apart. |
| One exported notice, emitted before extracted text and before every native part by all four adapters | Uploaded content is data, not instructions. |
| The source runtime bootstraps tsx inside the worker | `--import tsx` in worker `execArgv` does not apply the `.js`→`.ts` resolver in a worker (checked on Node 22.19). |
| XLSX reads stored cell values (cached formula results included, dates as serial numbers); formulas are never evaluated | "Full text" must not hide numbers; no formula engine. |
| Fail closed on ambiguity: `pdfinfo` output needs exactly one `Pages:` and one `Encrypted:` line; more than 8 probed streams or an unnamed audio/video codec make media unvalidated; every video stream must be bounded | A document or file must not choose its own validated metadata. |

**Proposed defaults (implemented, labeled tunable, never presented as vendor limits):**

| Default | Value |
| --- | --- |
| Native PDF | at most 20 pages, 3,000 tokens per page + 1,024 framing tokens |
| Media | at most 120 s per attachment and 120 s total per call; 12 MiB total raw media bytes per call; 64 tokens/s audio, 512 tokens/s video, + 1,024 framing |
| Native token budget per agent | cumulative native reserve at most 50% of the profile's safe input; otherwise extracted text (PDF) or attachment-only |
| Timed-out `pdftotext` with safe non-empty text | returned as partial (`truncated`, labeled `timed out after 5 s`); `pdfinfo` timeout or no safe text is a failure |
| Audio with embedded cover art | refused for native audio (ffprobe reports the artwork as a video stream; a distinguishing field would change the user-verified argv) |

## Remaining implementation decisions

- Choose explicit currently available model profiles and confirm safe input/output
  capacities, tool/delegation capabilities, backend mappings and SDK versions.
- Validate each API/SDK/CLI/MCP/hosted connector's compatibility, approved
  credentials, execution grants, internal usage visibility and stop behavior.
- Pin compatible runtime/dependency versions and choose a SQLite driver/migration
  implementation. No packages are installed by these design documents.
- Validate proposed limits, same-provider controls, parent/child visibility,
  lazy catalogs, automatic routing, grant boundaries and native jobs through mocks.
- Validate extension namespaces/global-workspace scopes, manifest references and
  digests, progressive loading, broker adapters, branch state, updates and exports.
- Add a versioned price table only if useful; show unknown cost honestly until then.
- Review provider data handling for the actual API products/accounts selected.
- Content analysis: keep or retune the proposed caps after measured live-provider testing,
  decide whether timed-out partial PDF text and cover-art audio stay as implemented, and
  whether the audio/video native path needs a stream-disposition probe (DLOG-014).

No model credentials or paid evaluation are needed to review the design. The next
build milestone is the mock-backed chat, persistent local history, and run state
machine. Live adapters follow once those behaviors are checked. See [roadmap](roadmap.md).

## Development workflow (2026-10-21)

The user confirmed DEV-01 model roles and DEV-02 >=90% coverage; see
[development policy](development-policy.md) and DLOG-015. The coordinated picker check lists all requested families, but Fable planning
is blocked by administrator policy; Sonet maps to the UI label Sonnet 5.5 High. The coverage provider, complete source
denominator, four 90% thresholds and CI gate implement the policy; achieved
percentages are a separate measured release gate, never inferred from test counts.


## Planner replacement (2026-10-21)

The user replaced Fable with GPT Sol for planner/designer (DLOG-016). Opus 5.5
reviewer/advisor and Sonnet 5.5 worker remain. Do not retry Fable. Exact GPT Sol
picker label/version/ID and execution permission are pending coordinated native
verification; no new role run is claimed. DEV-02 coverage thresholds stay intact.

## Native subscription-backed backends (2026-10-22)

Codex through the existing vendor-managed ChatGPT login is implemented as a
distinct `native_cli` backend that fails closed (DLOG-018). Dispatch is keyed by
the frozen backend ID and never falls back to a provider API. Execution is
**blocked/unverified** for the installed codex-cli 0.163.0 because the tool
surface cannot be proven off by any invocation-only control (unified_exec cannot
be disabled; apply_patch and the code-mode tool mode are model-catalog
properties; web-search and MCP effects are unobservable without inference).
Antigravity stays unverified/disabled. Neither path uses a token bridge, auth-file
read, new login/grant/persistent setting, paid fallback or purchase. After the
operator's final verification the user authorizes commit, push and a pull request
(no merge, no public deployment); see DEV-03.

# Design decisions

Recorded 17 October 2026. This file separates the user's decisions from proposed
engineering defaults. Requirements and design do not establish implementation.

## Confirmed direction

| Decision | Consequence |
| --- | --- |
| Personal, single-user, self-hosted web app | Start with one local instance; no account system or billing in the first version. |
| Bring your own API credentials | Keys remain on the server; provider use may be billed by the provider. |
| OpenAI, Anthropic, Gemini together in the first live version | All three adapters are release requirements, even though individual runs can use fewer providers. |
| Multiple agents may share a provider | Agent IDs are independent of provider/model; same-provider agents can share a profile or select different configured models. |
| Every agent can request subagents | All three adapters support the same harness-managed delegation; child agents can also delegate within shared limits. |
| Friendly chat with independent cross-review | Keep final answers readable and make drafts, findings, uncertainty, and failures inspectable. |
| Full Apache 2.0 core | UI, orchestration, adapters, verification, history/export, self-hosting, and evaluation stay open. |

## Proposed defaults for implementation

| Default | Reason |
| --- | --- |
| Text-only; Quick has one root, Team has 2–6 roots | Repeat providers/models freely; require unique agent IDs and choose synthesis by agent ID. |
| Default roots: one per provider; one review round | Three independent drafts, three reviews, one synthesis: seven base invocations. With helpers, 2n+1 is not the total call count. |
| Quick helpers OFF; Team helpers ON | Plain Quick remains one invocation; opt-in “Quick + helpers” adds bounded work without root peer review. |
| Inherit parent model profile for children | Alternate child profiles require the user's preapproval in the run; provider output cannot expand permissions or destinations. |
| Server environment keys and model-profile catalog; mock by default | Multiple configured profiles per provider; no browser key editor, model discovery calls, or incidental live calls. |
| Shared invocation cap 32; global/provider concurrency 3/2 | Counts all roots, descendants, continuations, and retries; plain Quick is one call without retries. |
| At most 12 total agents, 6 spawned, 2 children per parent, depth 2 | Bounds are global/lifetime where applicable; roots start at depth 0. All limits are provisional. |
| Deadline 300s; per-call 45s; output 2,048/call and 65,536 total | One shared budget and deadline; no child resets them or gains extra voting weight. |
| Reserve remaining root work before accepting children | A spawn needs room for child work and parent continuation. Waiting parents release slots so children can progress. |
| React/Vite + TypeScript, Fastify/Node, SQLite | One local application process with simple persistence and explicit run control. |
| Stage events over SSE | Reload/reconnect can recover progress without duplicating model calls. |
| One global active run | Simpler personal cost and concurrency control. |
| Entire visible history or explicit context rejection | Every agent sees the same frozen history; no hidden trimming. |
| Local history until deliberate deletion | No hidden retention service or automatic data upload; backups/exports remain the user's responsibility. |
| No retrieval, uploads, external tools, or external actions | Sources remain unverified; internal bounded delegation grants no other tool permissions. |

Detailed limits and failure semantics are in [requirements](requirements.md) and
[agent policy](agents.md). The scheduler deduplicates spawn callbacks; denial is a
notice without a child or additional provider call; the requesting call still
counts and may be billed. An accepted child's failure makes the run
partial. Stop cancels the entire tree; restart interrupts active descendants with
no automatic resume. Engineering choices are provisional until measured.

## Remaining implementation decisions

- Choose explicit currently available model profiles and confirm safe input/output
  capacities, structured delegation-request mappings, and SDK versions for all adapters.
- Pin compatible runtime/dependency versions and choose a SQLite driver/migration
  implementation. No packages are installed by these design documents.
- Validate proposed limits, same-provider controls, parent/child visibility,
  scheduling, and narrow-screen layout through the mock slice before live requests.
- Add a versioned price table only if useful; show unknown cost honestly until then.
- Review provider data handling for the actual API products/accounts selected.

No model credentials or paid evaluation are needed to review the design. The next
build milestone is the mock-backed chat, persistent local history, and run state
machine. Live adapters follow once those behaviors are checked. See [roadmap](roadmap.md).

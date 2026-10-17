# Design decisions

Recorded 17 October 2026. This file separates the user's decisions from proposed
engineering defaults. Requirements and design do not establish implementation.

## Confirmed direction

| Decision | Consequence |
| --- | --- |
| Personal, single-user, self-hosted web app | Start with one local instance; no account system or billing in the first version. |
| Bring your own API credentials | Keys remain on the server; provider use may be billed by the provider. |
| OpenAI, Anthropic, Gemini together in the first live version | All three adapters are release requirements, even though individual runs can use fewer providers. |
| Friendly chat with independent cross-review | Keep final answers readable and make drafts, findings, uncertainty, and failures inspectable. |
| Full Apache 2.0 core | UI, orchestration, adapters, verification, history/export, self-hosting, and evaluation stay open. |

## Proposed defaults for implementation

| Default | Reason |
| --- | --- |
| Text-only; Quick or Team with two/three providers | A bounded first version that still demonstrates cross-provider review. |
| Three independent drafts, three reviews, one synthesis | Gives each selected model a first answer before peer influence; seven planned calls. |
| One configured model per provider, one review round | Avoid complex routing and uncontrolled rounds before measuring usefulness. |
| Server environment keys/model IDs; mock mode by default | No browser credential editor and no incidental live calls. |
| React/Vite + TypeScript, Fastify/Node, SQLite | One local application process with simple persistence and explicit run control. |
| Stage events over SSE | Reload/reconnect can recover progress without duplicating model calls. |
| One global active run | Simpler personal cost and concurrency control. |
| Entire visible history or explicit context rejection | Every agent sees the same frozen history; no hidden trimming. |
| Local history until deliberate deletion | No hidden retention service or automatic data upload; backups/exports remain the user's responsibility. |
| No retrieval, uploads, tools, or external actions | Sources remain unverified; review is a model opinion, not an evidence-checking service. |

Detailed limits and failure semantics are in [requirements](requirements.md) and
[technical design](technical-design.md). They are provisional until measured.

## Remaining implementation decisions

- Choose explicit currently available model IDs and confirm safe input/output
  capacities, capability mappings, and SDK versions for all three adapters.
- Pin compatible runtime/dependency versions and choose a SQLite driver/migration
  implementation. No packages are installed by these design documents.
- Validate proposed limits, stage wording, team controls, and narrow-screen layout
  through the mock slice before making live requests.
- Add a versioned price table only if useful; show unknown cost honestly until then.
- Review provider data handling for the actual API products/accounts selected.

No model credentials or paid evaluation are needed to review the design. The next
build milestone is the mock-backed chat, persistent local history, and run state
machine. Live adapters follow once those behaviors are checked. See [roadmap](roadmap.md).

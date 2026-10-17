# Extensibility and capacity

Status: proposed architecture, not a throughput benchmark or an unlimited-use claim.
The target is broad provider/tool coverage with explicit deployment limits.

## More providers and tools

Use registry IDs and versioned adapters rather than a closed provider enum or one
hardcoded tool list. Keep adapters for provider APIs, SDK/CLI workers, MCP/local
tools, and hosted services separate. Capability matching is model/backend-specific.
Initial OpenAI, Anthropic, and Gemini targets do not establish compatibility for
other providers or OpenAI-compatible gateways.

New adapters declare configuration/authentication references, schemas, supported
capabilities, normalization, permission hooks, accounting visibility, cancellation,
and versioned compatibility evidence. Install/enable only trusted configured
adapters. Automatic routing does not authorize automatic installation or sign-in.
Unsupported combinations fail visibly rather than silently losing tool arguments.

Page and filter registry and execution records. Select tool definitions lazily so
catalog growth does not force every definition into every model context. Cache
metadata with a version/refresh policy; a cached document is not proof of current
account access or live model availability. Refreshing remote catalogs follows
the configured destination policy and is not a billable inference at startup.

## Defaults are not product ceilings

The earlier six-root, twelve-node, six-helper, depth-two, 32-request, and concurrency
3/2 values are the personal deployment defaults. Server configuration may choose
different finite ceilings for available memory, storage, provider quotas, latency,
and budget. Run requests cannot raise or bypass the deployment policy.

Advertise policy version, defaults, and effective ceilings through runtime metadata.
Validate root count, total managed nodes, helper fan-out/depth, queues, context,
output allowance, requests, tools, jobs, and deadlines before accepting work. No
unlimited setting is implied. The prototype's six-entry editor is a demo constraint.

Native runtimes may hide internal calls or child trees. Counts of managed nodes
and visible requests cover what the harness controls; native reservations and
backend-specific caps cover compatible jobs. Show unobservable internals explicitly.
Do not present a managed-node ceiling as an enforced ceiling on an opaque vendor's
internal agents. Strict policies exclude incompatible opaque routes.

## Scheduling larger teams

Keep one personal active run initially. Use bounded queues, fair scheduling across
root branches, per-provider/account limits shared by model profiles, backpressure,
and atomic reservations. Waiting parents/tools/approvals release execution slots.
Supervised worker processes let SDK/CLI jobs run outside the HTTP handler; adding
a worker does not multiply the run's permission or resource budget.

Persist resumable UI state and progress without automatically replaying inference
or external effects after restart. Use paginated tree/tool views and bounded event
payloads instead of rendering or streaming every record repeatedly. Exports may
stream a terminal run's records without loading the entire artifact set into memory.

SQLite and one API/coordinator are still the personal starting point. A larger
multi-process or distributed deployment requires a separate queue/locking/storage
design and measured tests. Do not claim cluster-scale support from this document.

## Review and synthesis growth

For a small all-peer team, the base workflow is n drafts, n review invocations, and
one synthesis: 2n+1 visible requests before tools/helpers/retries. Sending every
draft to every reviewer grows context substantially even if that request count
is linear. One final synthesis may also exceed a model's context limit.

Design extension points for bounded peer assignment and hierarchical synthesis.
Record which agent reviewed which claims/peers, intermediate synthesis provenance,
missing coverage, and every added invocation. Keep the selected final synthesizer
unless the user changes that choice. These topologies need separate acceptance
fixtures; they are not implemented by the current demo.

Until a scalable topology is implemented and fits configured context limits,
reject an oversized all-peer request explicitly. Never silently drop agents,
truncate findings, advertise complete cross-review, or reuse 2n+1 for a workflow
with additional synthesis/tool stages.

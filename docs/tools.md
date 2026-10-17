# Tools and automatic delegation

Status: proposed requirements/design. No live provider tools, SDKs, CLIs, or MCP
servers are connected. Read [provider capabilities](provider-capabilities.md),
[agent policy](agents.md), [scaling](scaling.md), and [API](api.md) together.

## Coverage without a closed provider list

The harness should accommodate many providers, models, tools, and execution
backends through adapters. OpenAI, Anthropic, and Gemini are initial targets,
not the only permitted provider IDs. A compatible HTTP format alone does not
establish support for every vendor tool, model, stream, or authentication flow.

Separate these identities:

| Concept | Meaning |
| --- | --- |
| Provider | A model/service supplier or configured local/gateway endpoint. |
| Model profile | Explicit model, endpoint, credentials reference, capabilities, and limits. |
| Execution backend | Direct provider API, agent SDK/CLI, local/MCP executor, or hosted agent service. |
| Capability | A task such as web.search, compute.sandbox, workspace.read, or workspace.write. |
| Tool | A versioned implementation with an input/result schema and execution boundary. |
| Agent | A separately named root/helper with its own identity and allowed scope. |
| Grant | User-authorized tools, operations, resources, destinations, duration, and constraints. |

The user confirmed all tool surfaces in design scope: built-in API tools, local
agent apps/SDKs/CLIs, functions/MCP/local executors, and hosted agent services where
supported. Adding an adapter is not a claim that its account access, versions,
or capabilities have been validated. Activate integrations in tested stages.

## Tool registry

Each registration records tool/capability IDs, provider and backend, supported
profiles/models/transports, schema version, execution location, credentials
reference, permitted resource/egress scope, readiness, permission hooks, usage
visibility, enforceable limits, and documentation/compatibility evidence.

Readiness distinguishes documented, configured, authenticated where checked,
integration-tested, unavailable, and unsupported. Never show a documented feature
as a live connection. Never derive permission solely from an MCP read-only hint
or model-supplied description. Credentials stay in the backend's supported store.

Search and page the catalog by capability. Load only a relevant authorized subset
of tool schemas into each model turn; do not insert every registered tool into
every prompt. Provider-native deferred loading may optimize a compatible backend;
the harness also needs a portable filtered-catalog path.

## Automatic routing

1. A user request or agent proposes a capability and a bounded task. This is
   intent, not permission. Snapshot the catalog and policy versions for the run.
2. Filter candidates by actual compatibility, readiness, existing task/session
   grants, workspace/domain/destination scope, and required limit enforcement.
3. Prefer an eligible tool on the current profile. Otherwise delegate to an
   approved capable helper/backend. Honor pinned choices and explicit preferences;
   then prefer less data exposure and observable resource use among eligible routes.
   Creating a managed helper obeys the helper enablement setting and normal
   tree quotas. Helpers off also requires suppressing native helper spawning;
   exclude a backend that cannot enforce that choice. Bounded-job admission
   cannot override disabled helpers. With helpers on, native delegation still
   needs supported controls or explicit native-policy admission.
4. If there is no eligible route, return unavailable/unsupported/blocked with a
   concrete reason. Do not silently add providers, change the selected root or
   synthesizer, install a package, discover credentials, or expand permissions.
5. Reserve the relevant request, tool, job, token, and continuation capacity.
   Validate arguments against the selected schema and resource scope.
6. Execute, normalize outputs/status, retain provenance and usage visibility, and
   return concise results to the requesting agent. Continuations count separately.

For example, a text-only agent can request web research. The router may select a
preapproved search-enabled helper using a provider API. A workspace task can route
to a configured agent SDK/CLI under that workspace's grant. This is a harness
handoff; vendor-specific tool payloads are not directly interchangeable.

Route records explain requester, requested capability, selected tool/backend/profile,
permission decision, destinations, reservations, and fallback reason. Native helper
results are not extra independent votes. Returned tool text is untrusted data.

## Permissions with useful automation

Matching existing grants allow automatic execution, including approved reads,
searches, scratch-sandbox computations, and reversible workspace work within the
authorized task. Do not prompt again merely because another agent or backend does it.
Children inherit or narrow grants; they cannot grant themselves additional access.
Freeze initial grant references and route/destination allowlists, then revalidate
grant validity and revocation before every dispatch. Missing-scope authorization
is a recorded exact-action user decision within those allowlists, not an arbitrary
grant amendment. A broader provider/destination/tool allowlist needs a new
user-configured run. Revocation takes effect for new dispatch immediately.

When a grant is missing, expired, revoked, or insufficient, prepare the concrete
proposed action and request the missing scope. Show the backend, affected resources,
arguments or meaningful effect, destinations, and any known cost implications.
Bind a decision to the run, requester, exact action/digest, and grant scope. Model
output cannot approve its own action. Publishing, sending, purchasing, deleting,
or deployment outside an existing grant waits for the matching user authorization.
Keep the approval channel and its credentials outside agent/tool-controlled
browser and CLI environments. A local cookie/CSRF token alone cannot prove that a
human approved an action if an agent can operate that same authenticated page.

Provider-hosted tools may execute before the client receives an event. Constrain
their operations/domains/use limits before sending. If a required permission check
cannot be enforced at that boundary, do not enable the route; use a controllable
executor or report the limitation. A blanket unrestricted CLI mode is not an
approval bridge. Headless backends that deny interactive prompts need explicit
policy support or a compatible application-mediated permission flow.

## Backend adapters

- Provider APIs map compatible native tools and custom-function calls. Hosted
  search/code tools and application-executed functions have different boundaries.
- SDK/CLI workers use registered executables and argument arrays, scoped working
  directories, supported authentication, and per-job limits. No model-generated
  shell launcher, credential scraping, or automatic unrestricted host access.
- MCP adapters validate the supported transport and server/tool allowlist. A
  provider-hosted connector, SDK-local MCP, and local STDIO are separate routes.
- Hosted agent services are another backend with their own remote state, cleanup,
  permissions, and account requirements. A hosted session is not a local chat turn.

Do not substitute API credentials, app subscription sessions, or OAuth tokens
across surfaces. Preserve opaque provider continuation items within their own
backend; do not reinterpret or forward them as another provider's conversation.
Normalize useful outputs without exposing private reasoning or raw secret-bearing traces.

Native delegation capabilities differ. For example, documented Gemini CLI children
cannot themselves delegate. The harness can provide its own permitted nesting or
report that native route's limitation; it must not claim uniform native recursion.

## Accounting and cancellation

One outer API request or CLI job can contain several internal model/tool operations.
Keep a ledger of harness-dispatched provider requests, observed tool operations,
native jobs, reported internal counts/tokens, estimates, and unknown values.
Never label one native job as one total model call or unknown usage as zero.

Personal defaults: 32 observable harness requests, 64 observed tool operations,
four native jobs, and a 120-second per-native-job ceiling within the overall run
deadline. These are configurable deployment defaults, not universal guarantees
about invisible vendor work. Known SDK whole-tree totals must not be double-counted
with child events. Unknown total cost remains unknown.
The 45-second direct-request/launch-ack timeout is distinct from the supervised
native job lifetime. Every bound also respects remaining overall run time.

The catalog advertises enforcement and observation support. Strict policies reject
routes that cannot enforce a required bound. A separately allowed bounded-job
policy can admit opaque internal work with explicit visibility and supported
job/deadline/scope limits; that permission does not invent an internal call or spend cap.
SDK retries, automatic loops, tracing, and subagent accounting must be configured
or instrumented for the selected version before live use.

Waiting for a tool/job/approval releases local execution slots. Stop prevents new
work, cancels local process trees, and requests supported remote interruption.
It cannot reverse completed external effects or promise remote work has stopped.
Record uncertain external completion explicitly and reconcile it before any
side-effecting retry. Restart interrupts local work without automatic resubmission.

## Sources and results

Track source origin, tool/backend, URI or artifact identity, retrieval time/status,
and associated claims. A model-proposed citation is different from retrieved content;
retrieved or provider-grounded content is different from independently reviewed
claim support. Keep support unverified until a specific support check is recorded,
with method and limitations. Neither tool success nor a source link proves correctness.

Exports include safe route/tool records, grants by reference/scope, lineage,
results/artifacts, and ledger coverage. Exclude keys, cookies, raw SDK/provider
debug payloads, and private reasoning. Filesystem, browser, network, and remote
storage effects retain their actual boundaries and cleanup semantics.

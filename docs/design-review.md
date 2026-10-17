# Design review record

Reviewed 17 October 2026. This records checks on a design package and simulated
interface, not production acceptance or a measured accuracy improvement.

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

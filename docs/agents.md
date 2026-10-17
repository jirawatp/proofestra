# Agents and subagents

Status: required design for the first live version, not an implemented runtime.
See [requirements](requirements.md), [technical design](technical-design.md), and
[API](api.md).

## Identity and configuration

A provider is an integration: OpenAI, Anthropic, or Gemini. A model profile is a
server-configured model choice and its capabilities. An agent is a named member
with its own ID, role, task, and execution state. Provider/model is not identity.

Users can add multiple agents with the same provider, the same profile, or different
profiles from one provider. They remain separately addressable. Select the
synthesizer by agent ID, not provider name. Example profile aliases are illustrative:

| Agent | Provider | Profile | Role |
| --- | --- | --- | --- |
| Writer | OpenAI | openai-general | Develop an initial answer |
| Critic | OpenAI | openai-review | Challenge unsupported claims |
| Alternative | Anthropic | anthropic-general | Develop another approach |

Writer and Critic can also use the same profile. The browser selects server catalog
entries, never keys or arbitrary model IDs. All three adapters need a compatible
delegating profile for the first live release; exact model compatibility is unverified.

## Agent tree

User-configured participants are roots. Every eligible root or child may request
subagents for bounded text tasks. Proofestra manages them on behalf of each
provider's agents; no provider-native autonomous-agent service is assumed.

```mermaid
flowchart TD
    W[Writer / OpenAI] --> S[Assumption check / OpenAI]
    W --> C[Counterexample / OpenAI]
    C --> N[Edge case / OpenAI]
    R[Critic / OpenAI]
    A[Alternative / Anthropic]
```

Each runtime node has a run-scoped unique agent ID, parent ID or null, root ID,
depth, model profile, concise task, and status. Roots have depth zero. The server
derives ancestry from the caller; models cannot reparent, create cycles, or
impersonate roots. Children inherit the parent's profile by default. Other profiles,
including another provider, require the user's run-level allowlist. Before Live
submission, disclose every possible root/helper provider destination.

## Spawn and return

1. An adapter emits an internal spawn_subagent request with tool-call ID, concise
   task, optional name, and optional allowed profile. This grants no permission
   to execute code or call browser-authenticated endpoints.
2. Validate active caller/run, allowlist, depth, node/child quotas, context fit,
   deadline, and shared call/output allowance.
3. Atomically assign ancestry, reserve capacity, persist the accepted request/event,
   and enqueue. Deduplicate by run + parent agent + parent step + immutable parent
   invocation ID + provider tool-call ID. A provider-local tool ID may repeat in a
   later invocation; that is a different request, still subject to lifetime quotas.
   Matching payloads recover the original decision; changed payloads under that
   key are rejected without creating another child.
4. Mark the parent step waiting_for_children and release global and provider
   execution slots. A waiting parent cannot hold the slot its child needs.
5. Run scoped child tasks and return concise outputs/status as inert tool-result data.
6. After the accepted batch is terminal, resume the parent under its reserved
   continuation capacity. This is another counted model invocation. Group returned
   tool requests by parent invocation ID; child results from that response share
   one continuation. Duplicate callbacks cannot resume that batch twice.

Only the user adds roots. Model output cannot change policy, credentials, tools,
or allowed profiles. There is no public model-controlled spawn endpoint.

## Independence and context

Roots share the same frozen visible conversation. Children inherit it plus their
task and permitted own-branch artifacts. While drafting, no branch sees another
root's current drafts or children. Peer-review access starts only after the root
draft barrier. A root draft waits for its descendants and parent continuation.
Descendants can narrow their parent's permissions but cannot broaden them.

Reviewers and the synthesizer may also delegate. Child results return to parents;
they are not additional root reviewers, independent votes, or evidence of truth.
Same-provider/model agents can share errors despite separate prompts.

Check actual child tasks/results against configured safe model capacity before
spawn/continuation. Never silently trim history or omit results to fit. Deny an
unsafe spawn; preserve partial material if accepted work later cannot finish.
Tasks/results are inspectable outputs, not private chain-of-thought.

## Shared provisional limits

| Limit | Default |
| --- | --- |
| Root agents | Quick: one; Team: two to six |
| Total accepted agents / spawned agents | Twelve including roots / six children per run |
| Direct children per agent / maximum depth | Two over its lifetime / two, roots at zero |
| Total model invocations | Thirty-two, including all descendants, parent continuations, and retries |
| Global / per-provider concurrency | Three / two, shared across every profile of a provider |
| Overall / per-call deadline | 300 / 45 seconds |
| Per-call / aggregate output allowance | 2,048 / 65,536 tokens |

Quick defaults to helpers off, one invocation, no retries. Explicit helpers use
the shared budget and the label Quick + helpers; there is still no root peer review.
Team enables delegation by default, but agents need not spawn. Users can disable it.

Team's base plan is 2n+1 root invocations: seven for three roots. Two child calls
plus one parent continuation make that example ten, not seven. Show base plan,
reservations, actual dispatched calls, and maximum separately; no fixed cost is implied.

Before accepting children, preserve remaining nominal root-stage capacity and a
parent continuation. Reserve calls/output atomically; unknown usage keeps conservative
output reservations. Accepted nodes count toward lifetime quotas even after they
finish, fail, or are canceled. No unlimited replacement children.

Denied spawning creates no child or additional child call. The requesting invocation
still counts and may be billed; any later parent continuation also counts. Return
a typed reason: disabled, profile_not_allowed, depth_limit, agent_limit, child_limit,
call_budget, output_budget, deadline, context_too_large, or invalid_request. Preserve
denials in the run record. Parents must be able to finish without unavailable helpers.

## Failure, cancellation, and storage

An accepted child failure makes the run partial even if its parent recovers. A
denial alone does not fail the run; retain its notice/limitation. Keep existing
root failure rules and never silently replace the selected synthesizer agent.

Stop cancels every active node and prevents new children/continuations. Unrecoverable
parent termination cancels descendants. Late callbacks cannot alter canceled state;
sent provider work may still be billed. Restart interrupts active/waiting nodes
without automatic resumption. Spawn deduplication survives restart.

Export includes ancestry, concise tasks/results, profiles, accepted/denied delegation,
stage outcomes, and aggregate usage. Terminal-run deletion cascades through the
tree. Exclude keys, raw provider payloads, and private reasoning.

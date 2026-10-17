# Experience design

This proposes a personal, single-user, self-hosted Proofestra web app. OpenAI,
Anthropic, and Gemini are initial provider targets; each can host several
configured agents using different or identical model profiles. The adjacent
[interactive design](prototype/index.html) is a standalone deterministic
simulation. It implements no live provider connection, credential storage,
persistent chat history, or evidence verification.

## Visual plan and review

The organizing idea is several voices joining a conversation. A three-stroke mark
reflects the default three-agent team; a readable central answer and a quiet team
margin keep the experience familiar. The agent hierarchy becomes visible when
there is actual delegation, rather than turning every conversation into a graph.

| Token | Value | Purpose |
| --- | --- | --- |
| Paper | `#ffffff` | Reading and writing surface |
| Ice | `#f1f6fc` | Conversation margin and user messages |
| Ink | `#172c45` | Primary text and structure |
| Cobalt | `#2458d3` | Send, selection, and current activity |
| Teal | `#086b61` | Stage completion, without implying correctness |
| Warm yellow | `#fff3c5` | Unverified information and incomplete-work notices |

A local humanist sans stack uses Avenir Next, Avenir, Segoe UI, sans-serif. Reading
text is 14–15 px, answer headings 25 px, and the empty-state title 34–44 px. Content
is left aligned; paragraphs stay below roughly 72 characters where space allows.

```text
Chosen: a conversation with its agents in a margin
┌───────────┬───────────────────────────────┬────────────────┐
│ History   │ Quick / Team                  │ Agent preset   │
│           │ User question                 │ Root agents    │
│           │ Draft → Review → Answer       │ Add agent      │
│           │ Main answer                   │ Synthesizer    │
│           │ Expandable drafts / hierarchy │ Helper policy  │
│           │ Message composer              │ Shared limits  │
└───────────┴───────────────────────────────┴────────────────┘

Rejected: a dashboard giving every agent equal visual weight
┌───────────┬──────────┬──────────┬──────────┐
│ History   │ Agent A  │ Agent B  │ Agent C  │
│           ├──────────┴──────────┴──────────┤
│           │ Final answer                 │
└───────────┴───────────────────────────────┘
```

The first plan used rounded agent cards and a floating answer panel. Reviewing
that against the brief exposed a generic dashboard. The final direction uses
plain configuration rows, a continuous answer surface, and one bounded activity
strip. There are no decorative metrics, gradients, accuracy scores, external
assets, or oversized marketing hero. A scrollable desktop team rail accommodates
more agents without displacing the reading surface.

## Navigation and examples

The desktop layout has a history sidebar, conversation, and agent rail. The
prototype has one current conversation and saves nothing between visits. The live
version should support local history, deliberate deletion, and portable export.
New chat clears current content while retaining the selected mode and ephemeral
agent configuration.

Three example prompts cover a database choice for a personal app, agreement
between models, and self-hosting privacy. Selecting one fills the composer.
Sending runs the chosen preset example. Arbitrary text can label that simulated
message, but the page explicitly says the answer uses the selected sample; it does
not pretend to answer arbitrary text.

## Agent identity and configuration

An agent is a configured participant with its own stable ID, name, provider, and
model profile. It is not synonymous with a provider. The demo editor has capacity
for six roots, with at least two required for Team. Deployment limits are
configurable; six is not a universal product ceiling. The registry-based design
can support more providers, profiles, and tools as adapters become available.
Several agents may use OpenAI, Anthropic, or Gemini, including the same
profile. Duplicate names and profiles do not merge identities. The synthesizer
selector includes agent names and IDs so same-provider siblings remain distinct.

The default preset has OpenAI Writer, Anthropic Reviewer, and Gemini Challenger.
The same-provider preset has OpenAI Writer using Demo balanced, OpenAI Critic
using Demo analytical, and Anthropic Reviewer. These names are readable labels;
every Team root still performs initial drafting and one peer review. The Add
agent form accepts a name, provider, and Demo balanced / Demo analytical / Demo
concise profile. Existing entries can be enabled, disabled, or removed. It allows
duplicate providers and profiles and caps configured roots at six.

Demo profile names are illustrative choices, not claims about available vendor
models. Live profiles must bind explicit provider model IDs and capabilities.
Every design request is simulated; there are no fake live indicators, balances,
credential fields, or assertions that connections were checked.

## Modes, roots, and helpers

**Quick** selects one root agent. By default it makes one draft call and allows no
helpers or tools, with an effective one-request cap. It has no peer-review or
separate synthesis stage. Helpers and configured tools can each be opted into.
Enabling helpers
changes the visible label to **Quick + helpers**. Permission does not force a
helper call: the ordinary example still uses one call.

**Team** drafts from each enabled root before any root sees peer drafts. Each
successful root then reviews the other available root drafts once, followed by
one synthesis by the selected agent. For `n` roots the base plan is `2n + 1`
calls: seven for three roots, five for two, thirteen for six. Separate drafting
does not establish statistical independence; models and same-provider siblings
can share errors.

Team permits subagents by default. Quick requires an explicit opt-in. Helpers
assist their parent; they do not become additional independent reviewers or
votes. Any configured root may request bounded children; an allowed child may
request another level within the same policy. The user chooses maximum depth one
or two. Proposed bounds are two children per agent, six helpers in the whole run,
and twelve total agents including roots. The demo illustrates two direct children
at depth one; it does not implement arbitrary recursive provider execution.

Delegation is an application-coordinator capability. The design makes no claim
that the provider natively spawns agents. A model-style request must pass the
application's permission, target-profile, depth, fan-out, and remaining-budget
checks before any child is created. Child tasks get only their task and permitted
context, not unrelated root drafts before the draft barrier. Child findings are
untrusted outputs, not external evidence.

The **Subagents: bounded delegation** scenario shows the first root asking two
same-provider helpers to examine assumptions and counterexamples. The parent
waits, both children return results, and one separately counted parent
continuation incorporates those results before the root draft barrier completes.
The waiting parent releases its execution slot; otherwise a full set of waiting
parents could prevent their children from ever starting. One parent invocation's
batch of children produces one continuation, not one per child.

| Scenario | Dispatched calls |
| --- | --- |
| Default Team, three roots | 3 drafts + 3 reviews + 1 synthesis = 7 |
| Team delegation, three roots | 3 root starts + 2 helpers + 1 parent continuation + 3 reviews + 1 synthesis = 10 |
| Quick, helpers and tools off | 1 root draft |
| Quick + helpers, delegation scenario | 1 parent start + 2 helpers + 1 continuation = 4; no peer review or synthesis |
| Delegation scenario with permission off | Base workflow only; explicit notice that no helper was requested or dispatched |

The activity section shows names, stable agent IDs, provider, demo profile, task,
status, and parent/depth for each child. Child results sit below their parent.
Every dispatched call is listed separately, including root starts, child calls,
parent continuations, reviews, retries, and synthesis. The selected synthesizer is
an exact agent ID. Another agent using the same provider is never silently
substituted.

## Shared limits and scheduling

The rail shows the base plan, additional calls for the selected delegation sample,
and proposed live bounds. All roots and descendants share these limits:

| Limit | Proposed default |
| --- | --- |
| Observable provider API requests, including retries and continuations | 32 |
| Observed tool operations | 64 |
| Native agent SDK/CLI jobs | 4 |
| Concurrent calls | 3 total, at most 2 to any one provider |
| Overall deadline | 300 seconds |
| Per-call timeout | 45 seconds |
| Requested output per call | 2,048 tokens |
| Total requested output allowance | 65,536 tokens |
| Helper depth | At most 2; user may choose 1 |
| Children per agent / helpers per run / total agents | 2 / 6 / 12 |

Plain Quick with helpers and tools both off uses a one-request cap. Enabling
either permits the configured 32-request tree budget, even when the ordinary
sample happens to finish after one request. These are configurable deployment
defaults, not universal scale limits. Native jobs and observed tool operations
have distinct units and budgets. Unobserved native internals remain unknown.

The demo's deterministic scheduler respects concurrent-call and per-provider slot
limits, including same-provider twins and six-root configurations. Short timers
are illustrative, not latency measurements. Deadline, token reservation,
recursive admission, and live cancellation require server implementation. Token
allowances govern requested output, not input charges or a monetary guarantee.

At most one safe retry is allowed per logical step across all its continuations,
only after an explicit rejection known to precede generation and within every
remaining limit. An ambiguous timeout or sent request is never automatically
retried. The partial simulation uses an explicit pre-generation rate-limit
rejection followed by one rejected safe retry.

## Automatic capability and tool routing

Team permits preconfigured read, search, and scratch-code capabilities by default.
Quick starts with tools off and allows an explicit opt-in. The Automatic tool
routing section exposes the mode's policy and a compact capability registry.
The planner selects an eligible profile/backend from that registry; it does not
load every tool into every agent or decide eligibility by model votes. Automatic
selection never creates an authorization grant.

The demo registry contains three fictional mappings, with no claim about current
vendor support:

| Requested capability | Backend family | Approved helper profile |
| --- | --- | --- |
| Web research | Provider API tool | Demo research |
| Sandboxed code | MCP/local tool | Demo scratchpad |
| Workspace agent | Agent SDK/CLI | Demo workspace |

Demo balanced has a registered web capability; Demo analytical has a registered
scratch-code capability. Other requests route to the listed approved helper when
subagents are allowed. Helper targets inherit the parent's provider and do not
expand destinations. The activity names the reason, selected backend, provider,
profile, destination, task, parent, and returned result. A missing capability or
permission produces a visible blocked state, never a silent provider or
synthesizer substitution. This illustrates a harness-managed helper, not native
CLI recursion or a vendor's built-in subagent capability.

Tool permission alone cannot create a helper. Capability delegation uses the same
Allow subagents switch, depth, per-parent child, total-helper, and total-node
quotas. When subagents are off, the default profile can use its approved direct
web route, but its missing scratch-code capability stays blocked with an explicit
reason. Native internal delegation is not enabled in this demo and needs a
separately admitted bounded-job policy before live use.

In the Automatic tools scenario, Web research + sandboxed code is the default
request; the user can instead select either capability or Workspace agent. For
the default three-root team, the combined sample has ten provider API invocations:
three initial roots, one API-tool invocation, one helper invocation, one parent
continuation, three root reviews, and one synthesis. Two known tool operations
are counted separately: a mock web search and a mock scratch calculation. The
web result says **Simulated retrieval; support unverified**. Retrieval, a working
citation, and support for an answer are distinct states. No actual source is
retrieved by the design.

The workspace sample displays eight observable provider API requests plus one
native-agent job, rather than calling the entire SDK/CLI job one model call. It
marks internal model/tool usage unknown and live policy admission unvalidated.
Strict policy rejects a missing required inner cap. An explicitly admitted
bounded-job policy may keep inner counts unknown while enforcing supported
scope, deadline, termination, and job controls. The chosen policy determines
eligibility; an outer-job cap never establishes unknown inner usage. No live
adapter or admission path is validated by this prototype. It executes no SDK,
CLI, provider API tool, MCP operation, sandboxed code, or workspace action.

The Action needs permission scenario names a concrete proposed public publish,
its destination, and its exact text. With no matching task grant it pauses and
says **Permission required. Nothing sent.** It does not provide a button that
pretends to authorize a real external action. Existing task grants can already
cover bounded workspace edits or other permitted writes; they may proceed
without a redundant confirmation. Unknown or out-of-scope actions require a
matching grant. Read/search/scratch-code eligibility is separate from permission
to send, publish, delete, or expand access.

Some provider-native server tools cannot be intercepted before each internal
action. Their enabled scope must already be approved, or the route stays
ineligible. A broad native capability is not a way around application policy.
The Unsupported capability scenario requests image editing, for which this demo
has no approved backend/profile, and stops without selecting a new provider.

Activity and export separate API invocations, known tool operations, native
jobs, and unknown internal usage. Cancellation invalidates tool-result callbacks
as well as all root and child timers. No canceled tool result can resume a parent
or produce a later final answer.

## Answers and source status

The main answer has a short recommendation, supporting points, and a material
assumption or limitation. The source section separates information used from
sources retrieved and checked. Ordinary samples say **Not retrieved or verified**;
the web-tool sample says **Simulated retrieval; support unverified**. No real
external source is retrieved. Helper findings do not establish source support.

The completion label says **Checks completed, correctness not guaranteed**.
Agreement is not a correctness score. A material disagreement remains visible
as an open question. Quick and Quick + helpers explicitly state that no peer
review occurred. Expandable drafts and short review findings are inspectable
outputs, never private reasoning traces.

## Failure, cancellation, and recovery

| Trigger | Visible result and recovery |
| --- | --- |
| Empty send | “Choose an example or enter a message to start the simulation.” |
| Fewer than two enabled Team roots | Send disabled; “Enable at least two root agents for Team mode.” |
| No Quick root | Send disabled; “Add or enable an agent for Quick mode.” |
| Six configured roots | Add disabled; remove a root before adding another |
| One agent unavailable | That exact agent's draft is missing; siblings using the same provider remain available; workflow is partial |
| Only one root draft survives | All peer reviews skipped; available synthesis remains partial |
| Selected synthesizer unavailable | No substitution; labeled drafts/findings displayed without a consolidated final answer |
| Tool permission off or required helper unavailable | Capability visibly blocked; no provider/profile permission added |
| SDK/CLI internals unobservable | Unknown counts stay unknown; live admission unvalidated; strict inner-cap and explicit bounded-job policies differ |
| Publish without matching task grant | Concrete action, destination, and text displayed; Permission required; nothing sent |
| Unsupported capability | No approved route; no fallback silently introduced |
| Stop | Root and descendant work canceled; no further calls or final answer |
| New chat during work | Timers invalidated and current content cleared; old callbacks cannot alter the new chat |

The partial scenario fails the last enabled root, not its entire provider. With
three roots and an available synthesizer it dispatches seven attempts: three
starts, one safe retry, two reviews, one synthesis. Selecting the failed root as
synthesizer skips synthesis and uses six. With two roots it uses four or three,
respectively, because only one draft survives and all peer reviews are skipped.

Configuration is locked during a run; Send becomes Stop. Run identity and timer
invalidation cover the entire simulated tree. Canceled exports contain no final
answer. A live system must enforce these transitions on the server and disclose
that already-sent provider work may still be processed or billed.

## Privacy, export, and provider setup

This design uses no external scripts, fonts, images, analytics, or network
requests. User text is inserted through `textContent`, never interpreted as
markup. Nothing is saved in local storage, cookies, or a server. Reset clears the
current record and displayed text; reload or close discards the session.

Export deliberately downloads a JSON demo record containing the current message,
root and child identities, hierarchy, task outputs, call statuses, selected
synthesizer, source status, and simulation notice. It includes no credentials or
private reasoning. Canceled runs, skipped synthesis, permission pauses, and
unsupported-capability stops export no final answer.

Provider setup explains the proposed live configuration: user keys are supplied
through server environment variables and never exposed to the browser. Before a
live send, the interface must disclose every permitted provider destination,
including child profiles, relevant user context, and cross-provider review of
other agents' outputs. The sample helpers inherit their parent's provider and
profile. Broader target profiles require explicit configuration; model text
cannot expand permission. Self-hosting controls application storage, not remote
provider processing or retention. Current provider policies still need review
before integration.

## Accessibility and responsive behavior

- Native buttons, checkboxes, selects, forms, details, and a modal dialog provide
  keyboard operation. Focus is visible; Escape closes the provider dialog.
- Enter sends; Shift+Enter inserts a line. Input-method composition is respected.
  Errors and stage messages have announcement regions. Mode selection is exposed
  through pressed state; statuses use text as well as color.
- At narrower widths, history is hidden and New chat appears beside the mode
  controls. Below 640 px the agent rail moves below the conversation. The desktop
  rail scrolls independently so six roots do not push the composer away.
- No recurring animation is used. Reduced-motion preference disables motion.
  Timers change state without scrolling or stealing focus.

Validate whether the hierarchy is understandable without reading every call,
whether same-provider agents stay distinguishable, and whether users notice the
absence of peer review in Quick + helpers. Evaluate actual answer quality before
assuming that more roots or deeper delegation improve it.

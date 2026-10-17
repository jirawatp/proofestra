# Experience design

This describes a proposed interface for a personal, single-user, self-hosted
Proofestra web app. The first live version supports OpenAI, Anthropic, and Gemini
with server-configured user keys. The adjacent [interactive design](prototype/index.html)
is a standalone, deterministic simulation. It makes no provider requests and
does not implement the live app, credential handling, chat persistence, or evidence
verification.

## Visual direction, before building

Proofestra should feel like a place to think with several informed collaborators.
The organizing visual idea is **three voices joining a conversation**: a compact
three-stroke mark, three provider rows, and a draft / review / answer activity
thread. The result remains the main reading surface; the team stays in a quiet
margin where the user can inspect who participates.

| Token | Value | Purpose |
| --- | --- | --- |
| Paper | `#ffffff` | Main reading and writing surface |
| Ice | `#f1f6fc` | Conversation margin and user messages |
| Ink | `#172c45` | Primary text and strong structural details |
| Cobalt | `#2458d3` | Send action, selection, and current activity |
| Teal | `#086b61` | Completed activity, without implying correctness |
| Warm yellow | `#fff3c5` | Unverified sources and incomplete review notices |

Typography uses a local humanist sans stack: Avenir Next, Avenir, Segoe UI,
sans-serif. A 14–15 px reading size, 25 px answer heading, and restrained 34–44 px
empty-state title establish hierarchy. Small interface labels remain secondary;
the live app should offer comfortable text scaling. Paragraphs stay below roughly
72 characters where space allows. Content is left aligned.

Two layout ideas were considered:

```text
Chosen: a conversation with its team in the margin
┌───────────┬──────────────────────────────┬────────────┐
│ History   │ Quick / Team                 │ Your team  │
│           │ User question                │ Providers  │
│           │ Draft → Review → Answer      │ Limits     │
│           │ Final answer                 │ Data flow  │
│           │ Drafts & findings, expandable│            │
│           │ Message composer             │            │
└───────────┴──────────────────────────────┴────────────┘

Rejected: a dashboard of agents
┌───────────┬─────────┬─────────┬─────────┐
│ History   │ Agent A │ Agent B │ Agent C │
│           ├─────────┴─────────┴─────────┤
│           │ Final answer              │
└───────────┴───────────────────────────┘
```

The dashboard gave every output equal visual weight and forced the user to read
three answers before seeing a useful result. The chosen layout makes independent
contributions inspectable without making them the default reading burden.

The first visual plan used rounded provider cards and a floating answer panel.
Reviewing it against the brief showed a generic software dashboard. These became
plain provider rows, a continuous answer surface, and one bounded activity strip.
The three-voice mark is the distinctive accent. Gradients, decorative metrics,
accuracy percentages, novelty type, and an oversized marketing hero were removed.
The muted system palette keeps attention on the actual question and review status.

## Navigation and everyday flow

The desktop layout has a history sidebar, a central conversation, and a team rail.
The history sidebar holds the current session in the prototype. It does not imply
that earlier conversations are stored. The live version should support saved local
history, deliberate deletion, and explicit export. A new chat creates a blank
conversation while retaining the user's selected mode and provider configuration.

The empty state offers three concrete examples: a database choice for a personal
app, model agreement, and self-hosting privacy. Selecting an example fills the
composer. Sending starts the selected sample simulation. Arbitrary user text can
label that simulated message, but the design explicitly says the answer uses the
selected preset example; it never pretends to answer arbitrary text.

**Quick** uses one selected provider for one draft. It skips peer review and labels
the answer **Unreviewed**. **Team** uses two or three enabled providers. The default
has one agent each from OpenAI, Anthropic, and Gemini, producing three independent
drafts, three cross-reviews, and one synthesis: seven planned calls, no more than
nine attempts, and up to three calls in parallel. Two enabled agents use five
planned calls within the same nine-attempt cap. The selected synthesizer must be
an enabled provider. Quick has one attempt in this design.

The rail exposes proposed live limits: a 180-second overall deadline, 45 seconds
per call, 2,048 requested output tokens per call, and 16,384 total requested output
tokens. Input charges are separate. These defaults bound scheduling and requested
output, not money. The demo's short timers are illustrative; they are not provider
performance measurements or a working budget implementation.

Configuration is locked during a run. The composer action changes from **Send** to
**Stop**. The user can inspect concise activity and the number of attempts started.
Each agent drafts before seeing its peers. A completed team run preserves each
initial draft and short review findings in an expandable section. This is a record
of outputs and review findings, never private reasoning traces.

Model labels say **Configured model** until implementation resolves provider model
identifiers and capability checks. Every provider in this design says **Demo**.
There are no fake connection lights, live balances, currency estimates, credential
fields, or assertions that provider availability has been checked.

## Response anatomy and trust

The main answer has a short recommendation, relevant supporting points, and a
material assumption or limitation. The source section separates **information
used** from **sources retrieved and checked**. In this prototype, all outside
sources remain **Not retrieved or verified**. No citation is invented to make a
simulated answer appear sourced.

The completion label says **Checks completed, correctness not guaranteed**.
Agreement is not a vote-based correctness score. An unresolved disagreement gets
a visible open-question notice and remains unresolved in the final answer. A
provider failure is an operational event, not a quality judgment about its answer.
Quick mode makes the absence of independent review visible at both the status and
answer level.

## States and recovery

| State or trigger | Visible behavior and recovery |
| --- | --- |
| Empty chat | Concrete examples and an available composer |
| Empty send | “Choose an example or enter a message to start the simulation.” |
| Fewer than two Team providers | Send disabled; “Select at least two providers for Team mode.” |
| No Quick provider | Send disabled; “Select a provider to use Quick mode.” |
| Drafting | Provider names, independent-draft activity, attempts started |
| Reviewing | Cross-review activity, preserved initial drafts |
| Synthesizing | Named final-answer provider; sources stay unverified |
| Full review | Review complete, answer, expandable drafts and review findings |
| Unresolved disagreement | Open-question status and explicit unresolved claim |
| Agent unavailable | Explicit rate-limit rejection before generation, then one safe retry rejected; missing participation identified; result labeled partial |
| Selected synthesizer unavailable | Synthesis skipped; available labeled drafts/findings shown without a consolidated answer or provider substitution |
| Quick response | Single draft and visible Unreviewed label |
| Stop | “Run canceled”; no final answer, export marked canceled |
| New chat during a run | Timers canceled; blank chat; no late result can appear |

The partial scenario selects Gemini when enabled, otherwise the last enabled
provider. The request is explicitly rejected before generation; one retry receives
the same explicit rejection. That provider has no draft and does not review.
No ambiguously sent request or timeout is automatically retried. The selected
synthesizer stays fixed. If that provider is unavailable, synthesis is skipped
and the draft/findings section opens without a consolidated answer.

With three enabled providers, two drafts survive, followed by two reviews. This
produces seven attempts when the selected synthesizer is available, or six when
synthesis is skipped. With two enabled providers, one draft survives, so all peer
reviews are skipped; this produces four attempts with available synthesis or
three with synthesis skipped. All remain partial. These are illustrative failure
transitions, not a live retry implementation.

Exports download a JSON **demo record** containing the current simulated message,
participants, mode, attempts, rendered sample answer, available draft/review
contributions, and explicit simulation/source
status. A canceled export has no sample answer; skipped synthesis also exports
no synthesized answer. It contains no credentials or
reasoning traces. Export is a deliberate user download; there is no automatic save.

The prototype uses a run-generation token and clears pending timers on Stop, New
chat, and a new run. Old callbacks cannot change a later chat. A live coordinator
must enforce equivalent run identity and cancellation on the server as well.

## Privacy and provider setup

The design uses no external fonts, scripts, images, analytics, or network requests.
Chat text exists in the current page's memory; it is not placed in local storage,
cookies, or a server. Resetting the chat clears the current record; closing or
reloading the tab discards the session. User text is inserted with `textContent`,
not interpreted as markup. The explicit export includes the current message in
the downloaded file.

The provider setup dialog explains the proposed live setup: users supply their
own keys through server environment variables. The browser must never receive
secret values. The live app should display whether each server configuration is
available without exposing the key, and show actionable normalized connection
errors. Credential checks and billable requests need a separate implementation.

Before a live send, the composer identifies selected provider destinations.
The data-flow notice explains that selected providers receive relevant user
context and review may send other agents' drafts across providers. Self-hosting
controls application storage, not remote provider processing. Provider policies
must be checked during implementation.

## Keyboard, responsive layout, and accessibility

- Controls use native buttons, checkboxes, selects, details, and a dialog with
  visible focus. The provider dialog closes with Escape and native modal focus
  behavior.
- Enter sends; Shift+Enter inserts a new line. Input-method composition is not
  interrupted. The composer has a screen-reader label; errors and stage updates
  use announcement regions.
- Mode controls expose their selected state. Status is expressed in text as well
  as color. Expandable findings use a native summary control.
- At narrower widths the history sidebar is hidden and an explicit New chat
  action appears in the conversation. Below 640 px the team rail moves below the
  chat rather than squeezing the reading surface. Provider selection remains
  available by scrolling.
- No recurring animation is used. Reduced-motion preference disables motion.
  Stage timers change text and state without moving the viewport or stealing
  focus. Zoom and narrow-screen review belong in implementation acceptance checks.

## Design decisions still to validate

Test whether a persistent right-side team rail is more useful than a compact
sheet on small laptops, whether users understand source support separately from
agent agreement, and whether Quick's unreviewed status is visible enough. Measure
the usefulness of review findings before adding more agents or repeated review
rounds. These are usability questions, not evidence that multi-model review
improves accuracy.

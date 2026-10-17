# Evaluation plan

Status: proposed method; no benchmark has run and no quality improvement has been
measured. This plan tests whether review, helpers, and automatic tools justify
their work, latency, cost, and data exposure. Agreement is not ground truth.

## Initial set

Start with 18 small, versioned, text-only cases: three from each category below.
Keep all facts and source excerpts needed for grading in the case fixture. Do not
depend on live retrieval, current news, or inaccessible external documents for the
default suite. Tool tests use deterministic search/code/file/MCP/native-job fixtures;
separate opt-in live compatibility checks use controlled sources and sandbox scopes.

| Category | What it tests |
| --- | --- |
| Stable factual questions | Correct answers and resistance to a plausible shared mistake. |
| Arithmetic and constrained reasoning | Checkable results with stated constraints and an exact answer key. |
| Conflicting supplied excerpts | Separating what each excerpt supports and preserving an unresolved conflict. |
| Insufficient information | Asking for missing information or leaving the answer unresolved instead of inventing facts. |
| Misleading citations | Distinguishing model-only references, successful/failed retrieval, and actual claim support; fetched does not mean supported. |
| Adversarial supplied text | Treating model/tool/retrieved instructions as data and preserving task grants. |

Each case stores its ID/version, prompt, optional supplied excerpts, answer key,
material errors, acceptable uncertainty, and human scoring notes. Keep graders'
answer keys outside provider prompts. Use synthetic or public material and no keys
or personal conversations. Record expected answers before inspecting outputs.

## Comparisons

Run plain Quick with each default profile with tools/helpers OFF. Compare the same
roots in Team with both OFF, helpers ON/tools OFF, and helpers ON/tools AUTO.
Declare synthesis by agent ID, tool grants, helper profiles/backends and routing
policy before running. Optional Quick-with-tools trials stay separate from baseline.
Use the same user-visible context, exact model IDs, adapter versions, output caps, and provider settings
where supported. Record unsupported settings rather than pretending providers are
identical. Use three repetitions per condition initially; do not silently retry a
bad answer or drop a failed run.

Declare the primary Quick baseline before scoring: the selected synthesizer's
Quick result. Show the other two Quick baselines too. Never select the weakest
baseline after seeing results. Separate gains from root review, helpers and tools;
report their separate work/visibility and cost. A later cost-matched baseline can test
whether improvement comes from review rather than spending more tokens. Do not
claim independent model diversity from repeated agents sharing one provider/model.

Add focused configuration trials with two same-profile OpenAI roots, two different
OpenAI profiles, and a mixed-provider team. Preserve distinct agent IDs and roles;
helpers are branch artifacts, not extra votes or human graders. Use deterministic
mock fixtures first. Vary one backend/capability at a time: a tool being available
does not establish parity with another provider or native agent runtime. Native
inner work can be opaque; do not claim equal compute when counts are unavailable.

Retain initial drafts so the evaluator can count errors corrected by review and
errors introduced during review/synthesis. Do not expose them to final-answer
graders until their first score is recorded. Randomize and mask model/condition
labels for human scoring when practical; answer style may still reveal conditions.

## Three distinct kinds of evidence

| Kind | Checks | What it establishes |
| --- | --- | --- |
| Automated contract checks | Registry readiness; lazy top-K selection; automatic routing; grants/no repeated prompts; agent/profile/backend identity; inherited scopes; draft barrier; deduplication; configurable finite ledgers; waiting-parent progress; tree/job stop; safe exports; no mock/live crossover. | The system follows its declared behavior; not answer correctness. |
| Answer-key checks and human review | Exact calculations; factual/material errors; faithfulness to provided excerpts; appropriate uncertainty; citation claims against fixture evidence. | Quality on the evaluated cases with the stated grading method. |
| Model reviews | An agent's concise criticism, correction proposal, or agreement. | Another model's opinion; never a ground-truth label or independent verification. |

Use the [requirements acceptance scenarios](requirements.md#acceptance-scenarios)
for focused behavioral checks. Fault injection must cover authentication failure,
rate limiting, timeout, absent usage, cancellation, restart, and synthesis failure.
Include accepted child failure, denied spawn, duplicate callbacks, depth/lifetime
quota exhaustion, unapproved profiles, and saturated per-provider execution slots.
Test missing credentials, unsupported tools/native nesting, stale compatibility,
grant revocation, consequential out-of-scope actions, and unavailable native stop.
With tools ON/helpers OFF, a compatible direct tool may run, but routing must not
create a managed child for an unavailable capability. Recheck revoked/expired
grants before dispatch; exact-action approvals apply only inside frozen route/
tool/backend/profile/destination allowlists and cannot mint a blanket grant or
authorize altered arguments. A broader allowlist/provider/destination needs a new
user-configured run, not an in-run approval amendment.
Covered read/sandbox/reversible workspace actions must execute without per-call
approval; an action outside the grant pauses on the exact action. Register large
catalogs and policy caps above personal defaults without exposing all tools at once.
Concurrency assertions use effective advertised limits, not a hardcoded two.
Default checks use mocks and require no paid calls. Live evaluation is a separate,
explicitly opted-in operation with a preview of destinations, grants, conditions,
observable request/tool/job limits and opaque native usage. Missing native scope
or required deadline support must reject under strict policy. No live provider,
CLI job, or paid evaluation is run during this design phase.

## Scoring and records

Score each final answer as **2 = correct and appropriately qualified**, **1 = useful
but with a minor error/omission**, or **0 = material error, fabrication, or unsupported
certainty**. Case notes define material errors before running. Mark an operational
failure separately; report completed-answer scores and end-to-end success so failures
cannot disappear from the comparison. Count a justified refusal as correct only
when the answer key calls for it.

For each run retain case/version, timestamp, condition, prompts, exact model IDs,
adapter/configuration version, root/child IDs, parentage/depth, model profiles,
backend/validation versions, helper/tool policy, scoped grants, shortlist/routing
decisions, denials/failures, synthesizer ID, review coverage, outcomes and artifacts.
Record harness-dispatched requests, observed tool operations and native jobs as
separate units; include nullable native inner counts/visibility, elapsed time,
reported vs estimated/unknown tokens and cost with pricing source/date if available.
Never store credentials or private reasoning traces in evaluation artifacts.

Report per-case outcomes plus correct-answer rate, material-error rate, appropriate
uncertainty, supplied-source faithfulness, operational failure rate, review-introduced
errors, tool/helper failures and denials, unnecessary approval prompts, route quality,
latency, observable work, visibility, tokens and estimated cost. Separate every
condition and record changed review coverage for larger-team plans. Citation
grading checks fixture evidence independently: model-only citations stay unverified;
successful tool retrieval is retrieval evidence, with support still unverified
unless a separate check establishes it. Distinguish missing data from zero; a
native job is never treated as one total model call. Include raw counts and a results
table; 18 cases do not support broad claims about accuracy or statistical certainty.

## Review and release decisions

For the first personal release, one human can score the set; identify that limitation.
Before public quality claims, obtain a second independent human score of the same
answers, preserve disagreements, and resolve material scoring differences against
the prewritten case key. A model judge can assist triage but cannot replace that review.

Behavioral acceptance must pass and failures must be understandable. Quality results
inform whether Team should be recommended, what it costs, and which cases need work;
they do not force a positive claim. If Team adds errors or offers no clear benefit,
report it and keep Quick available. Publish configuration, limitations, negative
examples, and dated results before saying the workflow improved evaluated answers.

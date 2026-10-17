# Evaluation plan

Status: proposed method; no benchmark has run and no quality improvement has been
measured. This plan tests whether the bounded team workflow helps enough to justify
its additional calls, latency, and provider exposure. Agreement is not ground truth.

## Initial set

Start with 18 small, versioned, text-only cases: three from each category below.
Keep all facts and source excerpts needed for grading in the case fixture. Do not
depend on live retrieval, current news, or inaccessible external documents.

| Category | What it tests |
| --- | --- |
| Stable factual questions | Correct answers and resistance to a plausible shared mistake. |
| Arithmetic and constrained reasoning | Checkable results with stated constraints and an exact answer key. |
| Conflicting supplied excerpts | Separating what each excerpt supports and preserving an unresolved conflict. |
| Insufficient information | Asking for missing information or leaving the answer unresolved instead of inventing facts. |
| Misleading citations | Avoiding invented support and keeping model-proposed links visibly unverified. |
| Adversarial supplied text | Treating embedded instructions as data and preserving the user's actual task. |

Each case stores its ID/version, prompt, optional supplied excerpts, answer key,
material errors, acceptable uncertainty, and human scoring notes. Keep graders'
answer keys outside provider prompts. Use synthetic or public material and no keys
or personal conversations. Record expected answers before inspecting outputs.

## Comparisons

Run every case in Quick with each of the three configured models and in Team with
the same three models and one declared synthesizer. Use the same user-visible
context, exact model IDs, adapter versions, output caps, and provider settings
where supported. Record unsupported settings rather than pretending providers are
identical. Use three repetitions per condition initially; do not silently retry a
bad answer or drop a failed run.

Declare the primary Quick baseline before scoring: the selected synthesizer's
Quick result. Show the other two Quick baselines too. Never select the weakest
baseline after seeing results. Team has a larger compute budget, so report that
cost openly. A later cost-matched baseline can test whether improvement comes from
review rather than simply spending more tokens; it is not part of the initial claim.

Retain initial drafts so the evaluator can count errors corrected by review and
errors introduced during review/synthesis. Do not expose them to final-answer
graders until their first score is recorded. Randomize and mask model/condition
labels for human scoring when practical; answer style may still reveal conditions.

## Three distinct kinds of evidence

| Kind | Checks | What it establishes |
| --- | --- | --- |
| Automated contract checks | Planned call counts, draft independence, stage order, caps, cancellation, failures, safe export, no mock/network crossover. | The system follows its declared behavior; not answer correctness. |
| Answer-key checks and human review | Exact calculations; factual/material errors; faithfulness to provided excerpts; appropriate uncertainty; citation claims against fixture evidence. | Quality on the evaluated cases with the stated grading method. |
| Model reviews | An agent's concise criticism, correction proposal, or agreement. | Another model's opinion; never a ground-truth label or independent verification. |

Use the [requirements acceptance scenarios](requirements.md#acceptance-scenarios)
for focused behavioral checks. Fault injection must cover authentication failure,
rate limiting, timeout, absent usage, cancellation, restart, and synthesis failure.
Default checks use mocks and require no paid calls. Live evaluation is a separate,
explicitly opted-in operation with a preview of conditions, call count, and limits.

## Scoring and records

Score each final answer as **2 = correct and appropriately qualified**, **1 = useful
but with a minor error/omission**, or **0 = material error, fabrication, or unsupported
certainty**. Case notes define material errors before running. Mark an operational
failure separately; report completed-answer scores and end-to-end success so failures
cannot disappear from the comparison. Count a justified refusal as correct only
when the answer key calls for it.

For each run retain case/version, timestamp, condition, prompts, exact model IDs,
adapter/configuration version, enabled agents, synthesizer, outcomes, drafts,
findings, final output, calls/retries, elapsed time, reported usage, estimated or
unknown usage, and estimated cost with its pricing source/date when available.
Never store credentials or private reasoning traces in evaluation artifacts.

Report per-case outcomes plus correct-answer rate, material-error rate, appropriate
uncertainty, supplied-source faithfulness, operational failure rate, review-introduced
errors, latency, tokens, and estimated cost. Citation evaluation is manual against
fixture evidence; the app still labels citations unverified because it did not fetch
them. Distinguish missing data from zero. Include raw counts and a readable results
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

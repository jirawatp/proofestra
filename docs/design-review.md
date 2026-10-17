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

## Checks performed

- OpenAPI 3.1.1 validation, six embedded request/schema/event examples, and twelve
  invalid-schema cases passed. Semantic fixtures cover repeated profiles, unique
  agent IDs, synthesizer membership, lineage/cycles, and invocation-scoped spawn
  deduplication. These are design-contract checks, not backend tests.
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

The design distinguishes provider/profile from agent identity, root reviewers
from helper artifacts, and the base call plan from dynamic total usage. Spawn
identity includes the immutable parent invocation because tool IDs can repeat
between responses. Waiting parents release execution slots, and all descendants
share quotas, context permissions, cancellation, and the run deadline.

## What remains unverified

There is no backend, persistence implementation, provider integration, live
credential handling, or production security test. No model API calls, paid
evaluation, provider availability tests, or source retrieval occurred. The
standalone mockup keeps chat text in tab memory and exports only on user action.
Its delegation example shows two direct children. The nested policy and alternate
profile admission still require implementation; no arbitrary recursive runtime
or provider-native subagent system has been tested.

The package is ready to guide the first mock-backed implementation slice. It is
not a claim that the proposed limits, security controls, or answer-quality gains
have been achieved. Live adapters and evaluation follow the [roadmap](roadmap.md).

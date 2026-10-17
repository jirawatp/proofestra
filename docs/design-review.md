# Design review record

Reviewed 17 October 2026. This records checks on a design package and simulated
interface, not production acceptance or a measured accuracy improvement.

## Scope

The user confirmed personal self-hosting, own provider keys, and OpenAI,
Anthropic, and Gemini together in the first live version. The requirements,
experience, technical design, API contract, evaluation plan, and roadmap use that
scope. Other defaults remain proposed choices, recorded in [decisions](decisions.md).

## Checks performed

- OpenAPI 3.1.1 validation, example-schema checks, and invalid-request cases passed.
  Cross-field rules documented in prose still require server implementation.
- Relative documentation links, referenced anchors, and whitespace were checked.
- The prototype's embedded JavaScript passed a syntax check.
- A browser check completed the default Team simulation with seven attempts,
  kept sources explicitly unverified, and observed no external requests or script
  errors during that flow.
- Quick completed with one simulated call. User-entered HTML remained inert text.
- A two-provider partial case used four attempts with peer review skipped when
  only one draft survived. Selecting the unavailable synthesizer used three
  attempts and showed labeled drafts without a consolidated answer.
- Team submission was blocked with fewer than two providers. Cancellation stayed
  canceled after pending timers would have completed. Disagreements remained visible.
- Native modal Escape, Enter-to-send, JSON download, and desktop/mobile layouts
  were exercised. At 390 CSS pixels the page had no horizontal overflow. This is
  not a full accessibility audit.

The design review corrected ambiguous-timeout retries, peer review with no peer,
automatic synthesizer substitution, and unspecified context overflow. The first
version uses explicit safe rejected-request retries and shared all-history context
or an explicit preflight rejection.

## What remains unverified

There is no backend, persistence implementation, provider integration, live
credential handling, or production security test. No model API calls, paid
evaluation, provider availability tests, or source retrieval occurred. The
standalone mockup keeps chat text in tab memory and exports only on user action.

The package is ready to guide the first mock-backed implementation slice. It is
not a claim that the proposed limits, security controls, or answer-quality gains
have been achieved. Live adapters and evaluation follow the [roadmap](roadmap.md).

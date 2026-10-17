# Security policy

## Current status

Proofestra is in requirements and design. A standalone interactive mockup uses
simulated answers and makes no model calls. There is no application backend,
live agent harness, hosted service, provider integration, supported release, or
security audit yet. Architecture documents describe intended controls, not
guarantees that those controls have been implemented.

## Reporting a vulnerability

If enabled, use [GitHub private vulnerability reporting](https://github.com/jirawatp/proofestra/security/advisories/new)
to share a suspected vulnerability privately. Include affected files or versions,
reproduction steps, likely impact, and a minimal example with secrets removed.

If private reporting is unavailable, open a minimal public issue requesting a
private contact channel. Do not include exploit details, API keys, personal
conversations, sensitive traces, or other confidential information in that issue.
Wait for a private channel before sharing those details.

This is an early personal project; no response-time or remediation service level
is currently promised. Please avoid testing systems or accounts you do not own
or have permission to test.

## Security goals for future implementation

- Keep provider API credentials on the server side. Do not embed them in browser
  bundles, expose them to agents, or include them in logs, exports, or traces.
- Treat user prompts, retrieved text, tool results, and model output as untrusted.
  They must not grant permissions or override application security boundaries.
- Require explicit permission boundaries for tools and external side effects.
- Minimize retained conversation data and make retention and deletion behavior
  clear. Exports and traces may contain sensitive data and need careful handling.
- Apply provider request limits and cost controls, and handle provider failures
  without silently presenting an incomplete review as a completed check.
- Preserve uncertainty and disagreement. Model agreement is not proof of
  correctness, and cross-checking is not a substitute for independent evidence.

These goals require implementation and verification before deployment with real
credentials or sensitive data.

# Contributing to Proofestra

Proofestra is a pre-alpha, documentation-only project. The chat interface, agent
harness, provider integrations, and test suite have not been implemented yet.

## Useful contributions

- Clarify the product goals, architecture, or roadmap with concrete examples.
- Identify gaps in provider compatibility, privacy, cost controls, or evaluation.
- Improve accessibility, onboarding, and documentation.
- Propose a small implementation milestone with clear acceptance criteria.

Open an issue before starting substantial work so we can agree on its scope.
Keep pull requests focused and explain the problem, proposed behavior, and any
tradeoffs. Separate unrelated changes into separate pull requests.

## Validation

For documentation, check links, keep statements consistent with the project's
actual state, and run `git diff --check` before submitting. Do not describe
planned functionality as available.

When runnable code is added, include tests appropriate to the change, including
failure cases. Provider-related tests should use mocks or fixtures by default;
live, paid API calls must be explicitly opted into. Never commit API keys,
personal conversations, or sensitive traces. Report what you tested and any
checks you could not run.

Treat prompts, retrieved content, and model output as untrusted input. Multiple
models agreeing does not establish correctness; preserve evidence,
disagreements, and uncertainty in proposed behavior.

## License

The open-source core is licensed under [Apache License 2.0](LICENSE). Contributions
intentionally submitted for inclusion are covered by Section 5 of that license,
subject to its terms. No separate CLA or DCO process is currently required.

Potential paid products must preserve the Apache 2.0 licensing of the published
core. Discuss changes to project boundaries before proposing commercial-only
features here.

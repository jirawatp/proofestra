# Proofestra

**One chat. Many minds. Better answers.**

Proofestra is a planned open-source AI chat and agent harness. The goal is a
friendly conversation where agents from different model providers work
independently, challenge each other's answers, and help the user understand the
evidence and remaining uncertainty.

> **Status: documentation starter.** This repository contains the project plan
> and contribution guidelines. The chat application, agent harness, provider
> integrations, and verification tools are not implemented yet. There is no
> runnable demo, package, or hosted service.

## The experience we want to build

1. Ask a question in a familiar chat interface.
2. Choose one agent for a quick response, or configure a team across providers.
3. Let agents form independent initial answers before seeing their peers' work.
4. Compare claims, investigate disagreements, and check evidence when suitable
   tools or sources are available.
5. Read a consolidated answer with supporting sources, unresolved disagreements,
   limitations, and a clear record of which agents participated.

Multiple models agreeing does **not** guarantee correctness. Models can share
mistakes, cite nonexistent sources, and influence each other. Proofestra should
make uncertainty visible and measure whether review improves answers, rather
than treating consensus as proof.

## Planned open-source core

- Chat interface, conversation history, and portable exports.
- Configurable agent roles, model choices, and provider adapters.
- Independent drafting, cross-review, and synthesis.
- Evidence provenance and transparent verification outcomes.
- User-controlled call limits, timeouts, and cost budgets.
- Self-hosting with users' own provider credentials.

These are planned capabilities, not a list of completed features. Hosted model
providers may charge for usage and apply their own data policies. Self-hosting
the harness would not by itself keep prompts local when remote providers are used.

## Start here

| Document | Purpose |
| --- | --- |
| [Architecture](docs/architecture.md) | Proposed components, agent workflow, and trust boundaries |
| [Roadmap](docs/roadmap.md) | Milestones and acceptance criteria for a first working version |
| [Business model](docs/business-model.md) | Apache 2.0 core and optional commercial services |
| [Contributing](CONTRIBUTING.md) | How to help while the project takes shape |
| [Security](SECURITY.md) | Project status, disclosure, and security design goals |
| [License](LICENSE) | Full Apache License 2.0 text |

To browse the starter locally:

```sh
git clone https://github.com/jirawatp/proofestra.git
cd proofestra
```

No runtime dependencies or API credentials are needed to read these documents.
The first implementation milestone is a small end-to-end chat flow with mocked
providers, followed by an opt-in trial with two real providers. Technology choices
will be recorded when that implementation begins.

## License and commercial direction

The contents of this repository are licensed under the [Apache License 2.0](LICENSE).
The open-source core is intended to stay fully Apache 2.0, including the chat UI,
orchestration, provider integrations, and verification workflow.

The proposed open-core business model charges for managed hosting, organizational
administration, support, and operational services. Any future proprietary add-ons
would be separately identified and licensed. See the [business model](docs/business-model.md)
for the proposed boundary; no commercial product is currently available.

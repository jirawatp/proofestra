# Working on Proofestra

Read [CONTINUE.md](CONTINUE.md) and [the project history index](docs/logs/README.md)
before resuming work. Inspect the current branch, Git status, and recent commits;
preserve unrelated changes. The handoff's branch/date is a checkpoint, not a reason
to reset a newer checkout.

## Source of truth

- The current user request takes precedence over earlier design choices.
- [Requirements](docs/requirements.md) use stable IDs and A1–A20 acceptance scenarios.
- [Decisions](docs/decisions.md) distinguish confirmed choices from proposed defaults.
- Current architecture, technical/API design, and agent/tool policies describe
  intended behavior. Dated [logs](docs/logs/README.md) explain its evolution.
- [Design review](docs/design-review.md) distinguishes tested artifacts from
  unimplemented capabilities. Do not turn documented provider support or a mock
  result into a claim that a live integration works.

## Traceability and handoff

For a material requirement, decision, or design change, update its current spec
and append an entry to the corresponding log. Preserve existing requirement/log
IDs. Reference affected requirements, files, source/evidence, validation, and any
superseded entry. Do not rewrite history to hide changed decisions.

Before handing off, update CONTINUE.md with the actual implementation state,
next actionable work, and unresolved choices. Use repository-relative paths and
Git revisions; do not rely on a chat transcript, local preview URL, generated
workspace path, or another machine's installed tools. Record new validation
evidence for changed behavior rather than reusing an older pass as current proof.

## Project boundaries

Keep the published core fully Apache 2.0. Preserve distinct agent identities,
same-provider teams, scoped delegation, compatible tool routing, permission
boundaries, honest native usage, and uncertainty. Review and agreement do not
establish truth. Keep credentials, private conversations, and raw reasoning/traces
out of the repository. Default development uses mocks; live calls remain opt-in.

Read CONTRIBUTING.md and SECURITY.md for contribution, validation, and security
expectations. Follow the user's requested task and branch scope; this file does
not authorize publishing, deployment, paid runs, or changes to external services.

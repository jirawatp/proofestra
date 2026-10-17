# Business model

Status: proposed direction. There is no paid service, pricing, or enterprise
offering yet.

## Recommendation

Start with a useful, fully Apache 2.0 core. Earn trust through a working
self-hosted product and measured quality improvements. Add managed hosting and
support when users want someone else to operate it. Consider separate enterprise
add-ons only after real organizational needs emerge.

## Keep the core open

The planned Apache 2.0 core includes the chat UI, agent orchestration, provider
adapters, independent review, evidence handling, evaluation tools, conversation
exports, and self-hosting. Basic privacy controls and safe credential handling
belong in the core as well. Do not make the core depend on a proprietary service
to complete a conversation or verify an answer.

Every file currently in this repository is covered by the root [LICENSE](../LICENSE).
There is no commercial-use restriction, production-use restriction, or delayed
license conversion attached to the core.

## Possible revenue paths

| Offering | What customers pay for |
| --- | --- |
| Managed hosting | Deployment, updates, backups, availability, and convenient billing |
| Support and services | Installation help, integration work, training, and support agreements |
| Organization add-ons | Optional SSO, centralized policy administration, and enterprise operational integrations |

These are product ideas, not committed features. Keep optional proprietary
extensions separately packaged and clearly licensed. A paid hosted service can
run the same Apache-licensed core without changing the core's license.

## Practical boundaries

- Keep published core releases under Apache 2.0; do not replace the license with
  a source-available license as a monetization shortcut.
- Preserve contributor and third-party notices, and document dependency licenses.
- Evaluate costs and demand before introducing prices or bundled model usage.
- Separate hosting fees from model usage so customers can understand their costs.
- Compete on experience, service, and execution. Apache 2.0 also permits others
  to commercialize compliant copies and derivatives.
- Treat brand protection separately: a software license does not establish
  trademark ownership or commercial name clearance.

## License reference

The [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) grants broad
copyright rights and an express patent license, subject to its conditions. Its
redistribution requirements include retaining the license and relevant notices
and marking modified files. It does not grant general trademark rights. See
sections 2-6 and the [Apache licensing FAQ](https://www.apache.org/foundation/license-faq.html).

The commercial boundary above is a project strategy, not an additional condition
on the Apache-licensed core.

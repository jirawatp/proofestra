# Provider capabilities and integration candidates

Checked against official documentation on 17 October 2026. These are documented
capabilities and proposed adapter targets, not tested Proofestra connections.
Model, API, account, region, transport, and SDK version can change availability.
No credentials, live inference, vendor tool execution, or paid evaluation were used.

The initial API targets are OpenAI, Anthropic, and Gemini. The registry accepts
other provider IDs and versioned adapters; an OpenAI-compatible endpoint does not
automatically inherit every OpenAI tool. The user confirmed all tool surfaces in
design scope: API tools, local agent apps/SDKs/CLIs, MCP/local tools, and hosted
agent services where supported. Compatibility and delivery remain staged.
See [tool policy](tools.md), [scaling](scaling.md), and [decisions](decisions.md).

Shared skills/plugins/custom MCP use a [harness-owned extension layer](extensions.md).
Its function bridge is a proposed way for connected providers to reuse one custom
server registration; native provider MCP connector restrictions are not the same
as that broker's capabilities. No native plugin-format parity is assumed.

## Direct model APIs

| Provider / surface | Documented tool options | Adapter consequence |
| --- | --- | --- |
| OpenAI Responses | Native tools, custom functions, remote MCP, and tool search on compatible models | Map explicit model/tool combinations. Functions need an executor; a hosted tool may run before a client event. |
| Anthropic Messages | Server web search/fetch and code execution; client tools including computer/browser interaction; tool search and a remote MCP connector | Distinguish server execution from client-owned environments. Versioned tool/model support and beta requirements are capability metadata. |
| Gemini API | Google Search grounding, URL context, hosted Python execution, custom function calls, and API-specific remote MCP support | Search/code are provider-hosted; custom functions run in the application. Do not treat hosted Python as local shell access. |

Official references:

- OpenAI: [tool selection and execution](https://developers.openai.com/api/docs/guides/tools),
  [remote MCP](https://developers.openai.com/api/docs/guides/tools-connectors-mcp),
  [deferred tool search](https://developers.openai.com/api/docs/guides/tools-tool-search),
  and [computer use](https://developers.openai.com/api/docs/guides/tools-computer-use?sdk-task=browser).
- Anthropic: [client/server tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works),
  [server execution](https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools),
  [web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool),
  [web fetch](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool),
  [code execution](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool),
  [browser use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool),
  and [tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool).
- Google: [Search grounding](https://ai.google.dev/gemini-api/docs/google-search?hl=en),
  [URL context](https://ai.google.dev/gemini-api/docs/url-context),
  [code execution](https://ai.google.dev/gemini-api/docs/code-execution),
  [function calling](https://ai.google.dev/gemini-api/docs/function-calling),
  and [tool combinations](https://ai.google.dev/gemini-api/docs/tool-combination).

This design infers a common capability interface from those surfaces. It does not
infer equivalent tool schemas, permission hooks, pricing, or evidence quality.
Grounding citations and successful retrieval remain separate from a checked claim.

## Native agent SDKs and CLIs

| Backend candidate | Documented behavior | Required validation before enabling |
| --- | --- | --- |
| Codex SDK / local CLI | Programmatic local agents; non-interactive structured events; app-server interfaces for interactive control | Supported auth, approval bridge, workspace/process scope, cancellation, safe event filtering, and usage coverage. |
| Claude Agent SDK / Claude Code | Local Claude Code subprocess, tools/MCP, permission hooks, subagents including documented nesting | Exact SDK version and permission ordering, native tree limits, whole-tree usage, interrupt behavior, and supported third-party authentication. |
| Gemini CLI | Headless events, workspace/shell/web/MCP tools, extensions, configured remote agents, and native subagents | Headless policy, allowed tools, auth, cancellation, usage visibility; native children cannot themselves delegate. |

For Codex, use [SDK guidance](https://learn.chatgpt.com/docs/codex-sdk),
[non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode),
and [authentication](https://learn.chatgpt.com/docs/auth). Current SDK guidance
uses app-server for interactive integrations; the removed Codex MCP-server route
is not a valid integration plan. Structured events can contain reasoning, so an
adapter must filter private reasoning rather than exporting every event.

For Anthropic, see [SDK hosting](https://code.claude.com/docs/en/agent-sdk/hosting),
[headless operation](https://code.claude.com/docs/en/headless),
[subagents](https://code.claude.com/docs/en/agent-sdk/subagents),
[permissions](https://code.claude.com/docs/en/agent-sdk/permissions),
[cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking),
[agent-loop limits](https://code.claude.com/docs/en/agent-sdk/agent-loop), and
[Python interruption](https://code.claude.com/docs/en/agent-sdk/python).
An allowlisted tool can bypass a later permission callback; permission enforcement
must be tested at the correct hook. Whole-tree totals must not be added again to
child-event usage. Documented budget estimates can overshoot, so they do not
establish an exact monetary ceiling.

For Gemini CLI, see [headless mode](https://geminicli.com/docs/cli/headless/),
[tools](https://geminicli.com/docs/reference/tools/),
[subagents](https://geminicli.com/docs/core/subagents/),
[policy engine](https://geminicli.com/docs/reference/policy-engine/),
[remote agents](https://geminicli.com/docs/core/remote-agents/), and
[authentication](https://geminicli.com/docs/get-started/authentication/).
Headless ask-user rules deny by default; unrestricted mode is not an approval
bridge. Harness-managed nesting may supplement a backend that cannot recurse,
but must remain visible as harness delegation and obey the user's helper setting.

Native app login and API authentication are separate. Use each product's supported
flow and applicable account conditions; do not scrape, copy, or repurpose session
tokens. Anthropic's [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
and [legal/compliance guidance](https://code.claude.com/docs/en/legal-and-compliance)
distinguish third-party SDK authentication from supported use of the unmodified
Claude Code application. No general subscription-to-API credential bridge is planned.

## MCP and hosted agent services

| Surface | Documented distinction | Design consequence |
| --- | --- | --- |
| OpenAI Responses MCP | Remote Streamable HTTP or HTTP/SSE connectors; tool filtering and approvals | Connector reachability, auth, filters, and approval configuration are per route. |
| Anthropic Messages MCP | Beta connector, publicly reachable HTTP/SSE, tools only; no local STDIO | Do not offer a local STDIO server through this connector. Explicitly filter tools. |
| Gemini Interactions remote MCP | Streamable HTTP; not the older SSE transport | API/transport-specific adapter; no generic MCP parity claim. |
| Local SDK MCP | SDK-specific local/remote transports and automatic execution loops | Instrument or disable hidden loops, verify permission hooks, and account for every observable operation. |
| Hosted agent services | Provider-managed remote sessions, execution environments, and lifecycle | Separate candidate backend, with remote-state retention and cleanup controls; not the first local API adapter. |

Sources: [OpenAI MCP connector](https://developers.openai.com/api/docs/guides/tools-connectors-mcp),
[Anthropic MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector),
[Gemini function/MCP guidance](https://ai.google.dev/gemini-api/docs/function-calling),
[Claude SDK MCP](https://code.claude.com/docs/en/agent-sdk/mcp),
[Google Python SDK](https://googleapis.github.io/python-genai/), and
[Google JavaScript SDK](https://googleapis.github.io/js-genai/release_docs/index.html).
Hosted candidates include [OpenAI Agents surfaces](https://developers.openai.com/api/docs/guides/agents),
[Agents API MCP](https://developers.openai.com/api/docs/guides/agents-api/tools/mcp),
and [Anthropic Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview).
Candidate inclusion is not a delivery or account-access commitment.

## Compatibility evidence required

Every enabled registration needs a tested version/profile/transport record:
authentication without secret exposure; declared input/result/event schemas;
permission and destination enforcement; error handling; cancellation and uncertain
completion; local versus remote artifacts; managed versus native child behavior;
and known/unknown usage. Never mark a documented capability integration-tested
because its documentation was readable.

Postman's discovery workflow was applied. A generic public Orbit discovery request
returned HTTP 403, so discovery continued through official provider documentation.
No private project content or credentials were submitted. No Orbit integration ID
or live compatibility result was obtained. This gap does not block the design,
but it must not be reported as a successful discovery-service validation.

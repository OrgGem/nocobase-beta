# Hierarchical routing setup

This feature uses the custom `plugin-agent-orchestrator` routing tools in a native AI Employee chat. It is opt-in for each binding. The user needs access to every employee in the chosen path. The root employee chooses the specialist. The specialist decides whether to ask its worker to collect evidence. The worker selects from its permitted backend tools.

## Prepare employees and models

1. Enable the orchestrator, specialist and worker AI Employees and grant the user access through the normal AI Employee role configuration. Employees must be enabled, non-deprecated and in the business category.
2. Configure and enable model services. Select the main model in chat. Give the specialist and worker their own employee model settings or configure overrides as described below. Any configured model must be enabled for the employee and allowed by governance.
3. In the root employee's tool settings add `orchestrator_list_agents` and `orchestrator_delegate_task`. Give them the desired native Ask/Allow permissions. An Ask on the outer delegation approves that delegation call; it is not approval for a later worker tool action.
4. Tell the root employee in its prompt to use `orchestrator_list_agents` to find a suitable specialist and `orchestrator_delegate_task` to delegate. Ask it to review the returned evidence. The decision to call the tool remains the model's decision.

## Publish profiles

In **Agent Orchestrator → Policy Profiles**, create or edit a profile and publish its draft. Use a separate specialist and worker profile when they need different models or permissions.

- For the specialist profile, add `orchestrator_list_agents` and `orchestrator_delegate_task` to **Allowed tools** or **Ask tools**. The chat session must have auto-approval enabled when either tool requires Ask. The server rechecks this setting before each managed tool call. The specialist's normal skills and other tools are not added to this delegated execution.
- For the worker profile, list each intended tool under **Allowed tools** or **Ask tools**, and classify it under **Read-only tools**. Verify each tool's actual behavior and permissions before classifying it as read-only. Employee-specific tools must also be configured on that worker. Ask tools run only when auto-approval is enabled for the current root session. Explicitly denied tools remain unavailable. Frontend tools, native sub-agent dispatch and worker-side delegation are not enabled in this path.
- Optionally select a profile model and ordered fallback models. A binding override has priority. If the configured candidate is unavailable, the runtime checks fallbacks before starting execution. A governance denial stops the request. It does not retry a completed or potentially started tool on another model.
- An unset profile model uses the employee's model. Timeout and supported delegation limits are evaluated by the custom runtime. Profiles specifying maxToolCalls, token/cost limits, worktree mode or required worktree are rejected for this chat path. The capability matrix describes other profile settings that are not enforced for native chat.

## Create bindings

In **Agent Orchestrator → Agent Bindings**, create these enabled bindings:

| Parent | Target | Target role |
| --- | --- | --- |
| Orchestrator | Specialist | Specialist |
| Specialist | Worker | Worker |

For each binding, enable **Hierarchical routing**, select its published policy profile and describe the tasks suited to the target in **When to delegate**. A binding's LLM service/model override is optional and both fields must be supplied together. The target's employee model restrictions and governance still apply. Use one binding for each permitted parent/target relationship. A worker is a leaf in a delegated execution.

**Max Delegation Depth** counts the number of binding edges starting at that binding's parent. Set it to at least 2 for the orchestrator → specialist binding when the specialist may call a worker. Set it to 1 when only the target employee may run. The worker binding can use 1. A profile's delegation depth can further restrict the path.

**Timeout (ms)** is a ceiling for the delegated invocation and combines with the profile timeout by taking the smaller limit. A timeout or cancellation stops waiting, prevents later results from being accepted and marks an in-flight invocation uncertain. A backend reader that does not cooperate with cancellation may continue its physical read after the caller has stopped waiting.

For an existing specialist or worker binding, **Preview effective routing** accepts the current administrator's own root conversation ID. For a worker binding it resolves the saved root → specialist → worker path using that conversation, both bindings and published profiles. It shows each target's effective model, whether a fallback was selected and profile version, or the reason the path is blocked. Preview checks employee access, model governance, depth and specialist delegation tools. It does not simulate session-specific worker tool availability or execute a model or tool. Changes in the open form or unpublished drafts take effect in preview only after they are saved and published.

## Behavior and limits

- The runtime makes child conversations and records a durable identity keyed by parent session and tool call. In the same request it can return a completed result again after permission checks. In a later request it returns only an already-completed status and the child session ID. It does not replay the tool or return saved answer/evidence, because generic source-record reauthorization is unavailable. An in-flight or uncertain execution is not automatically replayed.
- NocoBase itself persists the native chat and tool results, including evidence returned during the original turn. Its conversation history can include that content in later model calls. This routing runtime does not reauthorize each source record when NocoBase loads native history, so use the host's conversation access and retention settings accordingly.
- Managed child conversations can be read as history, but their native execution, tool decisions, tool arguments and options cannot be changed directly. Cancel the root conversation to stop its managed children. Ordinary native child conversations are unaffected.
- Cancellation checks the authenticated owner and all active managed requests for that root session on the receiving server. A cancellation message is also published to other app instances; delivery depends on the host's sync/pub-sub configuration and is not guaranteed. Prefer streaming for interactive chat: it additionally uses the host's root cancellation. For a non-streaming request, the custom plugin stops waiting for managed children and returns HTTP 499 after the native root finishes. The native root graph does not receive a cancellation signal in this NocoBase path: it may continue model calls or other native tools before returning, and an unresponsive root model or native tool can delay the response. Later managed calls are refused. A backend read that ignores cancellation may also continue physically, although its late result is not accepted.
- Worker execution supports backend tools classified as read-only. The chat auto-approval control also permits supported worker Ask tools for that session. The server rechecks this setting before each tool call. Worker write/external tools, individual worker approval and resuming an interrupted worker are not supported.
- Auto-approval starts disabled for each new chat. The chat control applies only to its current owned session and is saved with that session. On the root chat, eligible native Ask calls follow the normal decision and resume path. Suggestions, workflow output prompts, and Skill Hub interactions that require user input remain manual. A tool decision already accepted by the server may complete after auto-approval is switched off.
- The native root employee may still receive its own GENERAL, SYSTEM or skill tool definitions. Configure its employee tools and skills accordingly, and inspect a real provider request to confirm the resulting model-facing schemas.
- Preview and these settings apply to calls made through the two hierarchical tools in native chat. Managed tools reject API/workflow execution contexts. Before a managed root chat runs, an enrollment guard checks native `dispatch-sub-agent-task` and worker tools exposed by the root's own settings, GENERAL tools, or available and previously loaded skills. Resolve reported conflicts through employee and conversation settings. Other custom tools that independently implement delegation are outside this check.
- Execution traces and model usage depend on data supplied by the runtime and provider. Missing usage is unknown, not zero. Compare input, cached input and output tokens, latency and configured cost for the same workload before deciding that the hierarchy saves money.

## Deterministic comparison

The PostgreSQL integration probes count model generations at the provider boundary for the same scripted workload. The figures below are counts of generations, not token usage.

| Workload | Native root | Managed root | Managed specialist | Managed worker |
| --- | ---: | ---: | ---: | ---: |
| Direct answer | 1 | 1 | 0 | 0 |
| One read | 2 | 3 | 2 | 2 |
| Two reads | 3 | 3 | 2 | 3 |

In the native nested ASK probe, the immediate recorded state was pending on root and specialist dispatch calls and init on the worker tool call, with no worker side effect. The native probe suite passed 4/4. These deterministic probes do not measure live provider billing, cached tokens, latency or answer quality, so they do not establish cost savings. [Native probe](../src/server/__tests__/native-hierarchy-probe.integration.test.ts) · [Managed routing probe](../src/server/__tests__/hierarchical-routing.integration.test.ts)

Use an isolated test conversation to verify that the correct specialist and worker are selected, a user without worker access cannot dispatch it, and the main model answers with evidence from the worker. The current implementation has not established native approval/resume for individual worker actions.

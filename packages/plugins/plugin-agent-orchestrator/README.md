# plugin-agent-orchestrator

## Overview

Agent orchestration layer for NocoBase AI Employees (plugin-ai). The plugin provides three main subsystems:

1. **Agent Loop Control Plane** — durable, policy-governed multi-step runs with a leader/maker/verifier role model, cron/event/manual triggers, budgets, approvals, and independent verification.
2. **Harness (Policy Profiles)** — versioned, tag-addressed policy bundles that constrain what each role may do (tools, memory, delegation, limits, isolation, observability), compiled layer-by-layer with most-restrictive-wins semantics.
3. **Skill Hub** — sandboxed Python/Node.js skills that AI employees can execute as tools, with async execution, human-in-the-loop review, an MCP-style surface, and Git/registry import.

On top of these, the plugin observes native sub-agent dispatching from plugin-ai, records a unified execution-span tree, injects agent memory context, and exposes an external RAG search tool.

## Agent Loop Control Plane

### Patterns

A loop pattern (`agentLoopPatterns`) defines a repeatable unit of autonomous work:

- `key`, `goalTemplate` — identity and the goal rendered for each run.
- `autonomyLevel` — `L1` (supervised), `L2`, `L3` (autonomous). L2/L3 require repository identity (`repositoryKey`, `repositoryRoot`, `baseRef`, `actingOn[]`) and worktree isolation (`policy.harness.isolation.requireWorktree`).
- `triggerType` — `manual`, `cron` (`cronExpression` + `timezone`), or `event` (`eventKey`).
- Role bindings — `leaderUsername`, `makerUsernames[]`, `verifierUsername` (verifier must differ from leader and makers).
- Per-role harness tags — `leaderHarnessTag` / `makerHarnessTag` (default `default`), `verifierHarnessTag` (default `safe`).
- `policy` — concurrency, per-run/daily budgets (invocations, tool calls, delegations, verifications, tokens, cost), circuit-breaker limits, path restrictions (`maxFiles`, deny list), action approval settings (`autoAllowlist`, approvers, timeout), tool-loop detection thresholds (`warnAt`/`blockAt`/`escalateAt`), and required verification checks.

### Run lifecycle

`LoopTriggerService` compiles the pattern (including layered harness compilation), snapshots role bindings and harness settings onto the run row, and enqueues it. `LoopWorkerService` claims queued runs with a lease + heartbeat, acquires path locks on `actingOn`, then drives the run:

`queued → preparing → waiting_lock → running → waiting_approval → verifying → waiting_human → succeeded | failed | canceled` (plus `paused`, `blocked`).

- **Leader** invocation plans the work but changes nothing.
- **Maker** invocations execute the plan, each under its own compiled harness.
- Tool calls gated as `ask` park the run in `waiting_approval` until the approval row is resolved via `agentLoopApprovals:decide` (approve — optionally substituting an edited input — or reject).
- **Tool-loop detection** (`ToolLoopDetectionService`, active in both worker and verifier) guards against repeated identical tool calls: `warnAt` injects a notice into the run, `blockAt` refuses the call, `escalateAt` escalates the run for human review.
- **Verifier** (via `VerificationService`) runs an independent pass and returns a JSON verdict: `pass` → `succeeded` (L1) or `waiting_human` (L2/L3); `reject` → `failed`; `escalate` → `waiting_human`. Required checks and artifact evidence ownership are enforced.

Human actions on runs: pause, resume, cancel, retry, escalate, accept result. Budgets, circuit-breaker state, usage buckets, events, steps, artifacts, and worktrees are persisted in dedicated collections.

### Sub-agent observation and memory

- `NativeSubAgentObserver` wraps plugin-ai's native `dispatch-sub-agent-task` flow: it resolves harness policy, injects memory context into the delegated question, records root/tool spans in `agentExecutionSpans`, tracks tokens/cost, and links skill executions. Legacy `delegate_*` / `dispatch_subagents_*` tools are retired.
- `AgentMemoryContextService` builds an `<agent_memory_context>` block from `agentMemoryContexts` records (scopes `public`, `user`, `agent_user`, plus plugin-user-memory content), trimmed to the harness-configured character limit.
- `AgentRegistryService` resolves leader↔sub-agent bindings from `orchestratorConfig`, model overrides, and alternative sub-agents for retry.

## Harness (Policy Profiles)

A harness profile is a versioned policy bundle addressed by a unique `tag`. Settings (validated by a strict zod schema in `HarnessSchema.ts`) have six sections:

| Section | Controls |
| --- | --- |
| `tools` | `allow` / `ask` / `deny` lists, per-tool `effects` (`read` / `write` / `external`), `trustedPreHandlerTools` |
| `memory` | `enabled`, `scopes` (`public` / `user` / `agent_user`), `maxChars` |
| `delegation` | `allowedEmployees`, `maxDepth`, `maxCount` |
| `limits` | `timeoutMs`, `recursionLimit`, max invocations/tool calls/tokens/cost |
| `isolation` | `mode` (`none` / `worktree`), `requireWorktree`, `allowedConnectors`, `networkAccess` (`deny` / `restricted` / `allow`) |
| `observability` | `enabled`, `tracingRetentionDays`, `captureInputs`, `captureOutputs` |

### Layered compilation

`HarnessCompiler.compileHarness()` merges an ordered list of layers with most-restrictive-wins semantics: allow-lists and scopes are intersected, `ask`/`deny` are unioned, numeric limits take the minimum, booleans AND, network access takes the strictest value. For each run role, `LoopPatternService` stacks:

`platform` (hard ceilings) → `profile:<tag>@<version>` (published profile) → `pattern` → `employee:<username>` → per-run overrides.

The compiled result is persisted on the run as an immutable snapshot (`leaderHarnessSnapshot`, per-maker `makerHarnessSnapshot`, `verifierHarnessSnapshot`), so runs always execute against the policy that was in force at enqueue time.

### Tool planning

At invocation time, `PluginAiRuntimeAdapter` converts the compiled harness into a tool plan: `deny` > `ask` > `allow`. Tools not explicitly allowed become `ask`; allowed tools with `write`/`external` effects stay `ask` unless listed in `trustedPreHandlerTools`. `ask` tools are attached without auto-call so they interrupt for approval; unenforceable system tools (e.g. web search) are blocked at the source.

### Versioning

`HarnessProfileService` manages draft/publish lifecycle over `agentHarnessProfileVersions`: create draft → update draft → publish (points the profile's `currentVersionId` at the published version). One open draft per profile — `saveDraft` writes into the latest unpublished draft and only starts a new version once the previous one shipped, keeping the version history a clean publish trail. `createProfile` bootstraps a profile together with its first published version atomically, and version numbering is row-locked so concurrent saves/publishes cannot collide. Published versions are immutable. Profiles are resolved by tag via `getPublishedByTag(tag)`. Seeded profiles: `default`, `safe`, `file-heavy`.

## Skill Hub

### Skills

A skill (`skillDefinitions`) is a sandboxed Python or Node.js code unit with:

- immutable `toolName`, `title`, `description`, `instructions`;
- `codeTemplate` with `{{placeholder}}` rendering and a JSON Schema `inputSchema`;
- optional `interactionSchema` for human-in-the-loop review UI;
- `packages`, `timeoutSeconds`, `maxOutputSizeMb`, `enabled`, `autoCall`;
- `toolScope` (`CUSTOM` / `GENERAL` / `SPECIFIED`) controlling visibility across AI employees;
- storage source: database (zip upload), local, s3, plugin template, or Git.

### Execution

`skill_hub_execute` and per-skill `skill_hub_<toolName>` tools validate input, check per-agent access (`SkillAccessService`), apply a per-user rate limit, create a `skillExecutions` row, and publish `skill-hub.task`. Sandbox workers claim executions, render and validate the code, run it in a sandbox, stream progress, and store stdout/stderr/output files (downloadable via `skillHub:download`). A poller recovers stale executions. Executions link into the tracing graph via `agentExecutionSpans` (span type `skill`).

### MCP surface

The Skill Hub exposes an MCP-style server surface: `skillHub:mcpListTools` lists enabled skills as `{name, description, inputSchema}` tools; `skillHub:mcpCallTool` executes one and returns MCP content (including a file manifest).

### Import and registry

- **Git import**: `gitListSkills` / `gitSyncSkills` read a `skills.json` manifest and `SKILL.md` frontmatter through plugin-git-manager (optional peer dependency).
- **Registry**: `RegistrySkillInstallationService` installs registry package versions into local `skillDefinitions` (disabled by default, with rollback chain), and `RegistrySkillSnapshotService` exports opt-in snapshots of local skills for an external registry plugin.

### Human-in-the-loop review

`skillLoopConfigs` stores review templates (prompt + schema) per skill; the chat UI renders approval cards for skill executions that require review.

## External RAG Search

The plugin registers the `external_rag_search` tool so leaders and sub-agents can retrieve context from NocoBase knowledge bases, including external RAG services. Source ownership stays in NocoBase; chunking, embedding, vector storage, and retrieval live in an external lightweight RAG service. The tool calls `plugin-knowledge-base.searchKnowledgeBases()`, so access control and mixed local/external search stay centralized.

Knowledge bases of type `EXTERNAL_RAG` carry options such as `ragProvider` (`external-http` or `e5-http`), `ragApiUrl`, `ragApiKey`, `ragNamespace`, `ragTopK`, `ragScoreThreshold`.

### External search contract

The built-in `external-http` strategy expects:

```http
POST /search
Authorization: Bearer <ragApiKey>
Content-Type: application/json
```

```json
{
  "query": "search text",
  "topK": 5,
  "scoreThreshold": 0.3,
  "namespace": "optional-kb-namespace",
  "filter": {}
}
```

Response:

```json
{
  "results": [
    {
      "id": "chunk-or-source-id",
      "content": "matched text",
      "score": 0.82,
      "metadata": {
        "fileId": "123",
        "filename": "contract.pdf",
        "collection": "orders",
        "recordId": "456",
        "sourceUrl": "/api/attachments/123:download"
      }
    }
  ]
}
```

Every result must return enough metadata for NocoBase to resolve the original source: `fileId`/`filename` for files, or `collection`/`recordId` for datasource records.

For E5-family models behind an OpenAI-compatible `/v1/embeddings` API, use `ragProvider: "e5-http"`: queries are embedded as `query: <question>`, chunks as `passage: <chunk>`, and the vector collection must be recreated when the model or vector dimensions change.

## UI

Settings pages under **AI Employee → Agent Orchestrator** (both v1 client and client-v2):

| Tab | Purpose |
| --- | --- |
| Native Monitor | Loop run list with status, budgets, approvals |
| Execution Tracing | Span tree of sub-agent and tool executions |
| Policy Profiles | Harness profile CRUD with draft/publish versioning and version history |
| Approvals | Pending tool-call/escalation approvals; approve or reject with optional edited input |
| Agent Bindings | Leader↔sub-agent binding configuration |
| Knowledge Access | Per-agent knowledge base access matrix |
| Retrieval Trace | Retrieval tracing for knowledge lookups |
| Memory Inspector | Inspect agent memory context records |
| Skill Hub Definitions | Skill CRUD, editor, test panel, Git import |
| Execution History | Skill execution logs and output files |
| Skill Review Settings | Human-in-the-loop review templates |
| Metrics | Skill usage metrics |

## API Resources

- `agentLoops` — list, get, runNow, pause, resume, cancel, retry, escalate, acceptResult, status
- `agentLoopApprovals` — list, get, decide
- `agentLoopArtifactsView` — list, get
- `agentLoopEventsStream` — stream
- `agentMonitor` — list, get, sync
- `agentKnowledgeInsights` — accessMatrix, retrievalTrace, memoryPreview
- `orchestratorTracing` — list, get
- `skillHub` — download, test, initEnv, clearStorage, mcpListTools, mcpCallTool, listTemplates, gitListSkills, gitSyncSkills
- `agentHarnessProfiles` — standard CRUD plus listVersions, saveDraft, publish, createProfile, validate
- Standard CRUD on `skillDefinitions`, `skillExecutions`, `agentMemoryContexts`, and related collections

## Collections

Agent loops: `agentLoopPatterns`, `agentLoopRuns`, `agentLoopSteps`, `agentLoopEvents`, `agentLoopActionApprovals`, `agentLoopArtifacts`, `agentLoopCircuitStates`, `agentLoopControlSettings`, `agentLoopPathLocks`, `agentLoopUsageBuckets`, `agentLoopWorktrees`.

Harness: `agentHarnessProfiles`, `agentHarnessProfileVersions`.

Observation/memory: `agentExecutionSpans`, `orchestratorConfig`, `orchestratorLogs`, `agentMemoryContexts`.

Skill Hub: `skillDefinitions`, `skillExecutions`, `skillLoopConfigs`, `skillWorkerConfigs`, `skillRegistryInstallations`.

## Usage

1. Enable the plugin in the NocoBase Plugin Manager (requires plugin-ai; plugin-git-manager is optional for Git skill import).
2. Configure **Policy Profiles** (harness tags) for your risk levels — the seeded `default`, `safe`, and `file-heavy` profiles are a starting point.
3. For sub-agent delegation: configure leader↔sub-agent bindings in **Agent Bindings**, add the built-in **AI employee task dispatching** (`dispatch-sub-agent-task`) tool to the leader, and ensure the user role can access both employees.
4. For autonomous loops: create a pattern (goal, autonomy level, trigger, roles, harness tags, policy), then trigger runs manually, by cron, or by event; monitor runs in **Native Monitor** and resolve approvals/verification escalations there.
5. For skills: define skills in **Skill Hub Definitions** (or import from Git/registry), test them with the test panel, then bind the generated `skill_hub_*` tools to AI employees.

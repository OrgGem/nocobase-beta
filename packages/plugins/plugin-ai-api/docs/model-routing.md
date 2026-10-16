# Model routing implementation

## Tasks

| Task | Implementation | Regression coverage |
| --- | --- | --- |
| 1. Candidate eligibility | Combine permissions, enabled metadata, tools, vision, structured output and reasoning parameters; apply the same checks to fallback | Unsupported flags, disabled metadata, combined capabilities, permission scope |
| 2. Current-task classification | Latest user/human task, continuation anchors, Vietnamese/Chinese keywords, execution/recovery/synthesis signals, optional classifier in both directions | Fresh simple tasks, tools with reasoning, repeated failures, classifier correction and failure |
| 3. Context selection | Try every eligible candidate with complete history before allowing truncation; account for schemas and tool arguments | Larger context candidate, reject/truncate, newest turn overflow, complete tool pairs |
| 4. Gateway output | Join text/output_text blocks, preserve reasoning, distinguish tool-only output from empty provider completions | Streaming/non-streaming text, reasoning, tool calls, empty and length-limited output |
| 5. Configuration and diagnostics | Nullable capability declarations in client-v2 metadata, localized guidance, routing rejection/context/output metrics | Metadata validation and locale parity |

## Selection policy

Hard capability rules come first. A request carrying an image is served by the vision list, a
request carrying tools (unless `tool_choice=none`) by the tools list, and a request requiring
structured output by the general list. Only when none of those apply does complexity decide, and
only then to place the reasoning bucket as a fallback behind the selected capability group.

A positive reasoning effort is a thinking-level request, not a bucket selector: it is forwarded to
the provider with the model call. An explicit `none` prevents heuristic reasoning escalation; an
empty reasoning object is not a request for stronger reasoning.

Light mechanical work uses the configured cheap list. When the admin expressed no general
preference, a cheap bucket is derived from metadata, otherwise general is used. General excludes the
reasoning tier by design, so a plain request can not silently inherit a reasoning model.

Complex requests start with reasoning candidates, or with the applicable capability group that
outranked them, and can then try reasoning, general candidates, and finally the configured
fallback. Every list remains ordered by the administrator. Derived lists preserve metadata
sortOrder. No eligible model means an explicit error, never silent removal of a capability or
permission bypass.

Explicit capability `false` always excludes a candidate for requests requiring that capability. Unknown tools,
vision or reasoning-parameter support may be declared by membership in the respective administrator list.
Reasoning-tier metadata can also declare reasoning-parameter support unless explicitly disabled. Structured-output
support must be explicitly confirmed in metadata; it is not inferred from a model name or general-list membership.

Hidden models stay routable. A metadata override with **Hidden from model list** set is omitted from
`GET /v1/models` and `GET /v1/models/:model`, but remains a candidate for virtual aliases when a routing rule
selects it — unlike `enabled: false`, which also removes the model from routing. Use `enabled: false` to retire a
model, and `hidden` to keep it reachable only through automatic routing.

## Prompt-cache cost optimization

Routing also optimizes cost without changing the tier decision. Candidates inside the selected
group are ranked by `aiApiModelPrices.cacheInputPricePerMillionTokens` from the currently effective
price row, cheapest first, so a repeated prefix is served by the model with the cheapest cache
reads. Ranking never crosses groups: a cheap general model cannot displace reasoning for a
classified complex task. Candidates without a configured cache price stay usable and keep their
configured order at the end of the list. Prices are read in one query per request and skipped
entirely when no group holds more than one candidate.

Classification results are cached for 10 minutes under a key of alias, classifier model, caller and
task text. Repeated turns of a tool loop replay the same task, so this avoids paying for the same
classification repeatedly. Only explicit boolean verdicts are cached — every classifier failure
returns undefined and is retried on the next request. Recovery always escalates and bypasses the
cache. Saving or deleting a virtual alias clears the cache. The cache is per process and is not
synchronized between nodes.

## Task evidence

Generic system/developer instructions and earlier unrelated user tasks do not contribute to keyword/length
classification. Tool continuations retain the latest user task. A short `continue`, `tiếp tục` or `继续` message
reuses the preceding task. Repeated structured tool failures escalate recovery; an arbitrary occurrence of the word
"error" in tool data does not. Phase detection is heuristic, not a persistent agent state machine.

The optional classifier can correct both false positives and false negatives. It sees the task and bounded recent
tool evidence, with the beginning and end retained for long input. It runs regardless of any reasoning effort,
because an effort expresses a thinking level rather than a verdict on model class; only an explicit `none` skips it.
Timeout, unparseable output and provider failures retain the heuristic. The classifier must be accessible to the
caller and cannot use disabled metadata. Classifier invocations still incur provider cost; gateway completion
usage continues to describe the main completion, not the optional classification call.

Responses requests route using processed attachments and the full `previous_response_id` history. Provider-specific
encrypted/signed reasoning cannot be transferred freely: automatic continuation stays on the previous concrete model
when its provenance is known. Stateless automatic requests carrying opaque reasoning require a concrete model instead.
This constraint does not allow a previous model to bypass current permissions or capabilities.

## Context and output

Selection checks complete history first. Only when all eligible candidates fail does it try the configured overflow
policy. Truncation removes complete oldest user/human turns, retains system/developer messages and keeps the newest
turn intact with its tool calls/results. It does not summarize discarded history. A newest turn that cannot fit is
rejected. Missing model context metadata uses the existing gateway defaults; these are estimates, not provider guarantees.

Output reservation is also applied as the provider's default maxTokens when the client did not supply a limit.
Diagnostics include original/retained input estimates, output reservation, dropped message/turn counts, selected model,
rejected candidates and whether text/tools/reasoning were received. Prompt content and tool-result bodies are not logged.

Tool-only and reasoning-only completions remain valid. Empty output without a provider incomplete/length reason returns
`empty_completion`: HTTP 502 before streaming, or a failed SSE result once streaming started. Provider finish reasons are
retained. No model retry or switch occurs after provider execution begins, avoiding mixed output and duplicate tool calls.

## Configuration rollout

1. Build the plugin and run the application's normal `yarn nocobase upgrade` to sync the two new nullable metadata columns.
2. In client-v2 Model metadata, confirm **Supports structured output** for models that accept JSON/schema requests.
3. Confirm **Supports reasoning parameters** or use reasoning-tier/list declarations where appropriate. Explicit unsupported
   values override list membership.
4. Ensure reasoning candidates also declare tools/vision support when those capabilities are used together.
5. Set context/output limits to the actual provider limits and inspect routing diagnostics for rejected candidates.

No new migration is required for these additional columns under the repository's automatic schema-sync convention.
No database upgrade or runtime configuration change is performed by this source change.

## Scope

Automatic routing applies to direct LLM Chat Completions and Responses aliases. Concrete model requests preserve the
client's model choice. Embedding aliases retain their separate fallback flow. Native AI Employee agent mode still uses
its concrete model and upstream runtime; its internal model switching and SSE protocol are not modified here.

Provider capability declarations require administrative verification. Offline tests cannot prove current provider
availability, actual model quality or exact tokenization. Live validation should exercise a planning/tools/synthesis
conversation, a combined vision/tools/schema request, and a long-context continuation with the configured providers.

# Selector Registry

Self-healing UI selector registry for web automation. Automation clients (for example UiPath robots) send the selector they currently hold — plus a snapshot of the page HTML when something breaks — and the registry returns a trusted, repaired selector. Good selectors are cached and reused; bad ones are degraded, quarantined, or rolled back automatically.

- **Resolve & self-heal**: a layered pipeline repairs drifted selectors — exact cache → registry lookup → heuristics → LLM (via `@nocobase/plugin-ai`).
- **Feedback lifecycle**: clients report success/failure after every action; confidence is tracked (EWMA), entries move `probation → active → degraded → quarantined`, and auto-rollback restores the last proven selector.
- **Safety**: element signatures verify the located element, a circuit breaker stops heal storms, idempotency keys deduplicate retries, and dry-run/preview modes never mutate live state.
- **Admin UI**: dashboard, apps, entries, resolve logs, feedbacks, settings, and a built-in API reference tab (Settings → Selector Registry).

## How it works

```
UiPath robot                          Selector Registry (this plugin)
────────────                          ───────────────────────────────
1. read local cache [workflowId:stepId]
2. cache miss ──── POST selectorRegistry:resolve ────► L1 exact cache (fingerprint)
                                                       L2 registry lookup / bootstrap
                                     ◄── selector + version + signature
3. save to local cache, run the action
4. action fails (element not found)
   retry ──────── POST selectorRegistry:resolve ────► L3 heuristic repair
                 (failureType + domSnippet)           L4 LLM repair (optional)
                                     ◄── healed selector + fallbacks + signature
5. update local cache, retry the action
6. always ─────── POST selectorRegistry:report ─────► confidence / lifecycle update
                 (outcome: success | fail | ...)
```

Resolution paths returned in `source`:

| source | meaning |
| --- | --- |
| `cache_hit` | The exact selector you sent is still trusted (L1). |
| `registry` | The trusted selector stored for this element (L2). |
| `heuristic` | Repaired by deterministic heuristics: id-drift anchors, segment re-anchoring, client candidates, text anchors (L3). |
| `llm` | Repaired by the configured LLM service (L4). |
| `miss` | Nothing known yet; fall back to your workflow's default selector. |
| `skipped` | Healing was skipped (unhealable failure type, circuit breaker open, dry-run app). |

Entry lifecycle: `probation` → (repeated success) → `active` → (fail streaks) → `degraded` → `quarantined`. `disabled` entries are hidden from clients; `pinned` entries are never auto-changed.

## Installation

Build and pack from the repository root (PowerShell on Windows):

```powershell
yarn nocobase build plugin-selector-registry --no-dts
Set-Location packages/plugins/plugin-selector-registry
npm pack
```

Then install the produced `plugin-selector-registry-*.tgz` in your NocoBase app and enable the plugin. LLM healing additionally requires `@nocobase/plugin-ai` with a configured model service; without it, heuristic healing still works.

## Quick start

1. **Register your application** — Settings → Selector Registry → Apps → Create. The `name` you choose is the `app` value used in every API call.
2. **Create an API key** for your robot with a role that holds the `pm.selector-registry.client` ACL snippet.
3. **Call `resolve` before each action** and `report` after each action (see below).
4. Optionally run `bulkLookup` at the start of a run to delta-sync a local cache that covers many steps.

### ACL snippets

| snippet | grants |
| --- | --- |
| `pm.selector-registry.client` | `selectorRegistry:resolve`, `selectorRegistry:report`, `selectorRegistry:bulkLookup` |
| `pm.selector-registry.read` | Admin reads: `getSettings`, `stats`, plus `list`/`get` on all registry collections |
| `pm.selector-registry.manage` | Everything in `client` and `read`, plus admin mutations and `create`/`update`/`destroy` on all registry collections |

All endpoints are standard NocoBase resource actions: `POST /api/<resource>:<action>` with the API key in the `Authorization` header (`Bearer <key>`), JSON body.

## UiPath integration pattern (local cache + retry)

Recommended flow for robots that run many workflows/steps and keep a local selector cache keyed by `workflowId:stepId`:

1. Use `elementKey = "{workflowId}:{stepId}"` — the same stable key for your local cache and for the registry. Never build it from dynamic values.
2. **Before an action**: read your local cache. On a miss, call `resolve` (no `failureType`) to bootstrap/fetch, then store the returned `selector` + `version`.
3. **Run the action.** If it fails with a selector error, capture the page HTML around the element and retry once via `resolve` with `failureType` + `domSnippet` (+ `idempotencyKey = "{runId}:{stepId}"` so duplicate retries do not double-heal). Store the healed selector back into your local cache.
4. **After every action** call `report` with the outcome. This feedback loop is required for the system to stabilise: without it, healed selectors stay on probation forever.
5. When `resolve` returns `source: "miss"` with no selector, fall back to your workflow's default selector.
6. At the start of a run, `bulkLookup` refreshes all cached steps in one call — only changed entries come back.
7. Prefer sending the region around the element instead of a huge page; snippets above `domSnippetMaxChars` (default 20000) are trimmed.

## API reference

The same reference is available inside the app: Settings → Selector Registry → API Reference.

### Client (automation bot) endpoints

Called by automation clients (for example UiPath robots) over HTTP with an API key. These endpoints use the `client` ACL snippet and are designed to be called on every action and on failure/retry.

#### POST `selectorRegistry:resolve` — Resolve / self-heal a selector

Returns the trusted selector for an element, and repairs it when a failure is reported.

This is the main endpoint. Call it before an action to get the selector to use (lookup path), and call it again after a failure with the page HTML to trigger self-healing (heal path). Without `failureType` it looks up or bootstraps the entry. With a healable `failureType` plus a `domSnippet`, it runs the repair pipeline (heuristics, then LLM) and returns a corrected selector together with fallbacks and a signature. Send `idempotencyKey` so duplicate retries do not double-heal.

Auth: requires the `client` capability (snippet `pm.selector-registry.client`). Typically an automation bot authenticated by API key.

Request body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `app` | string | yes | Registered application name the element belongs to. |
| `elementKey` | string | — | Stable identity of the element. Provide either `elementKey` or `logicalId`. Use a stable value such as `workflowId:stepId`. |
| `logicalId` | string | — | Human-readable logical id. Hashed with app and page into the `elementKey` when `elementKey` is not given. |
| `name` | string | — | Optional display name stored on the entry. |
| `pageUrlPattern` | string | — | Stable page identity used when deriving the `elementKey`. Keep it stable; do not include dynamic URL parts. |
| `selector` | string | — | The selector the client currently holds or used. Used for the cache hit check and as the starting point for healing. |
| `selectorType` | `css \| xpath \| text \| aria` | — | Selector type. Defaults to `css`. Only CSS selectors can be validated server-side. |
| `failureType` | `not_found \| ambiguous \| stale \| not_interactable \| page_error \| unknown` | — | Present to report a failure and trigger healing. `not_interactable` and `page_error` are treated as dirty evidence and never heal. |
| `errorMessage` | string | — | Optional error text from the automation client, used for logging and LLM context. |
| `domSnippet` | string | — | HTML snapshot of the page (or the region around the element). Required for healing. Large pages are trimmed to the configured limit. |
| `candidates` | array | — | Optional client-provided candidates: `{ selector }` or `{ tag, attrs }` or `{ text }`. Validated and ranked during healing. |
| `triedSelectors` | array | — | Optional selectors already attempted, so they are not suggested again. |
| `agentId` | string | — | Optional identifier of the bot/agent making the request. |
| `idempotencyKey` | string | — | Optional key (for example `runId:stepId`) to reuse a recent identical response and avoid duplicate heals. |

Response: the resolved selector and metadata — `source` (`cache_hit | registry | heuristic | llm | miss | skipped`), `selector`, `selectorType`, `version`, `status`, `confidence`, `healTriggered`, `fallbacks` (previous selectors to try), and `signature` (to verify the element client-side). When `source` is `miss` and no selector is known, fall back to your workflow default selector.

Example request:

```json
{
  "app": "crm",
  "elementKey": "wf-checkout:step-submit",
  "selector": "#btn-submit-1234",
  "selectorType": "css",
  "failureType": "not_found",
  "domSnippet": "<html>...<button id=\"btn-submit-9999\" data-testid=\"submit\">Submit</button>...</html>",
  "agentId": "uipath-bot-1",
  "idempotencyKey": "run-42:step-submit"
}
```

Example response:

```json
{
  "elementKey": "wf-checkout:step-submit",
  "selector": "[id^=\"btn-submit\"]",
  "selectorType": "css",
  "source": "heuristic",
  "status": "probation",
  "version": 2,
  "confidence": 0.7,
  "healTriggered": true,
  "fallbacks": [{ "selector": "#btn-submit-1234", "selectorType": "css" }],
  "signature": {
    "tag": "button",
    "stableAttrs": { "data-testid": "submit" },
    "textSample": "Submit",
    "textHash": "9f03…"
  }
}
```

#### POST `selectorRegistry:report` — Report action outcome (feedback)

Reports whether the selector worked, so the registry can learn and stabilise.

Call this after every action with the outcome. This feedback loop is required for the system to stabilise: successes raise confidence and promote `probation` entries to `active`; failures lower confidence and can degrade, quarantine, or auto-rollback to the last proven selector. Without reporting, healed selectors stay on probation and the registry cannot learn.

Auth: requires the `client` capability (snippet `pm.selector-registry.client`).

Request body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `app` | string | yes | Registered application name. |
| `elementKey` | string | yes | The element identity returned by resolve. |
| `outcome` | `success \| fail \| verified \| mismatch` | yes | What happened when the selector was used. `verified`/`mismatch` come from signature verification. |
| `selectorUsed` | string | — | The selector actually used, to attribute the outcome to the right version. |
| `failureType` | string | — | If outcome is fail/mismatch, the type of failure. |
| `signatureMatch` | boolean | — | Whether the located element matched the stored signature. |
| `errorMessage` | string | — | Optional error text. |
| `agentId` | string | — | Optional bot/agent identifier. |
| `runId` | string | — | Optional run/execution identifier. |

Response: the updated entry summary (`status`, `confidence`, `version`). Check the entry status to know if it was promoted, degraded, or rolled back.

Example request:

```json
{
  "app": "crm",
  "elementKey": "wf-checkout:step-submit",
  "outcome": "success",
  "selectorUsed": "[id^=\"btn-submit\"]",
  "signatureMatch": true,
  "agentId": "uipath-bot-1",
  "runId": "run-42"
}
```

Example response:

```json
{
  "elementKey": "wf-checkout:step-submit",
  "status": "active",
  "confidence": 0.81,
  "version": 2
}
```

#### POST `selectorRegistry:bulkLookup` — Bulk lookup / delta sync

Syncs a local cache efficiently: send what you have, receive only what changed.

Use this at the start of a run to refresh a local cache that covers many steps at once, instead of calling resolve per step. Send the `elementKey`s and versions currently cached; the registry replies with the entries that changed (`updates`), the keys it does not know (`unknown`), and a count of entries that are unchanged. Apply `updates` to your local cache and keep your own value for `unknown`.

Auth: requires the `client` capability (snippet `pm.selector-registry.client`).

Request body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `app` | string | yes | Registered application name. |
| `items` | array | yes | List of `{ elementKey, version? }` currently held in the local cache. Up to 500 items per call. |

Response: `{ app, updates, unknown, unchanged }`. `updates` is a list of full entry payloads (same shape as resolve responses); `unknown` lists elementKeys the registry does not know; `unchanged` is a count.

Example request:

```json
{
  "app": "crm",
  "items": [
    { "elementKey": "wf-checkout:step-submit", "version": 2 },
    { "elementKey": "wf-checkout:step-email" }
  ]
}
```

Example response:

```json
{
  "app": "crm",
  "updates": [
    {
      "elementKey": "wf-checkout:step-email",
      "selector": "input[name=\"email\"]",
      "selectorType": "css",
      "source": "registry",
      "version": 3,
      "status": "active",
      "confidence": 0.9
    }
  ],
  "unknown": ["wf-checkout:step-submit"],
  "unchanged": 0
}
```

### Admin endpoints

Used by the administration UI and by operators. Read actions need the `read` snippet; mutating actions need the `manage` snippet.

#### POST `selectorRegistryAdmin:getSettings` — Get settings

Returns the effective settings object, including defaults for any value that has not been overridden. Use it to populate a settings form.

Auth: requires the `read` capability (snippet `pm.selector-registry.read`). No request body. Returns the full settings object (see the settings table below).

#### POST `selectorRegistryAdmin:updateSettings` — Update settings

Send only the fields to change; unspecified fields keep their current value. Numeric fields must be finite and non-negative. The full list of settings and their meaning is in the settings table below.

Auth: requires the `manage` capability (snippet `pm.selector-registry.manage`).

Example request:

```json
{ "confidenceThreshold": 0.7, "llmService": "openai", "llmModel": "gpt-4o-mini" }
```

#### POST `selectorRegistryAdmin:stats` — Dashboard statistics

Returns totals by status, app count, recent resolve path distribution with cache-hit rate, recent feedback outcomes, and the top failing entries. This powers the Dashboard tab.

Auth: requires the `read` capability. No request body. Returns `{ entries, apps, recentResolves, recentFeedback, topFailing }`.

#### POST `selectorRegistryAdmin:revalidate` — Revalidate (dry-run preview)

Re-runs the healing pipeline for a single entry in forced dry-run mode. It never mutates the entry, never consumes circuit-breaker budget, and never degrades. Use it to judge whether a heal is safe before applying it. The computed candidate is returned in `dryRunCandidate`. Provide a fresh `domSnippet` for the best preview.

Auth: requires the `manage` capability.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `entryId` | number | yes | The id of the selector entry to revalidate. |
| `domSnippet` | string | — | Optional fresh HTML snapshot to heal against. |
| `candidates` | array | — | Optional client-style candidates to include in the preview. |

Returns a resolve-shaped response with `dryRunCandidate` describing the selector that would be applied. The live entry is unchanged.

#### POST `selectorRegistryAdmin:rollbackVersion` — Roll back to a version

Promotes any historical version of an entry to be the current selector. The previously active version is marked superseded, the entry status becomes `active` with full confidence, and `resolvedBy` is set to `manual`. Use it when automatic healing chose poorly and you know a previous version was correct.

Auth: requires the `manage` capability.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `entryId` | number | yes | The id of the selector entry. |
| `versionId` | number | yes | The id of the selector version to promote. Must belong to the entry. |

Returns `{ entryId, versionId, selector, selectorType, version, status }` for the newly promoted selector.

#### POST `selectorRegistryAdmin:pruneLogs` — Prune logs

Removes `selectorResolveLogs` and `selectorFeedbacks` older than the configured `logRetentionDays`. A scheduled job also runs this automatically (hourly, at :30); this endpoint triggers it on demand. If retention is 0 or unset, nothing is removed.

Auth: requires the `manage` capability. No request body. Returns `{ removedResolveLogs, removedFeedbacks }`.

### Collection resources

These collections are also exposed as standard NocoBase resources supporting `list`, `get`, `create`, `update` and `destroy`. Reading needs the `read` snippet; writing needs the `manage` snippet.

| Collection | Description |
| --- | --- |
| `selectorApps` | Registered automation applications. |
| `selectorEntries` | One row per logical element: current selector, status, confidence, counters. |
| `selectorVersions` | History of selectors applied to each entry. |
| `selectorResolveLogs` | Audit log of every resolve request and response. |
| `selectorFeedbacks` | Audit log of every reported outcome. |

### Error responses

Errors use the platform shape `{ "errors": [{ "code", "message" }] }` with an appropriate HTTP status:

| code | status | meaning |
| --- | --- | --- |
| `REGISTRY_DISABLED` | 503 | The registry master switch (`enabled`) is off. |
| `MISSING_APP` | 400 | The `app` field is missing/empty. |
| `APP_NOT_FOUND` | 404 | The app is not registered. |
| `APP_INACTIVE` | 403 | The app exists but is not active. |
| `ELEMENT_KEY_REQUIRED` | 400 | Neither `elementKey` nor `logicalId` was provided (or `elementKey` missing on `report`). |
| `INVALID_OUTCOME` | 400 | `outcome` is not one of `success \| fail \| verified \| mismatch`. |
| `MISSING_ITEMS` | 400 | `bulkLookup` called without the `items` array. |
| `NOT_FOUND` | 400/404 | Invalid or unknown `entryId`/`versionId` in admin actions. |
| `INTERNAL` | 500 | Unexpected server error. |

## Settings reference

| Setting | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Master switch. When false, resolve calls are rejected with `REGISTRY_DISABLED`. |
| `llmService` | `null` | LLM service name (from plugin-ai) used for L4 healing. Empty disables LLM healing. |
| `llmModel` | `null` | Model name passed to the LLM service. |
| `confidenceThreshold` | `0.6` | Confidence target used by the feedback lifecycle. |
| `quarantineThreshold` | `0.3` | Confidence below which an entry is quarantined. |
| `probationSuccessTarget` | `3` | Successes needed to promote a probation entry to active. |
| `failStreakLimit` | `3` | Consecutive failures before an entry is degraded. |
| `rollbackFailLimit` | `2` | Failures on a healed selector before auto-rollback to the previous version. |
| `circuitBreakerMaxHeals` | `3` | Max heals per entry within the breaker window before healing is skipped. |
| `circuitBreakerWindowMs` | `600000` | Sliding window for the per-entry heal budget. |
| `circuitBreakerCooldownMs` | `1800000` | Cooldown after the breaker trips. |
| `entryTtlMs` | `0` | Optional TTL for cache-hit trust (0 = no expiry). |
| `domSnippetMaxChars` | `20000` | Maximum DOM snippet size accepted for healing. |
| `logRetentionDays` | `30` | Resolve logs and feedbacks older than this are pruned (0 = keep forever). |
| `ewmaAlpha` | `0.25` | EWMA smoothing factor for confidence updates. |

## Development

```bash
# run the plugin test suite (server-side, sequential)
TEST_ENV=server-side node ./node_modules/vitest/vitest.mjs run packages/plugins/plugin-selector-registry --no-file-parallelism
```

The suite includes unit tests for the DOM analyzer, heuristic repair, resolve pipeline, feedback lifecycle, and admin actions, plus a live-website test that fetches `https://the-internet.herokuapp.com/login` and proves self-healing against real-world HTML (skipped automatically when the site is unreachable).

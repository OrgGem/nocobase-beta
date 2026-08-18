// Structured, single-source-of-truth catalog of every HTTP endpoint exposed by
// the Selector Registry plugin. The ApiDocsPage renders this catalog, and the
// README mirrors the same content. Prose fields are i18n keys (English text);
// `example*` fields are literal code and are never translated.

export type ApiFieldDoc = {
  name: string;
  type: string;
  required?: boolean;
  description: string;
};

export type ApiEndpointDoc = {
  id: string;
  method: 'POST' | 'GET';
  path: string;
  title: string;
  summary: string;
  description: string;
  auth: string;
  requestFields: ApiFieldDoc[];
  responseNote: string;
  exampleRequest?: string;
  exampleResponse?: string;
};

export type ApiDocSection = {
  id: string;
  title: string;
  intro: string;
  endpoints: ApiEndpointDoc[];
};

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

export const API_DOC_SECTIONS: ApiDocSection[] = [
  {
    id: 'client',
    title: 'Client (automation bot) endpoints',
    intro:
      'Called by automation clients (for example UiPath robots) over HTTP with an API key. These endpoints use the "client" ACL snippet and are designed to be called on every action and on failure/retry.',
    endpoints: [
      {
        id: 'resolve',
        method: 'POST',
        path: 'selectorRegistry:resolve',
        title: 'Resolve / self-heal a selector',
        summary: 'Returns the trusted selector for an element, and repairs it when a failure is reported.',
        description:
          'This is the main endpoint. Call it before an action to get the selector to use (lookup path), and call it again after a failure with the page HTML to trigger self-healing (heal path). Without "failureType" it looks up or bootstraps the entry. With a healable "failureType" plus a "domSnippet", it runs the repair pipeline (heuristics, then LLM) and returns a corrected selector together with fallbacks and a signature. Send "idempotencyKey" so duplicate retries do not double-heal.',
        auth: 'Requires the "client" capability (snippet pm.selector-registry.client). Typically an automation bot authenticated by API key.',
        requestFields: [
          {
            name: 'app',
            type: 'string',
            required: true,
            description: 'Registered application name the element belongs to.',
          },
          {
            name: 'elementKey',
            type: 'string',
            description:
              'Stable identity of the element. Provide either "elementKey" or "logicalId". Use a stable value such as "workflowId:stepId".',
          },
          {
            name: 'logicalId',
            type: 'string',
            description:
              'Human-readable logical id. Hashed with app and page into the elementKey when elementKey is not given.',
          },
          { name: 'name', type: 'string', description: 'Optional display name stored on the entry.' },
          {
            name: 'pageUrlPattern',
            type: 'string',
            description:
              'Stable page identity used when deriving the elementKey. Keep it stable; do not include dynamic URL parts.',
          },
          {
            name: 'selector',
            type: 'string',
            description:
              'The selector the client currently holds or used. Used for the cache hit check and as the starting point for healing.',
          },
          {
            name: 'selectorType',
            type: 'css | xpath | text | aria',
            description: 'Selector type. Defaults to "css". Only CSS selectors can be validated server-side.',
          },
          {
            name: 'failureType',
            type: 'not_found | ambiguous | stale | not_interactable | page_error | unknown',
            description:
              'Present to report a failure and trigger healing. "not_interactable" and "page_error" are treated as dirty evidence and never heal.',
          },
          {
            name: 'errorMessage',
            type: 'string',
            description: 'Optional error text from the automation client, used for logging and LLM context.',
          },
          {
            name: 'domSnippet',
            type: 'string',
            description:
              'HTML snapshot of the page (or the region around the element). Required for healing. Large pages are trimmed to the configured limit.',
          },
          {
            name: 'candidates',
            type: 'array',
            description:
              'Optional client-provided candidates: { selector } or { tag, attrs } or { text }. Validated and ranked during healing.',
          },
          {
            name: 'triedSelectors',
            type: 'array',
            description: 'Optional selectors already attempted, so they are not suggested again.',
          },
          { name: 'agentId', type: 'string', description: 'Optional identifier of the bot/agent making the request.' },
          {
            name: 'idempotencyKey',
            type: 'string',
            description:
              'Optional key (for example "runId:stepId") to reuse a recent identical response and avoid duplicate heals.',
          },
        ],
        responseNote:
          'Returns the resolved selector and metadata: "source" (cache_hit | registry | heuristic | llm | miss | skipped), "selector", "selectorType", "version", "status", "confidence", "healTriggered", "fallbacks" (previous selectors to try), and "signature" (to verify the element client-side). When "source" is "miss" and no selector is known, fall back to your workflow default selector.',
        exampleRequest: pretty({
          app: 'crm',
          elementKey: 'wf-checkout:step-submit',
          selector: '#btn-submit-1234',
          selectorType: 'css',
          failureType: 'not_found',
          domSnippet: '<html>...<button id="btn-submit-9999" data-testid="submit">Submit</button>...</html>',
          agentId: 'uipath-bot-1',
          idempotencyKey: 'run-42:step-submit',
        }),
        exampleResponse: pretty({
          elementKey: 'wf-checkout:step-submit',
          selector: '[id^="btn-submit"]',
          selectorType: 'css',
          source: 'heuristic',
          status: 'probation',
          version: 2,
          confidence: 0.7,
          healTriggered: true,
          fallbacks: [{ selector: '#btn-submit-1234', selectorType: 'css' }],
          signature: {
            tag: 'button',
            stableAttrs: { 'data-testid': 'submit' },
            textSample: 'Submit',
            textHash: '9f03…',
          },
        }),
      },
      {
        id: 'report',
        method: 'POST',
        path: 'selectorRegistry:report',
        title: 'Report action outcome (feedback)',
        summary: 'Reports whether the selector worked, so the registry can learn and stabilise.',
        description:
          'Call this after every action with the outcome. This feedback loop is required for the system to stabilise: successes raise confidence and promote "probation" entries to "active"; failures lower confidence and can degrade, quarantine, or auto-rollback to the last proven selector. Without reporting, healed selectors stay on probation and the registry cannot learn.',
        auth: 'Requires the "client" capability (snippet pm.selector-registry.client).',
        requestFields: [
          { name: 'app', type: 'string', required: true, description: 'Registered application name.' },
          {
            name: 'elementKey',
            type: 'string',
            required: true,
            description: 'The element identity returned by resolve.',
          },
          {
            name: 'outcome',
            type: 'success | fail | verified | mismatch',
            required: true,
            description:
              'What happened when the selector was used. "verified"/"mismatch" come from signature verification.',
          },
          {
            name: 'selectorUsed',
            type: 'string',
            description: 'The selector actually used, to attribute the outcome to the right version.',
          },
          { name: 'failureType', type: 'string', description: 'If outcome is fail/mismatch, the type of failure.' },
          {
            name: 'signatureMatch',
            type: 'boolean',
            description: 'Whether the located element matched the stored signature.',
          },
          { name: 'errorMessage', type: 'string', description: 'Optional error text.' },
          { name: 'agentId', type: 'string', description: 'Optional bot/agent identifier.' },
          { name: 'runId', type: 'string', description: 'Optional run/execution identifier.' },
        ],
        responseNote:
          'Returns the updated entry summary (status, confidence, version). Check the entry status to know if it was promoted, degraded, or rolled back.',
        exampleRequest: pretty({
          app: 'crm',
          elementKey: 'wf-checkout:step-submit',
          outcome: 'success',
          selectorUsed: '[id^="btn-submit"]',
          signatureMatch: true,
          agentId: 'uipath-bot-1',
          runId: 'run-42',
        }),
        exampleResponse: pretty({
          elementKey: 'wf-checkout:step-submit',
          status: 'active',
          confidence: 0.81,
          version: 2,
        }),
      },
      {
        id: 'bulkLookup',
        method: 'POST',
        path: 'selectorRegistry:bulkLookup',
        title: 'Bulk lookup / delta sync',
        summary: 'Syncs a local cache efficiently: send what you have, receive only what changed.',
        description:
          'Use this at the start of a run to refresh a local cache that covers many steps at once, instead of calling resolve per step. Send the elementKeys and versions currently cached; the registry replies with the entries that changed ("updates"), the keys it does not know ("unknown"), and a count of entries that are unchanged. Apply "updates" to your local cache and keep your own value for "unknown".',
        auth: 'Requires the "client" capability (snippet pm.selector-registry.client).',
        requestFields: [
          { name: 'app', type: 'string', required: true, description: 'Registered application name.' },
          {
            name: 'items',
            type: 'array',
            required: true,
            description:
              'List of { elementKey, version? } currently held in the local cache. Up to 500 items per call.',
          },
        ],
        responseNote:
          'Returns { app, updates, unknown, unchanged }. "updates" is a list of full entry payloads (same shape as resolve responses); "unknown" lists elementKeys the registry does not know; "unchanged" is a count.',
        exampleRequest: pretty({
          app: 'crm',
          items: [{ elementKey: 'wf-checkout:step-submit', version: 2 }, { elementKey: 'wf-checkout:step-email' }],
        }),
        exampleResponse: pretty({
          app: 'crm',
          updates: [
            {
              elementKey: 'wf-checkout:step-email',
              selector: 'input[name="email"]',
              selectorType: 'css',
              source: 'registry',
              version: 3,
              status: 'active',
              confidence: 0.9,
            },
          ],
          unknown: ['wf-checkout:step-submit'],
          unchanged: 0,
        }),
      },
    ],
  },
  {
    id: 'admin',
    title: 'Admin endpoints',
    intro:
      'Used by the administration UI and by operators. Read actions need the "read" snippet; mutating actions need the "manage" snippet.',
    endpoints: [
      {
        id: 'getSettings',
        method: 'POST',
        path: 'selectorRegistryAdmin:getSettings',
        title: 'Get settings',
        summary: 'Returns the current registry settings.',
        description:
          'Returns the effective settings object, including defaults for any value that has not been overridden. Use it to populate a settings form.',
        auth: 'Requires the "read" capability (snippet pm.selector-registry.read).',
        requestFields: [],
        responseNote:
          'Returns the full settings object (enabled, llmService, llmModel, thresholds, circuit breaker, retention, etc.).',
        exampleResponse: pretty({
          enabled: true,
          llmService: null,
          llmModel: null,
          confidenceThreshold: 0.6,
          probationSuccessTarget: 3,
          failStreakLimit: 3,
          domSnippetMaxChars: 20000,
          logRetentionDays: 30,
        }),
      },
      {
        id: 'updateSettings',
        method: 'POST',
        path: 'selectorRegistryAdmin:updateSettings',
        title: 'Update settings',
        summary: 'Updates registry settings.',
        description:
          'Send only the fields to change; unspecified fields keep their current value. Numeric fields must be finite and non-negative. The full list of settings and their meaning is documented on the Settings tab of this plugin.',
        auth: 'Requires the "manage" capability (snippet pm.selector-registry.manage).',
        requestFields: [
          {
            name: 'enabled',
            type: 'boolean',
            description: 'Master switch for the registry. When false, resolve calls are rejected.',
          },
          {
            name: 'llmService',
            type: 'string',
            description: 'LLM service name (from plugin-ai) used for L4 healing. Empty disables LLM healing.',
          },
          { name: 'llmModel', type: 'string', description: 'Model name passed to the LLM service.' },
          {
            name: 'confidenceThreshold',
            type: 'number',
            description: 'Confidence target used by the feedback lifecycle.',
          },
          {
            name: 'probationSuccessTarget',
            type: 'number',
            description: 'Successes needed to promote a probation entry to active.',
          },
          { name: 'domSnippetMaxChars', type: 'number', description: 'Maximum DOM snippet size accepted for healing.' },
          {
            name: '…',
            type: 'number',
            description: 'Other numeric settings (thresholds, circuit breaker, retention). See the Settings tab.',
          },
        ],
        responseNote: 'Returns the updated settings object.',
        exampleRequest: pretty({ confidenceThreshold: 0.7, llmService: 'openai', llmModel: 'gpt-4o-mini' }),
        exampleResponse: pretty({
          enabled: true,
          confidenceThreshold: 0.7,
          llmService: 'openai',
          llmModel: 'gpt-4o-mini',
        }),
      },
      {
        id: 'stats',
        method: 'POST',
        path: 'selectorRegistryAdmin:stats',
        title: 'Dashboard statistics',
        summary: 'Aggregate counts and recent activity for the dashboard.',
        description:
          'Returns totals by status, app count, recent resolve path distribution with cache-hit rate, recent feedback outcomes, and the top failing entries. This powers the Dashboard tab.',
        auth: 'Requires the "read" capability (snippet pm.selector-registry.read).',
        requestFields: [],
        responseNote: 'Returns { entries, apps, recentResolves, recentFeedback, topFailing }.',
        exampleResponse: pretty({
          entries: { total: 128, byStatus: { active: 90, probation: 20, degraded: 10, quarantined: 3, disabled: 5 } },
          apps: { total: 3 },
          recentResolves: {
            sampled: 500,
            byPath: { cache_hit: 320, registry: 120, heuristic: 40, llm: 10, miss: 10 },
            cacheHitRate: 0.73,
          },
          recentFeedback: { sampled: 200, byOutcome: { success: 180, fail: 20 } },
          topFailing: [
            { id: 7, elementKey: 'wf-checkout:step-submit', status: 'degraded', failCount: 12, confidence: 0.4 },
          ],
        }),
      },
      {
        id: 'revalidate',
        method: 'POST',
        path: 'selectorRegistryAdmin:revalidate',
        title: 'Revalidate (dry-run preview)',
        summary: 'Previews what self-healing would do for one entry, without changing live state.',
        description:
          'Re-runs the healing pipeline for a single entry in forced dry-run mode. It never mutates the entry, never consumes circuit-breaker budget, and never degrades. Use it to judge whether a heal is safe before applying it. The computed candidate is returned in "dryRunCandidate". Provide a fresh "domSnippet" for the best preview.',
        auth: 'Requires the "manage" capability (snippet pm.selector-registry.manage).',
        requestFields: [
          {
            name: 'entryId',
            type: 'number',
            required: true,
            description: 'The id of the selector entry to revalidate.',
          },
          { name: 'domSnippet', type: 'string', description: 'Optional fresh HTML snapshot to heal against.' },
          {
            name: 'candidates',
            type: 'array',
            description: 'Optional client-style candidates to include in the preview.',
          },
        ],
        responseNote:
          'Returns a resolve-shaped response with "dryRunCandidate" describing the selector that would be applied. The live entry is unchanged.',
        exampleRequest: pretty({
          entryId: 7,
          domSnippet: '<html>...<button id="btn-submit-9999">Submit</button>...</html>',
        }),
        exampleResponse: pretty({
          source: 'registry',
          selector: '#btn-submit-1234',
          healTriggered: true,
          dryRunCandidate: { selector: '[id^="btn-submit"]', selectorType: 'css', source: 'heuristic' },
        }),
      },
      {
        id: 'rollbackVersion',
        method: 'POST',
        path: 'selectorRegistryAdmin:rollbackVersion',
        title: 'Roll back to a version',
        summary: 'Manually promotes a historical selector version to active.',
        description:
          'Promotes any historical version of an entry to be the current selector. The previously active version is marked superseded, the entry status becomes "active" with full confidence, and "resolvedBy" is set to "manual". Use it when automatic healing chose poorly and you know a previous version was correct.',
        auth: 'Requires the "manage" capability (snippet pm.selector-registry.manage).',
        requestFields: [
          { name: 'entryId', type: 'number', required: true, description: 'The id of the selector entry.' },
          {
            name: 'versionId',
            type: 'number',
            required: true,
            description: 'The id of the selector version to promote. Must belong to the entry.',
          },
        ],
        responseNote:
          'Returns { entryId, versionId, selector, selectorType, version, status } for the newly promoted selector.',
        exampleRequest: pretty({ entryId: 7, versionId: 3 }),
        exampleResponse: pretty({
          entryId: 7,
          versionId: 3,
          selector: '#btn-submit-1234',
          selectorType: 'css',
          version: 4,
          status: 'active',
        }),
      },
      {
        id: 'pruneLogs',
        method: 'POST',
        path: 'selectorRegistryAdmin:pruneLogs',
        title: 'Prune logs',
        summary: 'Deletes resolve logs and feedback older than the retention window.',
        description:
          'Removes selectorResolveLogs and selectorFeedbacks older than the configured "logRetentionDays". A scheduled job also runs this automatically; this endpoint triggers it on demand. If retention is 0 or unset, nothing is removed.',
        auth: 'Requires the "manage" capability (snippet pm.selector-registry.manage).',
        requestFields: [],
        responseNote: 'Returns { removedResolveLogs, removedFeedbacks }.',
        exampleResponse: pretty({ removedResolveLogs: 1240, removedFeedbacks: 380 }),
      },
    ],
  },
];

// Standard NocoBase collection resources managed through the data source. The
// manage snippet gates create/update/destroy; the read snippet gates list/get.
export const COLLECTION_RESOURCES = [
  { name: 'selectorApps', purpose: 'Registered automation applications.' },
  { name: 'selectorEntries', purpose: 'One row per logical element: current selector, status, confidence, counters.' },
  { name: 'selectorVersions', purpose: 'History of selectors applied to each entry.' },
  { name: 'selectorResolveLogs', purpose: 'Audit log of every resolve request and response.' },
  { name: 'selectorFeedbacks', purpose: 'Audit log of every reported outcome.' },
];

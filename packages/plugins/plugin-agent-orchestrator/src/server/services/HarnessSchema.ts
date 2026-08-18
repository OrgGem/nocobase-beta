import { z } from 'zod';

export const toolDecisionSchema = z.enum(['allow', 'ask', 'deny']);
export const toolEffectSchema = z.enum(['read', 'write', 'external']);

const nullableLimit = z.number().finite().nonnegative().nullable().default(null);
const nullablePositiveLimit = z.number().finite().positive().nullable().default(null);

export const harnessSettingsSchema = z
  .object({
    tools: z
      .object({
        allow: z.array(z.string().min(1)).default([]),
        ask: z.array(z.string().min(1)).default([]),
        deny: z.array(z.string().min(1)).default([]),
        // Tools the harness does not grant but may be requested for a single call: invoking one
        // interrupts exactly like `ask` and parks the run, but the approval row is tagged as an
        // escalation. Approving widens authority for that one call only; the harness is unchanged.
        escalate: z.array(z.string().min(1)).default([]),
        effects: z.record(toolEffectSchema).default({}),
        trustedPreHandlerTools: z.array(z.string().min(1)).default([]),
        // Per-tool wall-clock caps in milliseconds. Only enforceable where this plugin owns the
        // execution pipeline (skill hub sandbox); elsewhere it is advisory observability data.
        timeouts: z.record(z.number().int().positive()).default({}),
      })
      .default({}),
    memory: z
      .object({
        enabled: z.boolean().default(true),
        scopes: z.array(z.enum(['public', 'user', 'agent_user'])).default(['public', 'user', 'agent_user']),
        maxChars: z.number().int().min(500).max(20_000).default(6000),
      })
      .default({}),
    delegation: z
      .object({
        allowedEmployees: z.array(z.string().min(1)).default([]),
        maxDepth: z.number().int().nonnegative().nullable().default(null),
        maxCount: z.number().int().nonnegative().nullable().default(null),
      })
      .default({}),
    limits: z
      .object({
        timeoutMs: nullablePositiveLimit,
        recursionLimit: z.number().int().positive().nullable().default(null),
        maxInvocations: z.number().int().nonnegative().nullable().default(null),
        maxToolCalls: z.number().int().nonnegative().nullable().default(null),
        maxInputTokens: z.number().int().nonnegative().nullable().default(null),
        maxOutputTokens: z.number().int().nonnegative().nullable().default(null),
        maxTotalTokens: z.number().int().nonnegative().nullable().default(null),
        maxCost: nullableLimit,
      })
      .default({}),
    context: z
      .object({
        spill: z
          .object({
            // Tool/sub-agent outputs larger than this many UTF-8 bytes are stored on disk and
            // replaced inline by a head/tail preview plus a locator. null keeps everything inline.
            maxInlineBytes: z.number().int().positive().nullable().default(null),
          })
          .default({}),
      })
      .default({}),
    isolation: z
      .object({
        mode: z.enum(['none', 'worktree']).default('none'),
        requireWorktree: z.boolean().default(false),
        allowedConnectors: z.array(z.string().min(1)).default([]),
        networkAccess: z.enum(['deny', 'restricted', 'allow']).default('restricted'),
      })
      .default({}),
    observability: z
      .object({
        enabled: z.boolean().default(true),
        tracingRetentionDays: z.number().int().positive().max(3650).default(30),
        captureInputs: z.boolean().default(true),
        captureOutputs: z.boolean().default(true),
        // Scrub values whose key names look secret-bearing (KEY/SECRET/TOKEN/PASSWORD/CREDENTIAL)
        // before span inputs are persisted. Defaults on: telemetry must never be the leak vector.
        redactSecrets: z.boolean().default(true),
        // Who span content may be shared with: full = inputs+outputs, feedback-only = outputs
        // only, disabled = no span content persisted at all.
        sharing: z.enum(['full', 'feedback-only', 'disabled']).default('full'),
      })
      .default({}),
  })
  .strict();

export type HarnessSettings = z.infer<typeof harnessSettingsSchema>;
export type ToolDecision = z.infer<typeof toolDecisionSchema>;
export type ToolEffect = z.infer<typeof toolEffectSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function optionalNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeHarnessSettings(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const source = value;
  const tools = isRecord(source.tools) ? source.tools : {};
  const memory = isRecord(source.memory) ? source.memory : {};
  const delegation = isRecord(source.delegation) ? source.delegation : {};
  const limits = isRecord(source.limits) ? source.limits : {};
  const context = isRecord(source.context) ? source.context : {};
  const isolation = isRecord(source.isolation) ? source.isolation : {};
  const observability = isRecord(source.observability) ? source.observability : {};
  const knownKeys = new Set([
    'tools',
    'memory',
    'delegation',
    'limits',
    'isolation',
    'observability',
    'nativeObserverEnabled',
    'memoryInjectionEnabled',
    'memoryScopes',
    'maxMemoryContextChars',
    'maxContextChars',
    'tracingRetentionDays',
    'knowledgeScopes',
    'preferFileTools',
    'requirePlanApproval',
    'allowSubAgents',
    'allowToolCalls',
    'maxParallelSubAgents',
    'maxControllerSteps',
    'requireVerification',
  ]);
  const unknownSettings = Object.fromEntries(Object.entries(source).filter(([key]) => !knownKeys.has(key)));

  return {
    ...unknownSettings,
    tools: {
      ...tools,
      allow: stringArray(tools.allow),
      ask: stringArray(tools.ask),
      deny: stringArray(tools.deny),
      escalate: stringArray(tools.escalate),
      effects: isRecord(tools.effects) ? tools.effects : {},
      trustedPreHandlerTools: stringArray(tools.trustedPreHandlerTools),
      timeouts: isRecord(tools.timeouts) ? tools.timeouts : {},
    },
    memory: {
      ...memory,
      enabled:
        typeof memory.enabled === 'boolean'
          ? memory.enabled
          : typeof source.memoryInjectionEnabled === 'boolean'
            ? source.memoryInjectionEnabled
            : undefined,
      scopes: Array.isArray(memory.scopes) ? memory.scopes : source.memoryScopes,
      maxChars: optionalNumber(memory.maxChars) ?? optionalNumber(source.maxMemoryContextChars),
    },
    delegation: {
      ...delegation,
      allowedEmployees: stringArray(delegation.allowedEmployees),
    },
    limits,
    context: {
      ...context,
      spill: isRecord(context.spill) ? context.spill : {},
    },
    isolation,
    observability: {
      ...observability,
      enabled:
        typeof observability.enabled === 'boolean'
          ? observability.enabled
          : typeof source.nativeObserverEnabled === 'boolean'
            ? source.nativeObserverEnabled
            : undefined,
      tracingRetentionDays:
        optionalNumber(observability.tracingRetentionDays) ?? optionalNumber(source.tracingRetentionDays),
    },
  };
}

export function parseHarnessSettings(value: unknown): HarnessSettings {
  return harnessSettingsSchema.parse(normalizeHarnessSettings(value));
}

export function validateHarnessSettings(value: unknown) {
  return harnessSettingsSchema.safeParse(normalizeHarnessSettings(value));
}

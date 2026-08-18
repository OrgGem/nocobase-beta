import { parseHarnessSettings } from './HarnessSchema';
import type { HarnessSettings, ToolDecision, ToolEffect } from './HarnessSchema';

export type HarnessLayer = {
  source: string;
  settings: unknown;
};

export type CompiledHarness = HarnessSettings & {
  sources: string[];
};

const effectRisk: Record<ToolEffect, number> = {
  read: 0,
  write: 1,
  external: 2,
};

const networkRisk: Record<HarnessSettings['isolation']['networkAccess'], number> = {
  allow: 0,
  restricted: 1,
  deny: 2,
};

function unique(values: string[]) {
  return Array.from(new Set(values)).sort();
}

function union(values: string[][]) {
  return unique(values.flat());
}

function intersectRestrictions(values: string[][]) {
  const restrictions = values.filter((items) => items.length > 0).map((items) => new Set(items));
  if (!restrictions.length) return [];
  return unique(
    Array.from(restrictions[0]).filter((item) => restrictions.every((restriction) => restriction.has(item))),
  );
}

function minimumNullable(values: Array<number | null>) {
  const limits = values.filter((value): value is number => value !== null);
  return limits.length ? Math.min(...limits) : null;
}

function strictestEffect(values: ToolEffect[]): ToolEffect {
  return values.reduce((strictest, value) => (effectRisk[value] > effectRisk[strictest] ? value : strictest), 'read');
}

function strictestNetwork(values: HarnessSettings['isolation']['networkAccess'][]) {
  return values.reduce<HarnessSettings['isolation']['networkAccess']>(
    (strictest, value) => (networkRisk[value] > networkRisk[strictest] ? value : strictest),
    'allow',
  );
}

const sharingRank: Record<HarnessSettings['observability']['sharing'], number> = {
  full: 0,
  'feedback-only': 1,
  disabled: 2,
};

function strictestSharing(values: HarnessSettings['observability']['sharing'][]) {
  return values.reduce<HarnessSettings['observability']['sharing']>(
    (strictest, value) => (sharingRank[value] > sharingRank[strictest] ? value : strictest),
    'full',
  );
}

// Per-tool caps compile like every other limit: the smallest value across layers wins.
function mergeTimeouts(settings: HarnessSettings[]) {
  const timeouts: Record<string, number> = {};
  for (const layer of settings) {
    for (const [name, timeoutMs] of Object.entries(layer.tools.timeouts)) {
      timeouts[name] = timeouts[name] === undefined ? timeoutMs : Math.min(timeouts[name], timeoutMs);
    }
  }
  return timeouts;
}

export function compileHarness(layers: HarnessLayer[]): CompiledHarness {
  if (!layers.length) {
    throw new Error('At least one harness layer is required.');
  }
  const parsed = layers.map((layer) => ({ source: layer.source, settings: parseHarnessSettings(layer.settings) }));
  const settings = parsed.map((layer) => layer.settings);
  const effectNames = union(settings.map((layer) => Object.keys(layer.tools.effects)));
  const effects = Object.fromEntries(
    effectNames.map((name) => [
      name,
      strictestEffect(
        settings
          .map((layer) => layer.tools.effects[name])
          .filter((effect): effect is ToolEffect => effect !== undefined),
      ),
    ]),
  );

  return {
    sources: parsed.map((layer) => layer.source),
    tools: {
      allow: intersectRestrictions(settings.map((layer) => layer.tools.allow)),
      ask: union(settings.map((layer) => layer.tools.ask)),
      deny: union(settings.map((layer) => layer.tools.deny)),
      // Escalatable tools widen authority per approved call, so a child may only inherit the
      // escalation surface every layer agrees on — same semantics as `allow`.
      escalate: intersectRestrictions(settings.map((layer) => layer.tools.escalate)),
      effects,
      trustedPreHandlerTools: intersectRestrictions(settings.map((layer) => layer.tools.trustedPreHandlerTools)),
      timeouts: mergeTimeouts(settings),
    },
    memory: {
      enabled: settings.every((layer) => layer.memory.enabled),
      scopes: intersectRestrictions(
        settings.map((layer) => layer.memory.scopes),
      ) as HarnessSettings['memory']['scopes'],
      maxChars: Math.min(...settings.map((layer) => layer.memory.maxChars)),
    },
    delegation: {
      allowedEmployees: intersectRestrictions(settings.map((layer) => layer.delegation.allowedEmployees)),
      maxDepth: minimumNullable(settings.map((layer) => layer.delegation.maxDepth)),
      maxCount: minimumNullable(settings.map((layer) => layer.delegation.maxCount)),
    },
    limits: {
      timeoutMs: minimumNullable(settings.map((layer) => layer.limits.timeoutMs)),
      recursionLimit: minimumNullable(settings.map((layer) => layer.limits.recursionLimit)),
      maxInvocations: minimumNullable(settings.map((layer) => layer.limits.maxInvocations)),
      maxToolCalls: minimumNullable(settings.map((layer) => layer.limits.maxToolCalls)),
      maxInputTokens: minimumNullable(settings.map((layer) => layer.limits.maxInputTokens)),
      maxOutputTokens: minimumNullable(settings.map((layer) => layer.limits.maxOutputTokens)),
      maxTotalTokens: minimumNullable(settings.map((layer) => layer.limits.maxTotalTokens)),
      maxCost: minimumNullable(settings.map((layer) => layer.limits.maxCost)),
    },
    context: {
      spill: {
        maxInlineBytes: minimumNullable(settings.map((layer) => layer.context.spill.maxInlineBytes)),
      },
    },
    isolation: {
      mode: settings.some((layer) => layer.isolation.mode === 'worktree') ? 'worktree' : 'none',
      requireWorktree: settings.some((layer) => layer.isolation.requireWorktree),
      allowedConnectors: intersectRestrictions(settings.map((layer) => layer.isolation.allowedConnectors)),
      networkAccess: strictestNetwork(settings.map((layer) => layer.isolation.networkAccess)),
    },
    observability: {
      enabled: settings.every((layer) => layer.observability.enabled),
      tracingRetentionDays: Math.min(...settings.map((layer) => layer.observability.tracingRetentionDays)),
      captureInputs: settings.every((layer) => layer.observability.captureInputs),
      captureOutputs: settings.every((layer) => layer.observability.captureOutputs),
      // Any layer demanding redaction wins; any layer restricting sharing wins. Telemetry safety
      // is union-of-concerns, not intersection.
      redactSecrets: settings.some((layer) => layer.observability.redactSecrets),
      sharing: strictestSharing(settings.map((layer) => layer.observability.sharing)),
    },
  };
}

export function decideTool(
  harness: CompiledHarness,
  toolName: string,
  effect: ToolEffect = harness.tools.effects[toolName] || 'external',
): ToolDecision {
  if (harness.tools.deny.includes(toolName)) return 'deny';
  if (harness.tools.ask.includes(toolName)) return 'ask';

  const explicitlyAllowed = harness.tools.allow.includes(toolName);
  if (!explicitlyAllowed) return 'ask';
  if (effect !== 'read' && !harness.tools.trustedPreHandlerTools.includes(toolName)) return 'ask';
  return 'allow';
}

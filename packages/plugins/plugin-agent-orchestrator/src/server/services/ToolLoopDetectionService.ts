import { asObject } from '../utils/ctx-utils';
import { createHash } from 'node:crypto';
import type { Database, Model } from '@nocobase/database';
import { getRunEventBus } from './RunEventBus';
import type { LoopPatternPolicy } from './LoopPatternSchema';
import { read } from '../utils/record-utils';

export type ToolLoopLevel = 'none' | 'warn' | 'block' | 'escalate';

export type ToolLoopFinding = {
  level: Exclude<ToolLoopLevel, 'none'>;
  toolName: string;
  signature: string;
  count: number;
  sampleArgs: Record<string, unknown>;
};

export type ToolCallEntry = {
  name: string;
  args: unknown;
};

export type ToolLoopRecordContext = {
  runId: number;
  role: string;
  username: string;
  runStatus: string;
  actorType: string;
  actorIdentity: string;
};

// Key order alone must not change the signature, so object keys are sorted before hashing.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) ordered[key] = canonicalize(source[key]);
    return ordered;
  }
  return value;
}

// A NUL byte cannot appear unescaped in JSON string output, so the name/args boundary of the
// hashed payload is unambiguous.
const NAME_ARGS_SEPARATOR = String.fromCharCode(0);

export function toolCallSignature(name: string, args: unknown): string {
  return createHash('sha256')
    .update(name + NAME_ARGS_SEPARATOR + JSON.stringify(canonicalize(args ?? null)))
    .digest('hex');
}

type RepetitionEntry = { toolName: string; signature: string; count: number; sampleArgs: Record<string, unknown> };

export function countToolRepetitions(calls: ToolCallEntry[]): Map<string, RepetitionEntry> {
  const counts = new Map<string, RepetitionEntry>();
  for (const call of calls) {
    if (!call.name) continue;
    const signature = toolCallSignature(call.name, call.args);
    const entry = counts.get(signature) ?? {
      toolName: call.name,
      signature,
      count: 0,
      sampleArgs: asObject(call.args),
    };
    entry.count += 1;
    counts.set(signature, entry);
  }
  return counts;
}

export function toolLoopLevel(count: number, detection: LoopPatternPolicy['loopDetection']): ToolLoopLevel {
  if (!detection.enabled) return 'none';
  if (count >= detection.escalateAt) return 'escalate';
  if (count >= detection.blockAt) return 'block';
  if (count >= detection.warnAt) return 'warn';
  return 'none';
}

export function toolLoopReason(finding: ToolLoopFinding): string {
  return `Tool loop detected: "${finding.toolName}" was invoked ${finding.count} times with identical arguments.`;
}

export function toolLoopNotice(toolName: string, count: number): string {
  return [
    '<tool_loop_warning>',
    `An earlier pass of this run invoked the tool "${toolName}" with identical arguments ${count} times.`,
    'Do not repeat this pattern. If the tool did not return what you expected, change your approach or report the blocker explicitly instead of retrying the same call.',
    '</tool_loop_warning>',
  ].join('\n');
}

export class ToolLoopDetectionService {
  constructor(private readonly database: Database) {}

  // Scans every tool call the run has issued so far (across all pass sessions, which are linked
  // through agentLoopSteps.sessionId) and returns the most repeated signature once it crosses the
  // policy's warn threshold. Returns null while the run stays under every threshold.
  async scanRun(runId: number, policy: LoopPatternPolicy): Promise<ToolLoopFinding | null> {
    const detection = policy.loopDetection;
    if (!detection.enabled) return null;

    const steps = await this.database.getRepository('agentLoopSteps').find({ filter: { runId } });
    const sessionIds = new Set<string>();
    for (const step of steps) {
      const sessionId = read(step, 'sessionId');
      if (typeof sessionId === 'string' && sessionId) sessionIds.add(sessionId);
    }
    if (!sessionIds.size) return null;

    // Limit message scan to prevent memory pressure on long-running loops.
    // Only load the toolCalls field since that's all we inspect.
    const messages = await this.database.getRepository('aiMessages').find({
      filter: { sessionId: { $in: [...sessionIds] } },
      fields: ['toolCalls'],
      limit: 5_000,
    });
    const calls: ToolCallEntry[] = [];
    for (const message of messages) {
      const toolCalls = read(message, 'toolCalls');
      if (!Array.isArray(toolCalls)) continue;
      for (const toolCall of toolCalls) {
        const entry = asObject(toolCall);
        if (typeof entry.name === 'string' && entry.name) calls.push({ name: entry.name, args: entry.args });
      }
    }
    if (!calls.length) return null;

    let worst: ToolLoopFinding | null = null;
    for (const entry of countToolRepetitions(calls).values()) {
      const level = toolLoopLevel(entry.count, detection);
      if (level === 'none') continue;
      if (!worst || entry.count > worst.count) worst = { level, ...entry };
    }
    return worst;
  }

  // Persists the guard step and event for a finding, deduplicated by signature so a run records
  // each loop once no matter how many subsequent passes observe it. Returns true when a new
  // record was created.
  async recordFinding(context: ToolLoopRecordContext, finding: ToolLoopFinding): Promise<boolean> {
    const steps = this.database.getRepository('agentLoopSteps');
    const existing = await steps.findOne({
      filter: { runId: context.runId, kind: 'guard', inputHash: finding.signature },
    });
    if (existing) return false;

    const now = new Date();
    const stepCount = await steps.count({ filter: { runId: context.runId } });
    const step = await steps.create({
      values: {
        runId: context.runId,
        runtimeVersion: 'control-plane-v2',
        sequence: stepCount,
        role: context.role,
        kind: 'guard',
        type: 'tool_loop',
        employeeUsername: context.username,
        toolName: finding.toolName,
        inputHash: finding.signature,
        title: `Tool loop ${finding.level}: ${finding.toolName} x${finding.count}`,
        description: toolLoopReason(finding),
        status: 'succeeded',
        metadata: { level: finding.level, count: finding.count, sampleArgs: finding.sampleArgs },
        startedAt: now,
        endedAt: now,
        createdAt: now,
      },
    });
    const event = await this.database.getRepository('agentLoopEvents').create({
      values: {
        runId: context.runId,
        stepId: read(step, 'id'),
        type: 'tool_loop_detected',
        title: `Tool loop ${finding.level}: ${finding.toolName}`,
        content: toolLoopReason(finding),
        status: context.runStatus,
        payload: {
          level: finding.level,
          toolName: finding.toolName,
          count: finding.count,
          signature: finding.signature,
        },
        actorType: context.actorType,
        actorIdentity: context.actorIdentity,
        correlationKey: `tool-loop:${finding.signature}`,
        createdAt: now,
      },
    });
    getRunEventBus().emit(context.runId, typeof event.toJSON === 'function' ? event.toJSON() : event);
    return true;
  }

  // Rebuilds the model-facing notices from guard steps recorded before the current worker claim,
  // so a run that parked and resumed keeps warning later roles about an earlier loop.
  async existingNotices(runId: number): Promise<string[]> {
    const steps = await this.database.getRepository('agentLoopSteps').find({
      filter: { runId, kind: 'guard' },
    });
    const notices: string[] = [];
    for (const step of steps) {
      const toolName = String(read(step, 'toolName') || '');
      const count = Number(asObject(read(step, 'metadata')).count) || 0;
      if (!toolName || !count) continue;
      notices.push(toolLoopNotice(toolName, count));
    }
    return notices;
  }
}

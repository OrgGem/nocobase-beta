import { describe, expect, it } from 'vitest';
import type { Database } from '@nocobase/database';
import { loopPatternPolicySchema } from '../services/LoopPatternSchema';
import { getRunEventBus } from '../services/RunEventBus';
import {
  ToolLoopDetectionService,
  countToolRepetitions,
  toolCallSignature,
  toolLoopLevel,
} from '../services/ToolLoopDetectionService';
import type { ToolLoopFinding } from '../services/ToolLoopDetectionService';

type Row = Record<string, unknown>;

const defaultPolicy = loopPatternPolicySchema.parse({});

function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && Array.isArray((value as Row).$in)) {
      return ((value as Row).$in as unknown[]).includes(row[key]);
    }
    return row[key] === value;
  });
}

function mockDatabase(options: { steps?: Row[]; messages?: Row[] } = {}) {
  const steps: Row[] = [...(options.steps ?? [])];
  const events: Row[] = [];
  let nextId = 1;
  const database = {
    getRepository(name: string) {
      if (name === 'agentLoopSteps') {
        return {
          find: async ({ filter }: { filter: Row }) => steps.filter((row) => matches(row, filter)),
          findOne: async ({ filter }: { filter: Row }) => steps.find((row) => matches(row, filter)) ?? null,
          count: async ({ filter }: { filter: Row }) => steps.filter((row) => matches(row, filter)).length,
          create: async ({ values }: { values: Row }) => {
            const row = { id: nextId++, ...values };
            steps.push(row);
            return row;
          },
        };
      }
      if (name === 'aiMessages') {
        return {
          find: async ({ filter }: { filter: Row }) => (options.messages ?? []).filter((row) => matches(row, filter)),
        };
      }
      if (name === 'agentLoopEvents') {
        return {
          create: async ({ values }: { values: Row }) => {
            const row = { id: nextId++, ...values };
            events.push(row);
            return row;
          },
        };
      }
      throw new Error(`Unexpected repository ${name}`);
    },
  } as unknown as Database;
  return { database, steps, events };
}

function message(sessionId: string, calls: Array<{ id: string; name: string; args: unknown }>): Row {
  return { sessionId, role: 'assistant', toolCalls: calls };
}

function finding(overrides: Partial<ToolLoopFinding> = {}): ToolLoopFinding {
  return {
    level: 'warn',
    toolName: 'searchDocs',
    signature: toolCallSignature('searchDocs', { query: 'loop' }),
    count: 3,
    sampleArgs: { query: 'loop' },
    ...overrides,
  };
}

describe('toolCallSignature', () => {
  it('is stable across object key order', () => {
    expect(toolCallSignature('search', { a: 1, b: 2 })).toBe(toolCallSignature('search', { b: 2, a: 1 }));
  });

  it('separates the tool name from its arguments', () => {
    expect(toolCallSignature('a 1', null)).not.toBe(toolCallSignature('a', '1 null'));
    expect(toolCallSignature('search', { a: 1 })).not.toBe(toolCallSignature('search', { a: 2 }));
  });

  it('treats missing args the same as null', () => {
    expect(toolCallSignature('ping', undefined)).toBe(toolCallSignature('ping', null));
  });
});

describe('countToolRepetitions', () => {
  it('counts identical calls and separates differing args', () => {
    const counts = countToolRepetitions([
      { name: 'search', args: { q: 'x' } },
      { name: 'search', args: { q: 'x' } },
      { name: 'search', args: { q: 'y' } },
      { name: 'write', args: { q: 'x' } },
      { name: '', args: {} },
    ]);

    expect(counts.size).toBe(3);
    const repeated = [...counts.values()].find((entry) => entry.count === 2);
    expect(repeated?.toolName).toBe('search');
    expect(repeated?.sampleArgs).toEqual({ q: 'x' });
  });
});

describe('toolLoopLevel', () => {
  it('maps counts onto the policy thresholds', () => {
    const detection = defaultPolicy.loopDetection;
    expect(toolLoopLevel(2, detection)).toBe('none');
    expect(toolLoopLevel(3, detection)).toBe('warn');
    expect(toolLoopLevel(5, detection)).toBe('block');
    expect(toolLoopLevel(8, detection)).toBe('escalate');
    expect(toolLoopLevel(100, detection)).toBe('escalate');
  });

  it('returns none when detection is disabled', () => {
    expect(toolLoopLevel(100, { ...defaultPolicy.loopDetection, enabled: false })).toBe('none');
  });
});

describe('ToolLoopDetectionService.scanRun', () => {
  it('returns the most repeated signature across every pass session of the run', async () => {
    const { database } = mockDatabase({
      steps: [
        { runId: 1, sessionId: 's1' },
        { runId: 1, sessionId: 's2' },
        { runId: 2, sessionId: 'other-run' },
      ],
      messages: [
        message('s1', [
          { id: 'c1', name: 'searchDocs', args: { query: 'loop' } },
          { id: 'c2', name: 'searchDocs', args: { query: 'loop' } },
        ]),
        message('s2', [
          { id: 'c3', name: 'searchDocs', args: { query: 'loop' } },
          { id: 'c4', name: 'readFile', args: { path: '/tmp/a' } },
        ]),
        message('other-run', [
          { id: 'c5', name: 'searchDocs', args: { query: 'loop' } },
          { id: 'c6', name: 'searchDocs', args: { query: 'loop' } },
        ]),
      ],
    });
    const service = new ToolLoopDetectionService(database);

    const result = await service.scanRun(1, defaultPolicy);

    expect(result).toMatchObject({ level: 'warn', toolName: 'searchDocs', count: 3 });
  });

  it('returns null while the run stays under the warn threshold', async () => {
    const { database } = mockDatabase({
      steps: [{ runId: 1, sessionId: 's1' }],
      messages: [
        message('s1', [
          { id: 'c1', name: 'searchDocs', args: { query: 'loop' } },
          { id: 'c2', name: 'searchDocs', args: { query: 'loop' } },
        ]),
      ],
    });
    const service = new ToolLoopDetectionService(database);

    expect(await service.scanRun(1, defaultPolicy)).toBeNull();
  });

  it('returns null when detection is disabled', async () => {
    const { database } = mockDatabase({
      steps: [{ runId: 1, sessionId: 's1' }],
      messages: [
        message('s1', [
          { id: 'c1', name: 'searchDocs', args: { query: 'loop' } },
          { id: 'c2', name: 'searchDocs', args: { query: 'loop' } },
          { id: 'c3', name: 'searchDocs', args: { query: 'loop' } },
        ]),
      ],
    });
    const service = new ToolLoopDetectionService(database);
    const policy = loopPatternPolicySchema.parse({ loopDetection: { enabled: false } });

    expect(await service.scanRun(1, policy)).toBeNull();
  });

  it('returns null when no pass session recorded tool calls', async () => {
    const { database } = mockDatabase({ steps: [{ runId: 1, sessionId: 's1' }], messages: [] });
    const service = new ToolLoopDetectionService(database);

    expect(await service.scanRun(1, defaultPolicy)).toBeNull();
    expect(await service.scanRun(99, defaultPolicy)).toBeNull();
  });

  it('ignores malformed tool call entries', async () => {
    const { database } = mockDatabase({
      steps: [{ runId: 1, sessionId: 's1' }],
      messages: [
        {
          sessionId: 's1',
          role: 'assistant',
          toolCalls: [
            { id: 'c1', args: { query: 'loop' } },
            { id: 'c2', name: 'searchDocs', args: { query: 'loop' } },
            'not-an-object',
          ],
        },
      ],
    });
    const service = new ToolLoopDetectionService(database);

    expect(await service.scanRun(1, defaultPolicy)).toBeNull();
  });
});

describe('ToolLoopDetectionService.recordFinding', () => {
  it('records one guard step and one event per signature and emits on the run bus', async () => {
    const { database, steps, events } = mockDatabase({ steps: [{ runId: 42, sessionId: 's1' }] });
    const service = new ToolLoopDetectionService(database);
    const seen: unknown[] = [];
    const unsubscribe = getRunEventBus().subscribe(42, (event) => seen.push(event));
    const context = {
      runId: 42,
      role: 'leader',
      username: 'lead',
      runStatus: 'running',
      actorType: 'worker',
      actorIdentity: 'worker-a',
    };

    try {
      expect(await service.recordFinding(context, finding())).toBe(true);
      expect(await service.recordFinding(context, finding())).toBe(false);
    } finally {
      unsubscribe();
    }

    const guardSteps = steps.filter((step) => step.kind === 'guard');
    expect(guardSteps).toHaveLength(1);
    expect(guardSteps[0]).toMatchObject({
      runId: 42,
      type: 'tool_loop',
      toolName: 'searchDocs',
      status: 'succeeded',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ runId: 42, type: 'tool_loop_detected', status: 'running' });
    expect(seen).toHaveLength(1);
  });
});

describe('ToolLoopDetectionService.existingNotices', () => {
  it('rebuilds notices from recorded guard steps', async () => {
    const { database } = mockDatabase({
      steps: [
        {
          runId: 7,
          kind: 'guard',
          toolName: 'searchDocs',
          metadata: { level: 'warn', count: 3 },
        },
        { runId: 7, kind: 'guard', toolName: '', metadata: { count: 5 } },
        { runId: 7, kind: 'invocation', toolName: 'other', metadata: {} },
      ],
    });
    const service = new ToolLoopDetectionService(database);

    const notices = await service.existingNotices(7);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('<tool_loop_warning>');
    expect(notices[0]).toContain('searchDocs');
    expect(notices[0]).toContain('3 times');
  });
});

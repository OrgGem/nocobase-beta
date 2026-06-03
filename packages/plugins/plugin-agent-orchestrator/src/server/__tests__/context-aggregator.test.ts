import { describe, expect, it, vi } from 'vitest';
import { ContextAggregator } from '../services/ContextAggregator';

function createMockPlugin() {
  const stepIdCounter = 1;
  const stepsStore: any[] = [];
  const runsStore: any[] = [];

  const mockRepo = {
    find: vi.fn(async ({ filter }: any) => {
      if (filter?.runId) {
        return stepsStore.filter((s) => s.runId === filter.runId);
      }
      return stepsStore;
    }),
    findOne: vi.fn(async ({ filter }: any) => {
      if (filter?.id) {
        return runsStore.find((r) => r.id === filter.id) || null;
      }
      return runsStore[0] || null;
    }),
  };

  return {
    db: {
      getRepository: vi.fn((name: string) => {
        if (name === 'agentLoopSteps') return mockRepo;
        if (name === 'agentLoopRuns') return mockRepo;
        return null;
      }),
    },
    app: { log: { warn: vi.fn() } },
    _stepsStore: stepsStore,
    _runsStore: runsStore,
    _repo: mockRepo,
    _stepIdCounter: stepIdCounter,
  };
}

function addStep(plugin: any, overrides: any = {}) {
  const id = plugin._stepIdCounter++;
  const step = {
    id,
    runId: overrides.runId || 1,
    planKey: overrides.planKey || `step_${id}`,
    index: overrides.index ?? id - 1,
    title: overrides.title || `Step ${id}`,
    description: overrides.description || '',
    type: overrides.type || 'reasoning',
    target: overrides.target || '',
    status: overrides.status || 'succeeded',
    output: overrides.output || {},
    error: overrides.error || '',
    metadata: overrides.metadata || {},
    ...overrides,
  };
  plugin._stepsStore.push(step);
  return step;
}

function addRun(plugin: any, overrides: any = {}) {
  const run = {
    id: overrides.id || 1,
    policy: overrides.policy || {},
    ...overrides,
  };
  plugin._runsStore.push(run);
  return run;
}

describe('ContextAggregator', () => {
  describe('buildStepContext', () => {
    it('returns empty string when there are no steps', async () => {
      const plugin = createMockPlugin();
      const aggregator = new ContextAggregator(plugin);
      const result = await aggregator.buildStepContext(1);
      expect(result).toBe('');
    });

    it('returns empty string when all steps are pending', async () => {
      const plugin = createMockPlugin();
      addStep(plugin, { status: 'pending' });
      addStep(plugin, { status: 'running' });
      const aggregator = new ContextAggregator(plugin);
      const result = await aggregator.buildStepContext(1);
      expect(result).toBe('');
    });

    it('builds XML for completed steps', async () => {
      const plugin = createMockPlugin();
      addStep(plugin, {
        planKey: 'step_1',
        title: 'Research topic',
        type: 'sub_agent',
        status: 'succeeded',
        output: { summary: 'Found data' },
      });
      const aggregator = new ContextAggregator(plugin);
      const result = await aggregator.buildStepContext(1);

      expect(result).toContain('<previous_steps>');
      expect(result).toContain('<step key="step_1"');
      expect(result).toContain('<title>Research topic</title>');
      expect(result).toContain('<output>');
      expect(result).toContain('Found data');
      expect(result).toContain('</previous_steps>');
    });

    it('includes error information for failed steps', async () => {
      const plugin = createMockPlugin();
      addStep(plugin, { planKey: 'step_1', status: 'failed', error: 'Something went wrong' });
      const aggregator = new ContextAggregator(plugin);
      const result = await aggregator.buildStepContext(1);

      expect(result).toContain('<error>');
      expect(result).toContain('Something went wrong');
    });

    it('respects last_n strategy', async () => {
      const plugin = createMockPlugin();
      for (let i = 1; i <= 15; i++) {
        addStep(plugin, { planKey: `step_${i}`, title: `Step ${i}`, status: 'succeeded' });
      }
      const aggregator = new ContextAggregator(plugin);
      const result = await aggregator.buildStepContext(1, 4000, { strategy: 'last_n' });

      // Should only include last 10
      expect(result).toContain('step_6');
      expect(result).not.toContain('planKey="step_1"');
    });

    it('omits output when includeStepOutputs is false', async () => {
      const plugin = createMockPlugin();
      addStep(plugin, { planKey: 'step_1', status: 'succeeded', output: { secret: 'data' } });
      const aggregator = new ContextAggregator(plugin);
      const result = await aggregator.buildStepContext(1, 4000, { includeStepOutputs: false });

      expect(result).not.toContain('<output>');
    });

    it('includes tool_results when includeToolResults is true', async () => {
      const plugin = createMockPlugin();
      addStep(plugin, {
        planKey: 'step_1',
        status: 'succeeded',
        metadata: { toolResults: [{ tool: 'search', result: 'found' }] },
      });
      const aggregator = new ContextAggregator(plugin);
      const result = await aggregator.buildStepContext(1, 4000, { includeToolResults: true });

      expect(result).toContain('<tool_results>');
    });

    it('escapes XML special characters', async () => {
      const plugin = createMockPlugin();
      addStep(plugin, { planKey: 'step_1', status: 'succeeded', title: 'Test & "Hello" <World>' });
      const aggregator = new ContextAggregator(plugin);
      const result = await aggregator.buildStepContext(1);

      expect(result).toContain('&amp;');
      expect(result).toContain('&lt;');
      expect(result).toContain('&quot;');
      expect(result).not.toContain('<World>');
    });

    it('truncates text exceeding maxTokens', async () => {
      const plugin = createMockPlugin();
      // Add many steps to force truncation
      for (let i = 1; i <= 20; i++) {
        addStep(plugin, { planKey: `step_${i}`, status: 'succeeded', description: 'A'.repeat(500) });
      }
      const aggregator = new ContextAggregator(plugin);
      const result = await aggregator.buildStepContext(1, 500); // very low token limit

      expect(result).toContain('intermediate step(s) omitted');
      expect(result.length).toBeLessThan(3000);
    });

    it('handles repository errors gracefully', async () => {
      const plugin = createMockPlugin();
      plugin.db.getRepository = vi.fn(() => null);
      const aggregator = new ContextAggregator(plugin);
      const result = await aggregator.buildStepContext(1);
      expect(result).toBe('');
    });
  });

  describe('enrichSystemPrompt', () => {
    it('returns base prompt when no run exists', async () => {
      const plugin = createMockPlugin();
      const aggregator = new ContextAggregator(plugin);
      const result = await aggregator.enrichSystemPrompt('You are a helpful assistant.', 999);
      expect(result).toBe('You are a helpful assistant.');
    });

    it('enriches prompt with step context', async () => {
      const plugin = createMockPlugin();
      addRun(plugin, { id: 1, policy: { maxContextTokens: 4000 } });
      addStep(plugin, { planKey: 'step_1', title: 'Research', status: 'succeeded', output: { data: 'results' } });
      const aggregator = new ContextAggregator(plugin);
      const result = await aggregator.enrichSystemPrompt('You are a helpful assistant.', 1);

      expect(result).toContain('You are a helpful assistant.');
      expect(result).toContain('<previous_steps_context>');
      expect(result).toContain('Research');
    });

    it('reads policy settings from run', async () => {
      const plugin = createMockPlugin();
      addRun(plugin, {
        id: 1,
        policy: { maxContextTokens: 100, contextSummaryStrategy: 'last_n', includeStepOutputs: false },
      });
      addStep(plugin, { planKey: 'step_1', status: 'succeeded', output: { data: 'results' } });
      addStep(plugin, { planKey: 'step_2', status: 'succeeded', output: { data: 'more' } });
      const aggregator = new ContextAggregator(plugin);
      const result = await aggregator.enrichSystemPrompt('Base prompt.', 1);

      expect(result).not.toContain('<output>');
    });
  });
});

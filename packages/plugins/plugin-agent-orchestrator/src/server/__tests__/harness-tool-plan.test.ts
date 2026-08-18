import type { Application } from '@nocobase/server';
import { describe, expect, it } from 'vitest';
import { compileHarness } from '../services/HarnessCompiler';
import { planHarnessTools } from '../services/PluginAiRuntimeAdapter';

type ToolEntry = { scope?: string; defaultPermission?: string };

// Mirrors `DefaultToolsManager.getTools(name, filter)`: a statically registered tool resolves
// immediately, but a dynamic provider (the MCP one, for instance) only registers its tools when a
// filter carrying `ctx` is supplied. A mock that ignores the second argument cannot tell the two
// apart, which is how the context-scoped discovery gap went unnoticed.
function createApp(tools: Record<string, ToolEntry>, contextTools: Record<string, ToolEntry> = {}) {
  return {
    aiManager: {
      toolsManager: {
        async getTools(name: string, filter?: { ctx?: unknown }) {
          if (tools[name]) return tools[name];
          if (!filter?.ctx) return undefined;
          return contextTools[name];
        },
      },
    },
  } as unknown as Application;
}

function harness(tools: {
  allow?: string[];
  ask?: string[];
  deny?: string[];
  escalate?: string[];
  effects?: Record<string, 'read' | 'write' | 'external'>;
  trustedPreHandlerTools?: string[];
}) {
  return compileHarness([{ source: 'test', settings: { tools } }]);
}

describe('planHarnessTools', () => {
  it('sends a string filter to the constructor and objects to the employee override', async () => {
    const app = createApp({
      readFile: { scope: 'CUSTOM' },
      applyPatch: { scope: 'CUSTOM' },
    });
    const plan = await planHarnessTools(
      app,
      harness({
        allow: ['readFile', 'applyPatch'],
        effects: { readFile: 'read', applyPatch: 'write' },
        trustedPreHandlerTools: ['applyPatch'],
      }),
    );

    // plugin-ai filters candidate tools with `toolFilter.includes(t.definition.name)`. Passing
    // objects here matched nothing and silently dropped every tool the harness granted.
    expect(plan.filter).toEqual(['applyPatch', 'readFile']);
    expect(plan.filter.every((name) => typeof name === 'string')).toBe(true);
    expect(plan.employeeTools).toEqual([
      { name: 'applyPatch', autoCall: true },
      { name: 'readFile', autoCall: true },
    ]);
    expect(plan.withheld).toEqual([]);
  });

  it('marks an ask decision as a non-auto-call instead of exposing it un-gated', async () => {
    const app = createApp({ deployService: { scope: 'CUSTOM' } });
    // Allowed but not trusted for a write effect, so `decideTool` downgrades it to `ask`.
    const plan = await planHarnessTools(
      app,
      harness({ allow: ['deployService'], effects: { deployService: 'write' } }),
    );

    expect(plan.filter).toEqual(['deployService']);
    expect(plan.employeeTools).toEqual([{ name: 'deployService', autoCall: false }]);
  });

  it('withholds a tool whose approval gate plugin-ai would ignore', async () => {
    // `isAutoCall` short-circuits for non-CUSTOM scope and returns `defaultPermission === 'ALLOW'`,
    // so an `ask` decision on this tool would auto-call anyway. Withholding is the safe outcome.
    const app = createApp({ searchWeb: { scope: 'GENERAL', defaultPermission: 'ALLOW' } });
    const plan = await planHarnessTools(app, harness({ ask: ['searchWeb'] }));

    expect(plan.filter).toEqual([]);
    expect(plan.employeeTools).toEqual([]);
    expect(plan.withheld).toEqual([{ name: 'searchWeb', reason: 'approval cannot be enforced for this tool' }]);
  });

  it('keeps an enforceable ask on a general tool that does not default to allow', async () => {
    const app = createApp({ searchWeb: { scope: 'GENERAL', defaultPermission: 'ASK' } });
    const plan = await planHarnessTools(app, harness({ ask: ['searchWeb'] }));

    expect(plan.filter).toEqual(['searchWeb']);
    expect(plan.employeeTools).toEqual([{ name: 'searchWeb', autoCall: false }]);
  });

  it('offers escalatable tools as ask-gated candidates without granting them', async () => {
    const app = createApp({ deployService: { scope: 'CUSTOM' }, readFile: { scope: 'CUSTOM' } });
    const plan = await planHarnessTools(
      app,
      harness({ allow: ['readFile'], escalate: ['deployService'], effects: { readFile: 'read' } }),
    );

    expect(plan.filter).toEqual(['deployService', 'readFile']);
    expect(plan.employeeTools).toEqual([
      { name: 'deployService', autoCall: false },
      { name: 'readFile', autoCall: true },
    ]);
  });

  it('withholds an escalatable tool whose approval gate plugin-ai would ignore', async () => {
    const app = createApp({ searchWeb: { scope: 'GENERAL', defaultPermission: 'ALLOW' } });
    const plan = await planHarnessTools(app, harness({ escalate: ['searchWeb'] }));

    expect(plan.filter).toEqual([]);
    expect(plan.employeeTools).toEqual([]);
    expect(plan.withheld).toEqual([{ name: 'searchWeb', reason: 'approval cannot be enforced for this tool' }]);
  });

  it('withholds denied and unregistered tools', async () => {
    const app = createApp({ readFile: { scope: 'CUSTOM' } });
    const plan = await planHarnessTools(
      app,
      harness({ allow: ['readFile', 'ghostTool'], ask: ['dropDatabase'], deny: ['dropDatabase'] }),
    );

    expect(plan.filter).toEqual(['readFile']);
    expect(plan.withheld).toEqual([
      { name: 'dropDatabase', reason: 'denied by harness' },
      { name: 'ghostTool', reason: 'not registered with plugin-ai' },
    ]);
  });

  it('reports every ungranted system tool so the caller can switch off its injector', async () => {
    const app = createApp({ readFile: { scope: 'CUSTOM' } });
    const plan = await planHarnessTools(app, harness({ allow: ['readFile'], deny: ['knowledge-base-retrieve'] }));

    // plugin-ai keeps system tools through the constructor filter unconditionally
    // (`systemTools.includes(name) || toolFilter.includes(name)`), so dropping a denied system tool
    // from `filter` does nothing. It has to be reported separately and disabled at its source.
    expect(plan.filter).toEqual(['readFile']);
    expect(plan.blockedSystemTools).toEqual([
      'aiEmployeeWorkflowTaskOutput',
      'knowledge-base-retrieve',
      'subAgentWebSearch',
    ]);
  });

  it('leaves a granted system tool out of the blocked list', async () => {
    const app = createApp({ subAgentWebSearch: { scope: 'SPECIFIED', defaultPermission: 'ALLOW' } });
    const plan = await planHarnessTools(
      app,
      harness({ allow: ['subAgentWebSearch'], effects: { subAgentWebSearch: 'read' } }),
    );

    expect(plan.filter).toEqual(['subAgentWebSearch']);
    expect(plan.blockedSystemTools).not.toContain('subAgentWebSearch');
  });

  it('finds a context-scoped tool only when discovery passes the invocation ctx', async () => {
    const app = createApp({}, { 'mcp-personal-search': { scope: 'CUSTOM' } });
    const granted = harness({ allow: ['mcp-personal-search'] });

    // Without ctx the MCP provider never registers the user's tools, so the lookup misses and the
    // harness grant is silently withheld even though `AIEmployee.getToolsMap()` would resolve it.
    await expect(planHarnessTools(app, granted)).resolves.toMatchObject({
      filter: [],
      withheld: [{ name: 'mcp-personal-search', reason: 'not registered with plugin-ai' }],
    });

    const plan = await planHarnessTools(app, granted, { ctx: { auth: {} }, sessionId: 'session-1' });
    expect(plan.filter).toEqual(['mcp-personal-search']);
    expect(plan.withheld).toEqual([]);
  });
});

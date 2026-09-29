/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, it, expect } from 'vitest';
import { IdMapper } from '../document-manager/id-mapper';
import { DocumentManager } from '../document-manager';
import { DefaultToolsManager, defineTools, SYSTEM_TOOLS, listSystemTools } from '../tools-manager';
import type { ToolsOptions } from '../tools-manager';
import { isNonEmptyObject } from '../loader/utils';

const makeTool = (name: string, overrides: Partial<ToolsOptions> = {}): ToolsOptions => ({
  scope: 'GENERAL',
  definition: { name, description: name + ' tool' },
  invoke: async () => ({ status: 'success' }),
  ...overrides,
});

describe('AI unit > IdMapper', () => {
  it('should map string ids to sequential numbers, stable across calls', () => {
    const mapper = new IdMapper();
    const a = mapper.toNumeric('alpha');
    const b = mapper.toNumeric('beta');
    expect(a).toBeGreaterThanOrEqual(1);
    expect(b).toBeGreaterThan(a);
    expect(mapper.toNumeric('alpha')).toBe(a);
    expect(mapper.getNumeric('alpha')).toBe(a);
  });

  it('should return number id as-is', () => {
    const mapper = new IdMapper();
    expect(mapper.toNumeric(42)).toBe(42);
    expect(mapper.getNumeric(42)).toBe(42);
    expect(mapper.toExternal(42)).toBe(42);
  });

  it('should convert back to external string id', () => {
    const mapper = new IdMapper();
    const num = mapper.toNumeric('doc-1');
    expect(mapper.toExternal(num)).toBe('doc-1');
  });

  it('should return number as-is for unknown numeric id in toExternal', () => {
    const mapper = new IdMapper();
    expect(mapper.toExternal(999)).toBe(999);
  });

  it('should remove mapping by external id', () => {
    const mapper = new IdMapper();
    const num = mapper.toNumeric('doc-1');
    mapper.remove('doc-1');
    expect(mapper.getNumeric('doc-1')).toBeUndefined();
    expect(mapper.toExternal(num)).toBe(num);
  });

  it('should remove mapping by numeric id', () => {
    const mapper = new IdMapper();
    const num = mapper.toNumeric('doc-1');
    mapper.remove(num);
    expect(mapper.getNumeric('doc-1')).toBeUndefined();
  });

  it('should not recycle freed numeric ids (nextId only increments)', () => {
    const mapper = new IdMapper();
    mapper.toNumeric('a');
    mapper.remove('a');
    const second = mapper.toNumeric('b');
    expect(second).toBe(2);
  });
});

describe('AI unit > DocumentManager', () => {
  it('should add and retrieve index', () => {
    const dm = new DocumentManager();
    const index = dm.addIndex('products');
    expect(dm.getIndex('products')).toBe(index);
  });

  it('should return undefined for missing index', () => {
    const dm = new DocumentManager();
    expect(dm.getIndex('nope')).toBeUndefined();
  });

  it('should add and retrieve document', () => {
    const dm = new DocumentManager();
    const doc = dm.addDocument('report', { document: { id: 'id', index: 'idx' } });
    expect(dm.getDocument('report')).toBe(doc);
  });

  it('should return undefined for missing document', () => {
    const dm = new DocumentManager();
    expect(dm.getDocument('nope')).toBeUndefined();
  });
});

describe('AI unit > DefaultToolsManager', () => {
  it('should register and retrieve tools with defaulted metadata', async () => {
    const manager = new DefaultToolsManager();
    manager.registerTools(makeTool('print'));
    const tool = await manager.getTools('print');
    expect(tool.definition.name).toBe('print');
    expect(tool.from).toBe('loader');
    expect(tool.execution).toBe('backend');
    expect(tool.defaultPermission).toBe('ASK');
    expect(tool.silence).toBe(false);
    expect(tool.introduction).toEqual({ title: 'print' });
    expect(await tool.invoke(null as any, null, null as any)).toEqual({ status: 'success' });
  });

  it('should register multiple tools at once', async () => {
    const manager = new DefaultToolsManager();
    manager.registerTools([makeTool('a'), makeTool('b')]);
    expect((await manager.getTools('a')).definition.name).toBe('a');
    expect((await manager.getTools('b')).definition.name).toBe('b');
  });

  it('should keep explicit from / execution / defaultPermission', async () => {
    const manager = new DefaultToolsManager();
    manager.registerTools(makeTool('custom', { from: 'mcp', execution: 'frontend', defaultPermission: 'ALLOW', silence: true }));
    const tool = await manager.getTools('custom');
    expect(tool.from).toBe('mcp');
    expect(tool.execution).toBe('frontend');
    expect(tool.defaultPermission).toBe('ALLOW');
    expect(tool.silence).toBe(true);
  });

  it('should return undefined for missing tool', async () => {
    const manager = new DefaultToolsManager();
    expect(await manager.getTools('nope')).toBeUndefined();
  });

  it('should report existence', async () => {
    const manager = new DefaultToolsManager();
    manager.registerTools(makeTool('print'));
    expect(manager.isToolsExisted('print')).toBe(true);
    expect(manager.isToolsExisted('nope')).toBe(false);
  });

  it('should list all tools', async () => {
    const manager = new DefaultToolsManager();
    manager.registerTools([makeTool('a'), makeTool('b')]);
    const list = await manager.listTools();
    expect(list.map((x) => x.definition.name).sort()).toEqual(['a', 'b']);
  });

  it('should filter tools by scope', async () => {
    const manager = new DefaultToolsManager();
    manager.registerTools([
      makeTool('general', { scope: 'GENERAL' }),
      makeTool('specific', { scope: 'SPECIFIED' }),
    ]);
    const list = await manager.listTools({ scope: 'GENERAL' });
    expect(list.map((x) => x.definition.name)).toEqual(['general']);
  });

  it('should resolve dynamic tools on miss', async () => {
    const manager = new DefaultToolsManager();
    manager.registerDynamicTools(async (register) => {
      register.registerTools(makeTool('dyn'));
    });
    const tool = await manager.getTools('dyn');
    expect(tool.definition.name).toBe('dyn');
  });

  it('should include dynamic tools in listTools', async () => {
    const manager = new DefaultToolsManager();
    manager.registerDynamicTools(async (register) => {
      register.registerTools(makeTool('dyn'));
    });
    const list = await manager.listTools();
    expect(list.map((x) => x.definition.name)).toContain('dyn');
  });
});

describe('AI unit > helpers', () => {
  it('defineTools should pass options through', () => {
    const opts = makeTool('x');
    expect(defineTools(opts)).toBe(opts);
  });

  it('SYSTEM_TOOLS should expose known keys', () => {
    expect(SYSTEM_TOOLS.GET_SKILL).toBe('getSkill');
    expect(SYSTEM_TOOLS.WEB_SEARCH).toBe('subAgentWebSearch');
    expect(SYSTEM_TOOLS.KNOWLEDGE_BASE).toBe('knowledge-base-retrieve');
  });

  it('listSystemTools should return all system tool names', () => {
    expect(listSystemTools()).toEqual(Object.values(SYSTEM_TOOLS));
  });

  it('isNonEmptyObject should detect plain non-empty objects', () => {
    expect(isNonEmptyObject({ a: 1 })).toBe(true);
    expect(isNonEmptyObject({})).toBe(false);
    expect(isNonEmptyObject(null)).toBe(false);
    expect(isNonEmptyObject('str')).toBe(false);
    expect(isNonEmptyObject([])).toBe(false);
  });
});
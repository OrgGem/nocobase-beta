/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import { loadSettings, parseBuildResult, readBuild, retryBuild, saveSettings, startBuild } from '../buildApi';

const spec = {
  version: 1,
  blockType: 'table',
  title: 'Orders',
  primaryCollection: 'orders',
  dataSource: 'warehouse',
  table: { fields: ['name'] },
};
describe('V2 visualization build API', () => {
  it('starts a build using the server contract and preserves bigint IDs as strings', async () => {
    const request = vi.fn().mockResolvedValue({ data: { data: { id: '9007199254740993' } } });
    const input = {
      requirement: 'sales',
      dataSource: 'warehouse',
      collections: ['orders', 'customers'],
      llmService: 'service',
      model: 'model',
    };
    expect(await startBuild({ request }, input)).toBe('9007199254740993');
    expect(request).toHaveBeenCalledWith({
      url: 'aiVisualizationBuilds:build',
      method: 'post',
      data: { ...input, primaryCollection: 'orders' },
    });
  });

  it('reads and retries the exact build ID with the existing action envelope', async () => {
    const request = vi.fn().mockResolvedValue({
      data: { data: { id: '9007199254740993', buildPhase: 'completed', blockSpec: spec, usedFallback: true } },
    });
    const result = await readBuild({ request }, '9007199254740993');
    expect(result.blockSpec).toEqual(spec);
    expect(result.usedFallback).toBe(true);
    await retryBuild({ request }, result.id);
    expect(request).toHaveBeenLastCalledWith({
      url: 'aiVisualizationBuilds:retry',
      method: 'post',
      params: { filterByTk: '9007199254740993' },
    });
    await expect(readBuild({ request }, 'other-id')).rejects.toThrow('Invalid build response');
  });

  it('rejects completed V1-only or malformed results and accepts pending results without output', () => {
    expect(() =>
      parseBuildResult({ id: 1, buildPhase: 'completed', blockSchema: { 'x-component': 'TableV2' } }),
    ).toThrow('Invalid generated block specification');
    expect(() => parseBuildResult({ id: 1, buildPhase: 'unknown' })).toThrow('Invalid build response');
    expect(parseBuildResult({ id: 1, buildPhase: 'queued' }).blockSpec).toBeUndefined();
  });

  it('loads and saves settings using the existing singleton resource', async () => {
    const settings = { defaultCollections: ['orders'], defaultDataSource: 'warehouse', enableAITool: false };
    const request = vi.fn().mockResolvedValue({ data: { data: settings } });
    expect(await loadSettings({ request })).toEqual(settings);
    await saveSettings({ request }, settings);
    expect(request).toHaveBeenLastCalledWith({
      url: 'aiVisualizationBuildSettings:update',
      method: 'post',
      params: { filterByTk: 1 },
      data: settings,
    });
  });
});

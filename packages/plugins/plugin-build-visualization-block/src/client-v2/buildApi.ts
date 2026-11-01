/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { APIClient } from '@nocobase/client-v2';
import { blockSpecSchema, type BlockSpec } from '../shared/blockSpec';
import { ACTIONS, BUILD_PHASES, type BuildPhase, SETTINGS_COLLECTION_NAME } from '../shared/constants';

type BuildApi = Pick<APIClient, 'request'>;
export interface BuildSettings {
  defaultDataSource?: string;
  defaultCollections?: string[];
  defaultLLMService?: string;
  defaultModel?: string;
  enableAITool?: boolean;
}
export interface BuildInput {
  requirement: string;
  dataSource: string;
  collections: string[];
  llmService: string;
  model: string;
}
export interface BuildSelection {
  buildId: string;
  spec: BlockSpec;
}
export interface BuildResult {
  id: string;
  buildPhase: BuildPhase;
  blockSpec?: BlockSpec;
  usedFallback: boolean;
  adjustments: unknown;
  errorMessage?: string;
}

export function parseBuildResult(value: unknown): BuildResult {
  if (!value || typeof value !== 'object') throw new Error('Invalid build response');
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' && typeof record.id !== 'number') throw new Error('Invalid build response');
  if (!BUILD_PHASES.includes(record.buildPhase as BuildPhase)) throw new Error('Invalid build response');
  const parsed = blockSpecSchema.safeParse(record.blockSpec);
  if (record.buildPhase === 'completed' && !parsed.success) throw new Error('Invalid generated block specification');
  return {
    id: String(record.id),
    buildPhase: record.buildPhase as BuildPhase,
    blockSpec: parsed.success ? parsed.data : undefined,
    usedFallback: record.usedFallback === true,
    adjustments: record.adjustments,
    errorMessage: typeof record.errorMessage === 'string' ? record.errorMessage : undefined,
  };
}

export async function loadSettings(api: BuildApi) {
  const response = await api.request<{ data: BuildSettings }>({
    url: `${SETTINGS_COLLECTION_NAME}:publicGet`,
    method: 'post',
  });
  return response.data.data;
}

export async function saveSettings(api: BuildApi, values: BuildSettings) {
  await api.request({
    url: `${SETTINGS_COLLECTION_NAME}:update`,
    method: 'post',
    params: { filterByTk: 1 },
    data: values,
  });
}

export async function startBuild(api: BuildApi, input: BuildInput): Promise<string> {
  const response = await api.request<{ data: { id?: string | number } }>({
    url: ACTIONS.build,
    method: 'post',
    data: { ...input, primaryCollection: input.collections[0] },
  });
  const id = response.data.data.id;
  if (id == null || id === '') throw new Error('Invalid build response');
  return String(id);
}

export async function readBuild(api: BuildApi, id: string): Promise<BuildResult> {
  const response = await api.request<{ data: unknown }>({
    url: ACTIONS.getResult,
    method: 'post',
    params: { filterByTk: id },
  });
  const result = parseBuildResult(response.data.data);
  if (result.id !== id) throw new Error('Invalid build response');
  return result;
}

export async function retryBuild(api: BuildApi, id: string) {
  await api.request({ url: ACTIONS.retry, method: 'post', params: { filterByTk: id } });
}

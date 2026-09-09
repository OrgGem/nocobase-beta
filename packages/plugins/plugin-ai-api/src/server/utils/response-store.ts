/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Context } from '@nocobase/actions';
import type { Model } from '@nocobase/database';
import type { OpenAIMessage } from './direct-llm-context';
import { responsesInputToMessages, type ResponseObject } from './responses-format';

const RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const RESPONSE_RETENTION_MS = RETENTION_DAYS * MS_PER_DAY;

function valueOf<T>(model: unknown, key: string): T | undefined {
  if (!model) return undefined;
  if (typeof (model as { get?: unknown }).get === 'function') {
    return (model as { get: (k: string) => unknown }).get(key) as T | undefined;
  }
  return (model as Record<string, unknown>)[key] as T | undefined;
}

function isExpired(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  const timestamp = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return !Number.isFinite(timestamp) || timestamp <= Date.now();
}

export interface ResponseRecord {
  id: string | number | bigint;
  responseId: string;
  userId: string | number | bigint;
  model: string;
  input: unknown;
  output: ResponseObject;
  previousResponseId?: string;
  metadata?: Record<string, unknown>;
  expiresAt: Date | string;
}

export async function storeResponseRecord(
  ctx: Context,
  response: ResponseObject,
  requestBody: Record<string, unknown>,
  userId: string | number | bigint,
): Promise<void> {
  if (requestBody.store === false) return;

  await ctx.db.getRepository('aiApiResponseRecords').create({
    values: {
      responseId: response.id,
      userId,
      model: response.model,
      input: requestBody.input,
      output: response,
      previousResponseId: response.previous_response_id,
      metadata: response.metadata,
      expiresAt: new Date(Date.now() + RESPONSE_RETENTION_MS),
    },
  });
}

export async function getResponseRecord(
  ctx: Pick<Context, 'db'>,
  responseId: string,
  userId: string | number | bigint,
): Promise<ResponseRecord | null> {
  const row = await ctx.db.getRepository('aiApiResponseRecords').findOne({
    filter: { responseId, userId },
  });
  if (!row || isExpired(valueOf(row, 'expiresAt'))) return null;

  return {
    id: valueOf(row, 'id') as string | number | bigint,
    responseId: valueOf<string>(row, 'responseId') as string,
    userId: valueOf(row, 'userId') as string | number | bigint,
    model: valueOf<string>(row, 'model') as string,
    input: valueOf(row, 'input'),
    output: valueOf<ResponseObject>(row, 'output') as ResponseObject,
    previousResponseId: valueOf<string>(row, 'previousResponseId') ?? undefined,
    metadata: valueOf<Record<string, unknown>>(row, 'metadata'),
    expiresAt: valueOf<Date | string>(row, 'expiresAt') as Date | string,
  };
}

function responseOutputToMessages(output: ResponseObject): OpenAIMessage[] {
  return responsesInputToMessages(output.output);
}

export async function loadConversationChain(
  ctx: Context,
  responseId: string,
  userId: string | number | bigint,
  maxDepth = 100,
): Promise<OpenAIMessage[] | null> {
  const records: ResponseRecord[] = [];
  const visited = new Set<string>();
  let currentId: string | undefined = responseId;

  while (currentId) {
    if (records.length >= maxDepth || visited.has(currentId)) return null;
    visited.add(currentId);
    const record = await getResponseRecord(ctx, currentId, userId);
    if (!record) return null;
    records.unshift(record);
    currentId = record.previousResponseId;
  }

  return records.flatMap((record) => [
    ...responsesInputToMessages(record.input),
    ...responseOutputToMessages(record.output),
  ]);
}

export async function cleanupExpiredResponseRecords(ctx: Pick<Context, 'db'>): Promise<number> {
  const repo = ctx.db.getRepository('aiApiResponseRecords');
  const now = new Date();
  let deleted = 0;
  for (;;) {
    const expired = (await repo.find({
      filter: { expiresAt: { $lt: now } },
      fields: ['id'],
      limit: 1000,
      sort: 'id',
    })) as Model[];
    const ids = expired.map((record) => record.get('id'));
    if (ids.length === 0) return deleted;
    const count = await repo.destroy({ filterByTk: ids, individualHooks: false });
    if (typeof count === 'number') deleted += count;
    else deleted += ids.length;
    if (count === 0) return deleted;
  }
}

export async function deleteResponseRecord(
  ctx: Pick<Context, 'db'>,
  responseId: string,
  userId: string | number | bigint,
): Promise<boolean> {
  const record = await getResponseRecord(ctx, responseId, userId);
  if (!record) return false;
  await ctx.db.getRepository('aiApiResponseRecords').destroy({ filterByTk: record.id });
  return true;
}

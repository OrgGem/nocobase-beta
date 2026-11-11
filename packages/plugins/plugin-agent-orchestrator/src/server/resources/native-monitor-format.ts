/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { asObject, toPlain } from '../utils/ctx-utils';

type Span = Record<string, unknown>;

/** Select exactly the requested span and its descendants, even when sessions share a legacy run id. */
export function selectNativeSubtree(rawRows: unknown[], selected: unknown): Span[] {
  const rows = rawRows.map((raw) => (toPlain(raw) || {}) as Span);
  const root = (toPlain(selected) || {}) as Span;
  const rootId = String(root.id);
  if (!rows.some((row) => String(row.id) === rootId)) rows.unshift(root);
  const children = new Map<string, Span[]>();
  for (const row of rows) {
    if (row.parentSpanId == null) continue;
    const parentId = String(row.parentSpanId);
    const siblings = children.get(parentId) || [];
    siblings.push(row);
    children.set(parentId, siblings);
  }
  const selectedRows: Span[] = [];
  const queue = [rootId];
  const visited = new Set<string>();
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (visited.has(id)) continue;
    visited.add(id);
    const row = byId.get(id);
    if (!row) continue;
    selectedRows.push(row);
    for (const child of children.get(id) || []) queue.push(String(child.id));
  }
  return selectedRows;
}

/** Native content cannot be rehydrated without an invocation capture-policy snapshot. */
export function safeNativeSpan(raw: unknown): Span {
  const row = (toPlain(raw) || {}) as Span;
  const metadata = asObject(row.metadata) as Span;
  const allowed = [
    'id',
    'rootRunId',
    'parentSpanId',
    'agentLoopRunId',
    'type',
    'status',
    'depth',
    'source',
    'parentSessionId',
    'subSessionId',
    'toolCallId',
    'leaderUsername',
    'employeeUsername',
    'toolName',
    'durationMs',
    'startedAt',
    'endedAt',
    'createdAt',
    'updatedAt',
    'userId',
    'model',
    'provider',
    'llmService',
    'usageIdentity',
    'usageSource',
    'usageOrigin',
    'usageOccurredAt',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cachedTokens',
    'reasoningTokens',
    'cost',
    'pricingStatus',
    'priceCurrency',
    'priceVersion',
    'skillExecutionId',
  ];
  const safe = Object.fromEntries(allowed.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
  safe.title = row.type === 'main_agent' ? 'Native agent session' : row.toolName || row.type || 'span';
  const allowedStatus = new Set([
    'init',
    'pending',
    'running',
    'streaming',
    'invoking',
    'interrupted',
    'waiting',
    'done',
    'confirmed',
    'completed',
    'success',
    'error',
    'failed',
    'idle',
  ]);
  safe.metadata = {
    source: 'native-plugin-ai',
    nativeStatus: allowedStatus.has(String(metadata.nativeStatus)) ? metadata.nativeStatus : undefined,
    invokeStatus: allowedStatus.has(String(metadata.invokeStatus)) ? metadata.invokeStatus : undefined,
    sessionGranularity: metadata.sessionGranularity,
    correlationIncomplete: metadata.correlationIncomplete,
    nativeCoverage: {
      source: 'persisted-native-records',
      realtime: false,
      contentCapture: 'unsupported-without-invocation-snapshot',
    },
    capturePolicy: {
      source: 'native-persistence-no-invocation-snapshot',
      sharing: 'disabled',
      captureInputs: false,
      captureOutputs: false,
    },
  };
  return safe;
}

/** Model-call rows are the only additive usage rows; null indicates incomplete coverage. */
export function summarizeNativeUsage(rows: unknown[]) {
  const calls = rows.map((row) => (toPlain(row) || {}) as Span).filter((row) => row.type === 'model_call');
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let missingUsage = 0;
  let unpriced = 0;
  let estimated = 0;
  for (const call of calls) {
    if (call.usageSource === 'missing' || call.inputTokens == null || call.outputTokens == null) {
      missingUsage += 1;
    } else {
      inputTokens += Number(call.inputTokens) || 0;
      outputTokens += Number(call.outputTokens) || 0;
    }
    if (call.usageSource === 'estimated') estimated += 1;
    if (call.cost == null || (call.priceCurrency && call.priceCurrency !== 'USD')) unpriced += 1;
    else cost += Number(call.cost) || 0;
  }
  return {
    modelCalls: calls.length,
    inputTokens: calls.length && !missingUsage ? inputTokens : null,
    outputTokens: calls.length && !missingUsage ? outputTokens : null,
    cost: calls.length && !unpriced ? cost : null,
    currency: 'USD',
    estimatedCalls: estimated,
    missingUsageCalls: missingUsage,
    unpricedCalls: unpriced,
    coverage: 'persisted-model-call-spans-only',
  };
}

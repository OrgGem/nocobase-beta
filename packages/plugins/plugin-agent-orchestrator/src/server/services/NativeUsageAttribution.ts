/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from '@nocobase/database';
import type { Plugin } from '@nocobase/server';
import type { Transaction } from 'sequelize';
import { read } from '../utils/record-utils';
import { TokenTracker, usageFromAIUsageEvent } from './TokenTracker';

type UsageAttribution = {
  db: Database;
  userId: string | number;
  sessionId: string;
  departmentId?: string | number;
};

const usageAttribution = new AsyncLocalStorage<UsageAttribution>();

/** Scope the authenticated native request, keeping parallel requests isolated. */
export function runWithNativeUsageAttribution<T>(scope: UsageAttribution, callback: () => Promise<T>): Promise<T> {
  return usageAttribution.run(scope, callback);
}

/**
 * Observe newly persisted native usage events in the exact request context that produced them.
 * Only a matching main session and owner may inherit its department. Replayed updates, child
 * sessions and work performed outside an attributed request stay unattributed.
 */
export function installNativeUsageAttribution(plugin: Plugin): () => void {
  const tracker = new TokenTracker(plugin);
  const warn = (error: unknown) => {
    try {
      plugin.app.logger.warn('[AgentOrchestrator] Could not persist native usage attribution.', { error });
    } catch {
      // Usage attribution cannot affect the native call.
    }
  };
  const onCreated = (event: unknown, options: { transaction?: Transaction } = {}) => {
    try {
      const scope = usageAttribution.getStore();
      if (!scope || scope.db !== plugin.db || read(event, 'eventType') !== 'llm_message') return;
      const sessionId = String(read(event, 'sessionId') ?? '');
      const messageId = String(read(event, 'messageId') ?? '');
      const userId = read(event, 'userId');
      if (
        (typeof userId === 'number' && !Number.isSafeInteger(userId)) ||
        (typeof scope.userId === 'number' && !Number.isSafeInteger(scope.userId))
      )
        return;
      if (!messageId || sessionId !== scope.sessionId || String(userId ?? '') !== String(scope.userId)) return;

      const value = (key: string) => {
        const result = read(event, key);
        return typeof result === 'string' && result ? result : undefined;
      };
      const occurredAt = read(event, 'occurredAt');
      const input = {
        usageIdentity: `ai-usage-event:${sessionId}:${messageId}`,
        nativeIdentity: `ai-usage-event:${sessionId}:${messageId}`,
        sessionId,
        messageId,
        usage: usageFromAIUsageEvent(event),
        model: value('model'),
        provider: value('provider'),
        llmService: value('llmService'),
        role: value('role'),
        employeeUsername: value('aiEmployeeUsername'),
        userId: scope.userId,
        departmentId: scope.departmentId,
        source: 'ai_usage_event' as const,
        ...(occurredAt instanceof Date || typeof occurredAt === 'string' || typeof occurredAt === 'number'
          ? { occurredAt }
          : {}),
      };
      const persist = () => {
        tracker
          .recordModelCallUsage(input)
          .then((id) => {
            if (id === undefined) warn(new Error('The usage ledger did not accept the event.'));
          })
          .catch(warn);
      };
      if (options.transaction) options.transaction.afterCommit(persist);
      else persist();
    } catch (error) {
      warn(error);
    }
  };
  plugin.db.on('aiUsageEvents.afterCreate', onCreated);
  return () => plugin.db.off('aiUsageEvents.afterCreate', onCreated);
}

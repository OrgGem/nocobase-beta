/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

function positiveDays(value: unknown): number | null {
  const days = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(days) && days > 0 ? days : null;
}

export function getHarnessProfileRetentionDays(settings: unknown): number | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;

  const profileSettings = settings as Record<string, unknown>;
  const observability = profileSettings.observability;
  const canonicalDays =
    observability && typeof observability === 'object' && !Array.isArray(observability)
      ? positiveDays((observability as Record<string, unknown>).tracingRetentionDays)
      : null;

  return canonicalDays ?? positiveDays(profileSettings.tracingRetentionDays);
}

export async function resolveTracingRetentionDays(plugin: {
  db: {
    getRepository: (name: string) => { findOne?: (options: Record<string, unknown>) => Promise<unknown> } | undefined;
  };
  app: {
    logger?: {
      warn?: (
        message: string,
        meta?: { module?: string; submodule?: string; method?: string; [key: string]: unknown },
      ) => void;
    };
  };
}) {
  const envDays = positiveDays(process.env.ORCHESTRATOR_LOG_RETENTION_DAYS);
  if (envDays !== null) return envDays;
  try {
    const profile = await plugin.db.getRepository('agentHarnessProfiles')?.findOne?.({
      filter: { tag: 'default', enabled: true },
    });
    const record = profile as { get?: (name: string) => unknown; settings?: unknown } | undefined;
    const settings = typeof record?.get === 'function' ? record.get('settings') : record?.settings;
    const days = getHarnessProfileRetentionDays(asObject(settings));
    if (days !== null) return days;
  } catch (error) {
    plugin.app.logger?.warn?.('[AgentOrchestrator] Failed to load tracing retention policy', { error });
  }
  return 30;
}
import { asObject } from '../utils/ctx-utils';

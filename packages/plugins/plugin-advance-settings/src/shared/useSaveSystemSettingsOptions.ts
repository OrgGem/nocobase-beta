// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';
import { message } from 'antd';

type SystemSettingsRecord = {
  options?: Record<string, unknown>;
  [key: string]: unknown;
};

type SystemSettingsEnvelope = {
  data?: SystemSettingsRecord;
};

export type SystemSettingsController = {
  data?: SystemSettingsEnvelope;
  mutate?: (next: { data: SystemSettingsEnvelope }) => void;
};

type SaveRequestFn = (config: {
  url: string;
  method: 'post';
  data: { options: Record<string, unknown> };
}) => Promise<unknown>;

function extractResponseEnvelope(response: unknown): SystemSettingsEnvelope | null {
  if (!response || typeof response !== 'object' || !('data' in response)) {
    return null;
  }
  const outer = (response as { data?: unknown }).data;
  if (!outer || typeof outer !== 'object' || !('data' in outer)) {
    return null;
  }
  const inner = (outer as { data?: unknown }).data;
  if (!inner || typeof inner !== 'object') {
    return null;
  }
  return { data: inner as SystemSettingsRecord };
}

export function useSaveSystemSettingsOptions(
  request: SaveRequestFn,
  systemSettings: SystemSettingsController | undefined,
  t: (key: string) => string,
) {
  const [saving, setSaving] = useState(false);
  const loaded = Boolean(systemSettings?.data?.data);
  const currentOptions = systemSettings?.data?.data?.options;

  const saveOptions = async (patch: Record<string, unknown>) => {
    const currentRecord = systemSettings?.data?.data;
    if (!currentRecord || saving) {
      return;
    }
    setSaving(true);
    try {
      const options = {
        ...currentRecord.options,
        ...patch,
      };
      const response = await request({
        url: 'systemSettings:put',
        method: 'post',
        data: { options },
      });
      const nextEnvelope = extractResponseEnvelope(response) ?? {
        data: {
          ...currentRecord,
          options,
        },
      };
      systemSettings?.mutate?.({ data: nextEnvelope });
      message.success(t('Saved successfully'));
    } catch (error) {
      console.error('[AdvanceSettings] Failed to save setting:', error);
      message.error(t('Save failed'));
    } finally {
      setSaving(false);
    }
  };

  return { currentOptions, loaded, saving, saveOptions };
}

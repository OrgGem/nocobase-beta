import { Select } from 'antd';
import { useApp } from '@nocobase/client-v2';
import React, { useEffect, useState } from 'react';
import { useT } from '../locale';

interface StorageOption {
  id: number;
  name: string;
  type: string;
  default?: boolean;
}

interface StorageSelectProps {
  value?: number | string;
  onChange?: (value?: number) => void;
  allowClear?: boolean;
}

/**
 * Storage selector backed by the file-manager `storages` collection.
 * When nothing is selected the server falls back to the default storage.
 */
export const StorageSelect: React.FC<StorageSelectProps> = ({ value, onChange, allowClear = true }) => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient as unknown as {
    request: (opts: { url: string; params?: Record<string, unknown> }) => Promise<{ data?: { data?: unknown } }>;
  };
  const [storages, setStorages] = useState<StorageOption[]>([]);

  useEffect(() => {
    api
      .request({ url: 'storages:list', params: { paginate: false } })
      .then((res) => setStorages((res?.data?.data as StorageOption[] | undefined) ?? []))
      .catch(() => setStorages([]));
  }, [api]);

  return (
    <Select
      allowClear={allowClear}
      placeholder={t('Default storage (leave empty)') as string}
      value={value}
      onChange={onChange}
      options={storages.map((s) => ({
        value: s.id,
        label: `${s.name} (${s.type})${s.default ? ' — ' + t('default') : ''}`,
      }))}
    />
  );
};

export default StorageSelect;

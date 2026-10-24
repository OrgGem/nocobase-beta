import { useApp } from '@nocobase/client-v2';
import { Select } from 'antd';
import React, { useEffect, useState } from 'react';
import { COLLECTION } from '../../shared/constants';
import { useCarboneTranslation } from '../locale';

type TemplateId = string | number;
interface TemplateRow {
  id: TemplateId;
  name: string;
  enabled?: boolean;
}

export function readTemplateRows(response: unknown): TemplateRow[] {
  const data = (response as { data?: { data?: unknown } })?.data?.data;
  return Array.isArray(data)
    ? data.filter((row: unknown): row is TemplateRow => {
        if (!row || typeof row !== 'object') return false;
        const item = row as Record<string, unknown>;
        return (typeof item.id === 'number' || typeof item.id === 'string') && typeof item.name === 'string';
      })
    : [];
}

export default function TemplateSelect({
  value,
  onChange,
}: {
  value?: TemplateId | null;
  onChange?: (value: TemplateId | null) => void;
}) {
  const api = useApp().apiClient;
  const { t } = useCarboneTranslation();
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadTemplates() {
      setLoading(true);
      try {
        const response: unknown = await api.resource(COLLECTION.templates).list({
          pageSize: 200,
          sort: ['name'],
          fields: ['id', 'name', 'enabled', 'defaultOutputFormat'],
        });
        if (active) setRows(readTemplateRows(response));
      } catch {
        if (active) setRows([]);
      } finally {
        if (active) setLoading(false);
      }
    }
    loadTemplates();
    return () => {
      active = false;
    };
  }, [api]);

  return (
    <Select<TemplateId>
      style={{ width: '100%' }}
      showSearch
      allowClear
      loading={loading}
      optionFilterProp="label"
      value={value ?? undefined}
      onChange={(next) => onChange?.(next ?? null)}
      options={rows.map((row) => ({
        value: row.id,
        label: row.enabled === false ? `${row.name} (${t('Disabled')})` : row.name,
      }))}
    />
  );
}

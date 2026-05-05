import React, { useEffect, useState } from 'react';
import { Select } from 'antd';
import { useAPIClient } from '@nocobase/client';
import { COLLECTION } from '../../shared/constants';

interface TemplateRow {
  id: number;
  name: string;
  enabled?: boolean;
  defaultOutputFormat?: string;
}

/**
 * Lightweight template picker for the workflow node config form. Loads up to
 * 200 templates and shows them sorted by name. Disabled templates are dimmed
 * but remain selectable so an existing workflow doesn't break when a template
 * is paused.
 */
export const TemplateSelect: React.FC<{
  value?: number | null;
  onChange?: (v: number | null) => void;
}> = ({ value, onChange }) => {
  const api = useAPIClient();
  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api
      .resource(COLLECTION.templates)
      .list({ pageSize: 200, sort: ['name'], fields: ['id', 'name', 'enabled', 'defaultOutputFormat'] })
      .then((r: any) => setRows(r?.data?.data || []))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [api]);

  return (
    <Select
      style={{ width: '100%' }}
      showSearch
      allowClear
      loading={loading}
      optionFilterProp="label"
      value={value ?? undefined}
      onChange={(v) => onChange?.(v ?? null)}
      options={rows.map((r) => ({
        value: r.id,
        label: r.enabled === false ? `${r.name}  (disabled)` : r.name,
      }))}
    />
  );
};

export default TemplateSelect;

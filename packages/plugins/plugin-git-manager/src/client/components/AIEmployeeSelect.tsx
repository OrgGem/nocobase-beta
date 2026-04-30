import React, { useEffect, useState } from 'react';
import { Select } from 'antd';
import { useAPIClient } from '@nocobase/client';

interface AIEmployeeOption {
  username: string;
  nickname?: string;
  avatar?: string;
}

/**
 * Select dropdown listing AI employees the current user has access to.
 * Calls `aiEmployees:listByUser` from plugin-ai.
 */
export const AIEmployeeSelect: React.FC<{
  value?: string;
  onChange?: (value: string) => void;
  allowClear?: boolean;
  size?: 'small' | 'middle' | 'large';
  style?: React.CSSProperties;
  placeholder?: string;
}> = ({ value, onChange, allowClear = true, size, style, placeholder }) => {
  const api = useAPIClient();
  const [employees, setEmployees] = useState<AIEmployeeOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .request({ url: 'aiEmployees:listByUser' })
      .then((res) => {
        if (cancelled) return;
        const list = res?.data?.data || [];
        setEmployees(Array.isArray(list) ? list : []);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <Select
      value={value}
      onChange={onChange}
      allowClear={allowClear}
      loading={loading}
      size={size}
      style={style}
      placeholder={placeholder || 'Select AI employee'}
      options={employees.map((e) => ({
        value: e.username,
        label: `${e.nickname || e.username} (@${e.username})`,
      }))}
      showSearch
      optionFilterProp="label"
    />
  );
};

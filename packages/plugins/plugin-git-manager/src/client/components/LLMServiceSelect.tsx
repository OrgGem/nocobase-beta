import React, { useEffect, useState } from 'react';
import { Select } from 'antd';
import { useApp } from '@nocobase/client-v2';

interface LLMServiceOption {
  llmService: string;
  llmServiceTitle: string;
}

export const LLMServiceSelect: React.FC<{
  value?: string;
  onChange?: (value: string) => void;
  allowClear?: boolean;
  size?: 'small' | 'middle' | 'large';
  style?: React.CSSProperties;
  placeholder?: string;
}> = ({ value, onChange, allowClear = true, size, style, placeholder }) => {
  const api = useApp().apiClient;
  const [services, setServices] = useState<LLMServiceOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .request({ url: 'ai:listAllEnabledModels' })
      .then((res) => {
        if (cancelled) return;
        const list = res?.data?.data || [];
        setServices(Array.isArray(list) ? list : []);
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
      placeholder={placeholder || 'Select LLM Service'}
      options={services.map((s) => ({
        value: s.llmService,
        label: s.llmServiceTitle || s.llmService,
      }))}
      showSearch
      optionFilterProp="label"
    />
  );
};

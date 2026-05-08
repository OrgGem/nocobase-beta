import React, { useEffect, useState } from 'react';
import { Select } from 'antd';
import { useAPIClient } from '@nocobase/client';

export const LLMModelSelect: React.FC<{
  llmService?: string;
  value?: string;
  onChange?: (value: string) => void;
  allowClear?: boolean;
  size?: 'small' | 'middle' | 'large';
  style?: React.CSSProperties;
  placeholder?: string;
}> = ({ llmService, value, onChange, allowClear = true, size, style, placeholder }) => {
  const api = useAPIClient();
  const [models, setModels] = useState<{ id: string }[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!llmService) {
      setModels([]);
      return;
    }
    
    setLoading(true);
    api
      .request({ url: 'ai:listModels', params: { llmService } })
      .then((res) => {
        if (cancelled) return;
        const list = res?.data?.data || [];
        setModels(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
      
    return () => {
      cancelled = true;
    };
  }, [api, llmService]);

  return (
    <Select
      value={value}
      onChange={onChange}
      allowClear={allowClear}
      loading={loading}
      size={size}
      style={style}
      placeholder={placeholder || 'Select LLM Model'}
      options={models.map((m) => ({
        value: m.id,
        label: m.id,
      }))}
      showSearch
      optionFilterProp="label"
      disabled={!llmService}
    />
  );
};

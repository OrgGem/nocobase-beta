import React, { useState, useEffect } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Select } from 'antd';
import { useField } from '@formily/react';
import { Field } from '@formily/core';

export const LLMServiceSelect = (props: any) => {
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const api = useAPIClient();
  const field = useField<Field>();

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.resource('ai').listLLMServices()
      .then((res) => {
        if (!active) return;
        const data = res?.data?.data || [];
        setOptions(
          data.map((item: any) => ({
            label: item.title || item.name,
            value: item.name,
          }))
        );
      })
      .catch((err) => {
        if (!active) return;
        console.error('Failed to load LLM services:', err);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api]);

  return <Select {...props} options={options} loading={loading} value={field.value} onChange={(v) => {
    field.setValue(v);
    // Reset model when service changes
    (field.query('.model').take() as any)?.setValue(undefined);
  }} />;
};

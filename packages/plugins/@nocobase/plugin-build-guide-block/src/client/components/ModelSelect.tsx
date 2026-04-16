import React, { useState, useEffect } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Select } from 'antd';
import { useField, useForm, observer } from '@formily/react';
import { Field } from '@formily/core';

export const ModelSelect = observer((props: any) => {
  const [options, setOptions] = useState([]);
  const api = useAPIClient();
  const field = useField<Field>();
  const form = useForm();
  
  const llmService = form.values.llmService;

  useEffect(() => {
    let active = true;
    if (!llmService) {
      setOptions([]);
      return;
    }
    
    api.resource('ai').listModels({ llmService }).then((res) => {
      if (!active) return;
      const data = res?.data?.data || [];
      setOptions(
        data.map((item: any) => ({
          label: item.id || item.name,
          value: item.id || item.name,
        }))
      );
    }).catch(console.error);

    return () => {
      active = false;
    };
  }, [api, llmService]);

  return <Select {...props} options={options} value={field.value} onChange={(v) => {
    field.setValue(v);
  }} disabled={!llmService} />;
});

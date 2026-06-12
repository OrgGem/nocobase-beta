import React, { useCallback, useEffect, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Select, SelectProps } from 'antd';
import { useField, useForm, observer } from '@formily/react';
import { Field } from '@formily/core';
import { useT } from '../locale';

interface SelectOption {
  label: string;
  value: string;
}

/**
 * Shape of a single model record returned by `ai:listModels`. Providers vary
 * on whether they return `id` or `name`, so both are optional and handled.
 */
interface ModelRecord {
  id?: string;
  name?: string;
}

function normalizeRecords(response: unknown): ModelRecord[] {
  const data = (response as { data?: { data?: unknown } } | undefined)?.data?.data;
  return Array.isArray(data) ? (data as ModelRecord[]) : [];
}

export type ModelSelectProps = Omit<SelectProps<string>, 'options' | 'loading' | 'value' | 'onChange' | 'disabled'>;

/**
 * Formily-aware Select that lists the models available for the currently
 * selected LLM service. It observes `form.values.llmService` and:
 *
 * - Req 4.2: loads models via `api.resource('ai').listModels({ llmService })`.
 * - stays disabled until a service is selected.
 * - clears its own value and options when the service changes, so a model
 *   from a previous service is never left selected.
 * - Req 4.5: surfaces a load failure as an error state instead of throwing.
 */
export const ModelSelect = observer((props: ModelSelectProps) => {
  const t = useT();
  const api = useAPIClient();
  const field = useField<Field>();
  const form = useForm();
  const [options, setOptions] = useState<SelectOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

  const llmService = typeof form.values?.llmService === 'string' ? form.values.llmService : undefined;

  useEffect(() => {
    let active = true;
    if (!llmService) {
      setOptions([]);
      setHasError(false);
      return;
    }
    const loadModels = async () => {
      setLoading(true);
      setHasError(false);
      try {
        const res: unknown = await api.resource('ai').listModels({ llmService });
        if (!active) return;
        const next = normalizeRecords(res)
          .map((item) => item.id || item.name)
          .filter((value): value is string => Boolean(value))
          .map<SelectOption>((value) => ({ label: value, value }));
        setOptions(next);
      } catch (err: unknown) {
        if (!active) return;
        console.error('Failed to load models:', err);
        setOptions([]);
        setHasError(true);
      } finally {
        if (active) setLoading(false);
      }
    };
    loadModels();
    return () => {
      active = false;
    };
  }, [api, llmService]);

  const handleChange = useCallback(
    (value: string) => {
      field.setValue(value);
    },
    [field],
  );

  return (
    <Select<string>
      {...props}
      options={options}
      loading={loading}
      status={hasError ? 'error' : undefined}
      value={field.value}
      onChange={handleChange}
      disabled={!llmService}
      notFoundContent={hasError ? t('Failed to load the list') : undefined}
      allowClear
      showSearch
      optionFilterProp="label"
    />
  );
});

import React, { useCallback, useEffect, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Select, SelectProps } from 'antd';
import { useField } from '@formily/react';
import { Field, isField } from '@formily/core';
import { useT } from '../locale';

interface SelectOption {
  label: string;
  value: string;
}

/**
 * Shape of a single LLM service record returned by `ai:listLLMServices`.
 * Only the fields this component relies on are declared; everything else is
 * ignored.
 */
interface LLMServiceRecord {
  name?: string;
  title?: string;
}

/**
 * Pull the `{ data: { data: [...] } }` list payload out of an API response
 * without resorting to `any`. Unknown shapes degrade to an empty list.
 */
function normalizeRecords(response: unknown): LLMServiceRecord[] {
  const data = (response as { data?: { data?: unknown } } | undefined)?.data?.data;
  return Array.isArray(data) ? (data as LLMServiceRecord[]) : [];
}

export type LLMServiceSelectProps = Omit<SelectProps<string>, 'options' | 'loading' | 'value' | 'onChange'>;

/**
 * Formily-aware Select that loads the available LLM services from the AI
 * plugin (`ai:listLLMServices`). Selecting a service clears the sibling
 * `model` field so a stale model is never submitted with a new service.
 *
 * - Req 4.1: loads services from `api.resource('ai').listLLMServices()`.
 * - Req 4.5: surfaces a load failure as an error state (empty option list +
 *   a status message) rather than throwing.
 * - Req 4.6: clears the sibling `model` field on change.
 */
export const LLMServiceSelect = (props: LLMServiceSelectProps) => {
  const t = useT();
  const api = useAPIClient();
  const field = useField<Field>();
  const [options, setOptions] = useState<SelectOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let active = true;
    const loadServices = async () => {
      setLoading(true);
      setHasError(false);
      try {
        const res: unknown = await api.resource('ai').listLLMServices();
        if (!active) return;
        const next = normalizeRecords(res)
          .filter((item): item is LLMServiceRecord & { name: string } => Boolean(item.name))
          .map<SelectOption>((item) => ({
            label: item.title || item.name,
            value: item.name,
          }));
        setOptions(next);
      } catch (err: unknown) {
        if (!active) return;
        console.error('Failed to load LLM services:', err);
        setOptions([]);
        setHasError(true);
      } finally {
        if (active) setLoading(false);
      }
    };
    loadServices();
    return () => {
      active = false;
    };
  }, [api]);

  const handleChange = useCallback(
    (value: string) => {
      field.setValue(value);
      // Reset the sibling model field whenever the service changes (Req 4.6).
      const sibling = field.query('.model').take();
      if (isField(sibling)) {
        sibling.setValue(undefined);
      }
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
      notFoundContent={hasError ? t('Failed to load the list') : undefined}
      allowClear
      showSearch
      optionFilterProp="label"
    />
  );
};

import React, { useEffect, useState } from 'react';
import { Select, Spin } from 'antd';
import { useAPIClient } from '@nocobase/client';

/**
 * Dropdown to select an existing proxy service (slug).
 * Fetches from proxyServices collection.
 */
export const ProxyServiceSelect = (props: any) => {
  const { value, onChange, placeholder } = props;
  const api = useAPIClient();
  const [loading, setLoading] = useState(true);
  const [options, setOptions] = useState<{ label: string; value: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.request({
          url: 'proxyServices:list',
          params: { filter: { enabled: true }, pageSize: 200 },
        });
        const rows = res?.data?.data || [];
        if (!cancelled) {
          setOptions(
            rows.map((r: any) => ({
              label: r.title || r.slug,
              value: r.slug,
            })),
          );
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <Spin size="small" />;

  return (
    <Select
      value={value}
      onChange={onChange}
      placeholder={placeholder || 'Select a proxy service'}
      options={options}
      showSearch
      optionFilterProp="label"
      allowClear
    />
  );
};

/**
 * Hook returning options for the initializer sub-menu.
 */
export function useProxyServiceOptions() {
  const api = useAPIClient();
  const [loading, setLoading] = useState(true);
  const [options, setOptions] = useState<{ label: string; value: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.request({
          url: 'proxyServices:list',
          params: { filter: { enabled: true }, pageSize: 200 },
        });
        const rows = res?.data?.data || [];
        if (!cancelled) {
          setOptions(
            rows.map((r: any) => ({
              label: r.title || r.slug,
              value: r.slug,
            })),
          );
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { loading, options };
}

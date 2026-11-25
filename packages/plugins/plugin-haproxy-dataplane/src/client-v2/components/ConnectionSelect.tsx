// SPDX-License-Identifier: Apache-2.0

import { Select } from 'antd';
import React, { useEffect, useState } from 'react';
import type { HaproxyConnectionPublic } from '../../shared/types';
import { useHaproxyApi } from '../api';
import { useT } from '../locale';

export interface ConnectionSelectProps {
  value?: number | null;
  onChange?: (value?: number) => void;
}

export const ConnectionSelect: React.FC<ConnectionSelectProps> = ({ value, onChange }) => {
  const t = useT();
  const api = useHaproxyApi();
  const [connections, setConnections] = useState<HaproxyConnectionPublic[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;
    const fetchConnections = async () => {
      setLoading(true);
      try {
        const rows = await api.listConnections();
        if (mounted) {
          setConnections(rows.filter((r) => r.enabled));
        }
      } catch {
        if (mounted) {
          setConnections([]);
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };
    fetchConnections();
    return () => {
      mounted = false;
    };
  }, [api]);

  return (
    <Select
      allowClear
      loading={loading}
      value={value ?? undefined}
      placeholder={t('Allow switching all enabled nodes')}
      onChange={(nextVal: number | undefined) => onChange?.(nextVal)}
      options={connections.map((conn) => ({
        value: conn.id,
        label: conn.title ? `${conn.title} (${conn.name})` : conn.name,
      }))}
    />
  );
};

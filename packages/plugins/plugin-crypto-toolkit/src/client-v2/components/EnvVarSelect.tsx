import { KeyOutlined } from '@ant-design/icons';
import { AutoComplete, Space, Tag } from 'antd';
import React, { useEffect, useState } from 'react';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../locale';

interface EnvVariableOption {
  name: string;
  type?: string;
}

export interface EnvVarSelectProps {
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
}

/**
 * Env var name picker: suggests the app's registered environment variables
 * but still accepts typed names (e.g. vars only present in process.env).
 */
export const EnvVarSelect: React.FC<EnvVarSelectProps> = ({ value, onChange, disabled }) => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;
  const [envVariables, setEnvVariables] = useState<EnvVariableOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .request({ url: 'environmentVariables:list', params: { paginate: false } })
      .then((res) => {
        if (cancelled) return;
        const list = (res?.data?.data as EnvVariableOption[] | undefined) ?? [];
        const sorted = [...list].sort((a, b) => {
          const rank = (v: EnvVariableOption) => (v.type === 'secret' ? 0 : 1);
          return rank(a) - rank(b) || a.name.localeCompare(b.name);
        });
        setEnvVariables(sorted);
      })
      .catch(() => {
        if (!cancelled) setEnvVariables([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <AutoComplete
      value={value}
      onChange={(next) => onChange?.(next)}
      disabled={disabled}
      placeholder={t('Select environment variable') as string}
      style={{ width: '100%' }}
      aria-label={t('Environment variable') as string}
      notFoundContent={t('No environment variables available') as string}
      filterOption={(input, option) =>
        String(option?.value ?? '')
          .toLowerCase()
          .includes(input.toLowerCase())
      }
      options={envVariables.map((env) => ({
        value: env.name,
        label: (
          <Space>
            <KeyOutlined />
            <span style={{ fontFamily: 'monospace' }}>{env.name}</span>
            <Tag color={env.type === 'secret' ? 'red' : 'blue'} style={{ fontSize: 10, margin: 0 }}>
              {env.type ?? 'default'}
            </Tag>
          </Space>
        ),
      }))}
    />
  );
};

export default EnvVarSelect;

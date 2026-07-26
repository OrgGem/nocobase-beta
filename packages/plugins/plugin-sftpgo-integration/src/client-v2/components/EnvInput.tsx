import { KeyOutlined } from '@ant-design/icons';
import { Button, Dropdown, Input, type InputProps, Space, Tag } from 'antd';
import React from 'react';
import { useT } from '../locale';

export interface EnvVariableOption {
  name: string;
  type?: 'default' | 'secret' | string;
}

export interface EnvInputProps extends Omit<InputProps, 'onChange'> {
  value?: string;
  onChange?: (value: string) => void;
  isPassword?: boolean;
  envVariables?: EnvVariableOption[];
}

export const EnvInput: React.FC<EnvInputProps> = ({
  value = '',
  onChange,
  isPassword = false,
  envVariables = [],
  placeholder,
  disabled,
  ...restProps
}) => {
  const t = useT();

  const handleSelectEnv = (envName: string) => {
    if (onChange) {
      onChange(`{{$env.${envName}}}`);
    }
  };

  const menuItems =
    envVariables.length > 0
      ? envVariables.map((env) => ({
          key: env.name,
          label: (
            <Space>
              <span style={{ fontFamily: 'monospace' }}>{`{{$env.${env.name}}}`}</span>
              <Tag color={env.type === 'secret' ? 'red' : 'blue'} style={{ fontSize: 10, margin: 0 }}>
                {env.type || 'default'}
              </Tag>
            </Space>
          ),
          onClick: () => handleSelectEnv(env.name),
        }))
      : [
          {
            key: 'empty',
            disabled: true,
            label: <span>{t('No environment variables available')}</span>,
          },
        ];

  const addonAfterNode = (
    <Dropdown menu={{ items: menuItems }} placement="bottomRight" disabled={disabled}>
      <Button
        type="text"
        size="small"
        icon={<KeyOutlined />}
        title={t('Select environment variable') as string}
        aria-label={t('Select environment variable') as string}
        style={{ padding: '0 4px', height: 'auto' }}
      >
        <span style={{ fontSize: 12, fontWeight: 'bold' }}>$env</span>
      </Button>
    </Dropdown>
  );

  if (isPassword) {
    return (
      <Input.Password
        {...restProps}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        addonAfter={addonAfterNode}
      />
    );
  }

  return (
    <Input
      {...restProps}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      addonAfter={addonAfterNode}
    />
  );
};

export default EnvInput;

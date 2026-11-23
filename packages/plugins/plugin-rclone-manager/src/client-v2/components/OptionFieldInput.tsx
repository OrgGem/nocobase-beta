// SPDX-License-Identifier: Apache-2.0

import { AutoComplete, Form, Input, InputNumber, Switch } from 'antd';
import React from 'react';
import type { RcloneProviderOption } from '../../shared/types';

export interface OptionFieldInputProps {
  option: RcloneProviderOption;
}

export const OptionFieldInput: React.FC<OptionFieldInputProps> = ({ option }) => {
  const fieldType = (option.Type ?? 'string').toLowerCase();
  const isBool = fieldType === 'bool' || typeof option.Default === 'boolean';
  const isInt = fieldType === 'int' || fieldType === 'int64' || fieldType === 'uint32';
  const label = option.Name;
  const helpText = option.Help ? option.Help.split('\n')[0] : undefined;

  if (isBool) {
    return (
      <Form.Item name={['parameters', option.Name]} label={label} extra={helpText} valuePropName="checked">
        <Switch />
      </Form.Item>
    );
  }

  if (option.IsPassword || option.Sensitive) {
    return (
      <Form.Item
        name={['parameters', option.Name]}
        label={label}
        extra={helpText}
        rules={option.Required ? [{ required: true }] : undefined}
      >
        <Input.Password autoComplete="new-password" placeholder={option.DefaultStr || ''} />
      </Form.Item>
    );
  }

  if (isInt && (!option.Examples || option.Examples.length === 0)) {
    return (
      <Form.Item
        name={['parameters', option.Name]}
        label={label}
        extra={helpText}
        rules={option.Required ? [{ required: true }] : undefined}
      >
        <InputNumber style={{ width: '100%' }} placeholder={option.DefaultStr || ''} />
      </Form.Item>
    );
  }

  if (option.Examples && option.Examples.length > 0) {
    const exampleOptions = option.Examples.map((ex) => {
      const help = (ex.Help ?? '').trim();
      const shortHelp = help.length > 72 ? `${help.slice(0, 72)}…` : help;
      return {
        value: ex.Value,
        label: shortHelp ? `${ex.Value} — ${shortHelp}` : ex.Value,
        title: help ? `${ex.Value} — ${help}` : ex.Value,
        searchText: `${ex.Value} ${help}`.toLowerCase(),
      };
    });

    return (
      <Form.Item
        name={['parameters', option.Name]}
        label={label}
        extra={helpText}
        rules={option.Required ? [{ required: true }] : undefined}
      >
        <AutoComplete
          allowClear
          popupMatchSelectWidth
          listHeight={280}
          style={{ width: '100%' }}
          placeholder={option.DefaultStr || ''}
          options={exampleOptions}
          filterOption={(input, opt) => String(opt?.searchText ?? '').includes(input.trim().toLowerCase())}
        />
      </Form.Item>
    );
  }

  return (
    <Form.Item
      name={['parameters', option.Name]}
      label={label}
      extra={helpText}
      rules={option.Required ? [{ required: true }] : undefined}
    >
      <Input placeholder={option.DefaultStr || ''} />
    </Form.Item>
  );
};

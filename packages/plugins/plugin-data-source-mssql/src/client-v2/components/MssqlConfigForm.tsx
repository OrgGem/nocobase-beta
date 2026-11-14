/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Checkbox, Form, Input, InputNumber, Select } from 'antd';
import { useFlowContext } from '@nocobase/flow-engine';
import type { DataSourceSettingsFormProps } from '@nocobase/plugin-data-source-manager/client-v2';
import { useTranslation } from 'react-i18next';

const CONNECTION_FIELDS = [
  'host',
  'port',
  'database',
  'schema',
  'username',
  'password',
  'encrypt',
  'tablePrefix',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function toCollectionOptions(result: unknown): { label: string; value: string }[] {
  const data = isRecord(result) ? result.data : result;
  const list = isRecord(data) ? data.data : data;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: unknown) => {
    const name = typeof item === 'string' ? item : isRecord(item) ? item.name : undefined;
    return typeof name === 'string' ? [{ label: name, value: name }] : [];
  });
}

export const MssqlConfigForm: React.FC<DataSourceSettingsFormProps> = ({ mode, initialValues, loadCollections }) => {
  const { t } = useTranslation();
  const form = Form.useFormInstance();
  const ctx = useFlowContext();
  const addAllCollections = Form.useWatch(['options', 'addAllCollections'], form);
  const host = Form.useWatch(['options', 'host'], form);
  const port = Form.useWatch(['options', 'port'], form);
  const database = Form.useWatch(['options', 'database'], form);
  const schema = Form.useWatch(['options', 'schema'], form);
  const username = Form.useWatch(['options', 'username'], form);
  const password = Form.useWatch(['options', 'password'], form);
  const encrypt = Form.useWatch(['options', 'encrypt'], form);
  const tablePrefix = Form.useWatch(['options', 'tablePrefix'], form);
  const [collectionOptions, setCollectionOptions] = useState<{ label: string; value: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const requestGeneration = useRef(0);
  const hasLoaded = useRef(false);
  const isLoading = useRef(false);
  const cachedConnection = useRef<unknown[]>();
  const savedSelection = initialValues?.options?.selectedCollections;
  const preserveLegacySelection =
    mode === 'edit' && initialValues?.options?.addAllCollections === false && !Array.isArray(savedSelection);

  useEffect(() => {
    if (mode === 'edit' && Array.isArray(savedSelection) && form.getFieldValue('collections') === undefined) {
      form.setFieldValue('collections', savedSelection);
    }
  }, [form, mode, savedSelection]);

  useEffect(() => {
    requestGeneration.current += 1;
    hasLoaded.current = false;
    isLoading.current = false;
    cachedConnection.current = undefined;
    setCollectionOptions([]);
    setLoading(false);
  }, [host, port, database, schema, username, password, encrypt, tablePrefix]);

  const handleLoadCollections = useCallback(async () => {
    const values = form.getFieldsValue(true);
    const connection = [values.key, ...CONNECTION_FIELDS.map((field) => values.options?.[field])];
    const sameConnection = cachedConnection.current?.every((value, index) => value === connection[index]);
    if (sameConnection && (hasLoaded.current || isLoading.current)) return;
    if (!sameConnection) {
      requestGeneration.current += 1;
      hasLoaded.current = false;
      cachedConnection.current = connection;
    }
    isLoading.current = true;
    const generation = requestGeneration.current;
    setLoading(true);
    try {
      const connectionChanged = CONNECTION_FIELDS.some(
        (field) => values.options?.[field] !== initialValues?.options?.[field],
      );
      const result =
        mode === 'create' || connectionChanged
          ? (
              await ctx.api
                .resource('dataSources')
                .readTables({ values: { dataSourceKey: values.key, dbOptions: { ...values.options, type: 'mssql' } } })
            ).data
          : await loadCollections(String(initialValues.key));
      if (generation === requestGeneration.current) {
        setCollectionOptions(toCollectionOptions(result));
        hasLoaded.current = true;
      }
    } catch {
      if (generation === requestGeneration.current) {
        ctx.message.error(String(t('Unable to load collections')));
      }
    } finally {
      if (generation === requestGeneration.current) {
        isLoading.current = false;
        setLoading(false);
      }
    }
  }, [ctx, form, loadCollections, initialValues, mode, t]);

  return (
    <>
      <Form.Item name={['options', 'host']} label={t('Host')} rules={[{ required: true }]}>
        <Input placeholder="localhost" />
      </Form.Item>
      <Form.Item name={['options', 'port']} label={t('Port')} rules={[{ required: true }]} initialValue={1433}>
        <InputNumber min={1} max={65535} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item name={['options', 'database']} label={t('Database')} rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item name={['options', 'schema']} label={t('Schema')}>
        <Input />
      </Form.Item>
      <Form.Item name={['options', 'username']} label={t('Username')} rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item name={['options', 'password']} label={t('Password')}>
        <Input.Password />
      </Form.Item>
      <Form.Item name={['options', 'encrypt']} label={t('Encrypt')} valuePropName="checked">
        <Checkbox />
      </Form.Item>
      <Form.Item name={['options', 'tablePrefix']} label={t('Table prefix')}>
        <Input />
      </Form.Item>
      <Form.Item
        name={['options', 'addAllCollections']}
        label={t('Load all collections')}
        valuePropName="checked"
        initialValue={initialValues?.options?.addAllCollections ?? initialValues?.addAllCollections ?? true}
      >
        <Checkbox />
      </Form.Item>
      <Form.Item name="__mssqlPreserveLegacySelection" initialValue={preserveLegacySelection} hidden>
        <input type="hidden" />
      </Form.Item>
      {!addAllCollections ? (
        <Form.Item name="collections" label={t('Collections')}>
          <Select
            mode="multiple"
            allowClear
            loading={loading}
            options={collectionOptions}
            onFocus={handleLoadCollections}
            onChange={() => form.setFieldValue('__mssqlPreserveLegacySelection', false)}
            optionFilterProp="label"
          />
        </Form.Item>
      ) : null}
    </>
  );
};

export default MssqlConfigForm;

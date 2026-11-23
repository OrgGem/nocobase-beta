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
import { DATA_SOURCE_TYPE, DEFAULT_PORT, DEFAULT_SCHEMA, NAMESPACE } from '../constants';
import { toCollectionOptions } from './collection-options';

const CONNECTION_FIELDS = ['host', 'port', 'database', 'schema', 'username', 'password', 'ssl', 'sslCa'] as const;

function normalizeConnectionField(field: (typeof CONNECTION_FIELDS)[number], options?: Record<string, unknown>) {
  const value = options?.[field];
  if (field === 'port') return Number(value ?? DEFAULT_PORT);
  if (field === 'schema') return typeof value === 'string' && value ? value : DEFAULT_SCHEMA;
  if (field === 'ssl') return Boolean(value);
  if (field === 'sslCa') return value ?? '';
  return value;
}

export default function PostgresConfigForm({ mode, initialValues, loadCollections }: DataSourceSettingsFormProps) {
  const { t } = useTranslation(NAMESPACE);
  const ctx = useFlowContext();
  const form = Form.useFormInstance();
  const watchedAddAll = Form.useWatch(['options', 'addAllCollections'], form);
  const host = Form.useWatch(['options', 'host'], form);
  const port = Form.useWatch(['options', 'port'], form);
  const database = Form.useWatch(['options', 'database'], form);
  const schema = Form.useWatch(['options', 'schema'], form);
  const username = Form.useWatch(['options', 'username'], form);
  const password = Form.useWatch(['options', 'password'], form);
  const ssl = Form.useWatch(['options', 'ssl'], form);
  const sslCa = Form.useWatch(['options', 'sslCa'], form);
  const [collectionOptions, setCollectionOptions] = useState<{ label: string; value: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const requestGeneration = useRef(0);
  const cachedConnection = useRef<unknown[]>();
  const hasLoaded = useRef(false);
  const isLoading = useRef(false);
  const savedSelection = initialValues?.options?.selectedCollections;
  const initialAddAll = initialValues?.options?.addAllCollections ?? initialValues?.options?.autoDiscover !== false;
  const addAllCollections = watchedAddAll ?? initialAddAll;
  const preserveLegacySelection = mode === 'edit' && !initialAddAll && !Array.isArray(savedSelection);

  useEffect(() => {
    if (form.getFieldValue(['options', 'host']) === undefined) {
      form.setFieldValue(['options', 'host'], 'localhost');
    }
    if (form.getFieldValue(['options', 'port']) === undefined) {
      form.setFieldValue(['options', 'port'], DEFAULT_PORT);
    }
    if (form.getFieldValue(['options', 'schema']) === undefined) {
      form.setFieldValue(['options', 'schema'], DEFAULT_SCHEMA);
    }
    if (form.getFieldValue(['options', 'ssl']) === undefined) {
      form.setFieldValue(['options', 'ssl'], false);
    }
    if (form.getFieldValue(['options', 'addAllCollections']) === undefined) {
      form.setFieldValue(['options', 'addAllCollections'], initialAddAll);
    }
    if (form.getFieldValue('__postgresPreserveLegacySelection') === undefined) {
      form.setFieldValue('__postgresPreserveLegacySelection', preserveLegacySelection);
    }
    if (mode === 'edit' && Array.isArray(savedSelection) && form.getFieldValue('collections') === undefined) {
      form.setFieldValue('collections', savedSelection);
    }
  }, [form, initialAddAll, mode, preserveLegacySelection, savedSelection]);

  useEffect(() => {
    requestGeneration.current += 1;
    cachedConnection.current = undefined;
    hasLoaded.current = false;
    isLoading.current = false;
    setCollectionOptions([]);
    setLoading(false);
  }, [host, port, database, schema, username, password, ssl, sslCa]);

  const handleLoadCollections = useCallback(async () => {
    const values = form.getFieldsValue(true);
    const connection = [
      values.key,
      ...CONNECTION_FIELDS.map((field) => normalizeConnectionField(field, values.options)),
    ];
    const sameConnection = cachedConnection.current?.every((value, index) => value === connection[index]);
    if (sameConnection && (hasLoaded.current || isLoading.current)) return;
    if (!sameConnection) {
      requestGeneration.current += 1;
      cachedConnection.current = connection;
      hasLoaded.current = false;
    }
    const generation = requestGeneration.current;
    isLoading.current = true;
    setLoading(true);
    try {
      const connectionChanged = CONNECTION_FIELDS.some(
        (field) =>
          normalizeConnectionField(field, values.options) !== normalizeConnectionField(field, initialValues?.options),
      );
      const result =
        mode === 'create' || connectionChanged
          ? (
              await ctx.api.resource('dataSources').readTables({
                values: { dataSourceKey: values.key, dbOptions: { ...values.options, type: DATA_SOURCE_TYPE } },
              })
            ).data
          : await loadCollections(String(initialValues?.key));
      if (generation === requestGeneration.current) {
        setCollectionOptions(toCollectionOptions(result));
        hasLoaded.current = true;
      }
    } catch {
      if (generation === requestGeneration.current) ctx.message.error(String(t('Unable to load collections')));
    } finally {
      if (generation === requestGeneration.current) {
        isLoading.current = false;
        setLoading(false);
      }
    }
  }, [ctx, form, initialValues, loadCollections, mode, t]);

  return (
    <>
      <Form.Item name={['options', 'host']} label={t('Host')} rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item name={['options', 'port']} label={t('Port')} rules={[{ required: true }]}>
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
      <Form.Item name={['options', 'ssl']} label={t('Use SSL')} valuePropName="checked">
        <Checkbox />
      </Form.Item>
      {ssl ? (
        <Form.Item name={['options', 'sslCa']} label={t('CA certificate (PEM)')}>
          <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} />
        </Form.Item>
      ) : null}
      <Form.Item name={['options', 'addAllCollections']} label={t('Load all collections')} valuePropName="checked">
        <Checkbox />
      </Form.Item>
      <Form.Item name="__postgresPreserveLegacySelection" hidden>
        <Input />
      </Form.Item>
      {!addAllCollections ? (
        <Form.Item name="collections" label={t('Collections')}>
          <Select
            mode="multiple"
            allowClear
            loading={loading}
            options={collectionOptions}
            optionFilterProp="label"
            onFocus={handleLoadCollections}
            onChange={() => form.setFieldValue('__postgresPreserveLegacySelection', false)}
          />
        </Form.Item>
      ) : null}
    </>
  );
}

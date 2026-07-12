/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Checkbox, Form, Input, Select } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type CollectionOption = {
  label: string;
  value: string;
};

interface ElasticsearchConfigFormProps {
  mode: 'create' | 'edit';
  type: Record<string, unknown>;
  initialValues?: Record<string, unknown>;
  loadCollections: (key?: string) => Promise<unknown>;
  loadCollectionsFromValues?: (values: Record<string, unknown>) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function toCollectionOptions(result: unknown): CollectionOption[] {
  const data = isRecord(result) ? result.data : undefined;
  const nestedData = isRecord(data) ? data.data : undefined;
  const list = Array.isArray(nestedData)
    ? nestedData
    : Array.isArray(data)
      ? data
      : Array.isArray(result)
        ? result
        : [];

  return list
    .map((item) => {
      const name = typeof item === 'string' ? item : isRecord(item) && typeof item.name === 'string' ? item.name : '';
      return name ? { label: name, value: name } : undefined;
    })
    .filter((item): item is CollectionOption => !!item);
}

function getInitialSelectedCollections(initialValues?: Record<string, unknown>): string[] {
  const options = isRecord(initialValues?.options) ? initialValues.options : {};
  const selectedCollections = options.selectedCollections;
  return Array.isArray(selectedCollections)
    ? selectedCollections.filter((item): item is string => typeof item === 'string')
    : [];
}

export const ElasticsearchConfigForm: React.FC<ElasticsearchConfigFormProps> = ({
  mode,
  initialValues,
  loadCollections,
  loadCollectionsFromValues,
}) => {
  const { t } = useTranslation();
  const form = Form.useFormInstance();
  const addAllCollections = Form.useWatch(['options', 'addAllCollections'], form);
  const [collectionOptions, setCollectionOptions] = useState<CollectionOption[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (mode !== 'edit') {
      return;
    }

    const selectedCollections = getInitialSelectedCollections(initialValues);
    if (selectedCollections.length && !form.getFieldValue('collections')) {
      form.setFieldValue('collections', selectedCollections);
    }
  }, [form, initialValues, mode]);

  const handleLoadCollections = useCallback(async () => {
    setLoading(true);
    try {
      const values = form.getFieldsValue(true);
      const result =
        mode === 'create' && loadCollectionsFromValues
          ? await loadCollectionsFromValues(values)
          : await loadCollections((initialValues?.key as string | undefined) || (values.key as string | undefined));
      setCollectionOptions(toCollectionOptions(result));
    } finally {
      setLoading(false);
    }
  }, [form, initialValues?.key, loadCollections, loadCollectionsFromValues, mode]);

  return (
    <>
      <Form.Item
        name={['options', 'nodes']}
        label={t('Elasticsearch Nodes')}
        rules={[{ required: true }]}
        extra={t('Comma-separated list of Elasticsearch node URLs')}
      >
        <Input placeholder="http://localhost:9200" />
      </Form.Item>
      <Form.Item name={['options', 'username']} label={t('Username')} extra={t('Optional. For Basic authentication.')}>
        <Input />
      </Form.Item>
      <Form.Item name={['options', 'password']} label={t('Password')}>
        <Input.Password />
      </Form.Item>
      <Form.Item name={['options', 'apiKey']} label={t('API Key')} extra={t('API Key description')}>
        <Input />
      </Form.Item>
      <Form.Item
        name={['options', 'rejectUnauthorized']}
        label={t('Verify TLS Certificate')}
        valuePropName="checked"
        initialValue={true}
        extra={t('Uncheck for self-signed certificates')}
      >
        <Checkbox />
      </Form.Item>
      <Form.Item
        name={['options', 'indexPattern']}
        label={t('Index Pattern')}
        extra={t('Filter indices by pattern (e.g. logs-*, my-data-*)')}
      >
        <Input placeholder="*" />
      </Form.Item>
      <Form.Item
        name={['options', 'addAllCollections']}
        label={t('Load all collections')}
        valuePropName="checked"
        initialValue={true}
      >
        <Checkbox />
      </Form.Item>
      {!addAllCollections ? (
        <Form.Item name="collections" label={t('Collections')}>
          <Select
            mode="multiple"
            allowClear
            loading={loading}
            options={collectionOptions}
            onFocus={handleLoadCollections}
            optionFilterProp="label"
          />
        </Form.Item>
      ) : null}
    </>
  );
};

export default ElasticsearchConfigForm;

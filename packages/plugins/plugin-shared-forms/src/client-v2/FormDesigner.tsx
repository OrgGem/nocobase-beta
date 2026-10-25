/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { useApp } from '@nocobase/client-v2';
import { FormItemModel } from '@nocobase/client-v2';
import { useFlowEngine } from '@nocobase/flow-engine';
import { useRequest } from 'ahooks';
import { Alert, App, Button, Input, QRCode, Select, Space, Spin, Switch, Typography } from 'antd';
import React, { useCallback, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { collectionBinding, legacyFields, parseConfig, type SharedFormConfig } from '../shared/v2Config';
import type { FormRecord } from './AdminForms';
import { NativeForm, type FormMetadata } from './NativeForm';
import { formModelOptions, type SharedFormModel } from './models';
import { useT } from './locale';

function DesignerForKey({ name }: { name: string }) {
  const app = useApp();
  const api = app.apiClient;
  const parent = useFlowEngine();
  const t = useT();
  const { message } = App.useApp();
  const [config, setConfig] = useState<SharedFormConfig>();
  const [metadata, setMetadata] = useState<FormMetadata>();
  const [model, setModel] = useState<SharedFormModel>();
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const initialized = useRef(false);
  const { data, loading, error, refreshAsync, refresh } = useRequest(
    async () => {
      const [record, roles] = await Promise.all([
        api.resource('sharedForms').get({ filterByTk: name, appends: ['allowedRoles'] }),
        api.resource('roles').list({ paginate: false }),
      ]);
      return { record: record.data.data as FormRecord, roles: roles.data.data as { name: string; title?: string }[] };
    },
    {
      refreshDeps: [api, name],
      onSuccess: (result) => {
        if (initialized.current) return;
        initialized.current = true;
        const current = result.record.v2Config;
        if (current) {
          const parsed = parseConfig(current, result.record.collection);
          setConfig(parsed);
          setSuccessMessage(parsed.successMessage);
        }
      },
    },
  );
  const setCurrentModel = useCallback((value: SharedFormModel | undefined) => setModel(value), []);
  const { data: details, error: metadataError } = useRequest(
    async () => {
      const result = await api.resource('sharedForms').getV2Config({ filterByTk: name });
      setMetadata(result.data.data.dataSource);
      return result.data.data;
    },
    { refreshDeps: [api, name] },
  );
  async function update(values: Record<string, unknown>) {
    setSaving(true);
    try {
      await api.resource('sharedForms').update({ filterByTk: name, values });
      await refreshAsync();
      message.success(t('Saved successfully'));
    } catch {
      message.error(t('Save failed'));
    } finally {
      setSaving(false);
    }
  }
  async function prepareCopy() {
    if (!data?.record || !metadata) return;
    const binding = collectionBinding(data.record.collection);
    const base = formModelOptions(binding.dataSourceKey, binding.collectionName);
    const collection = parent.context.dataSourceManager
      .getDataSource(binding.dataSourceKey)
      ?.getCollection(binding.collectionName);
    const fields = legacyFields(details?.legacySchema, binding.collectionName);
    const items = fields.flatMap((fieldName) => {
      const field = collection?.getField(fieldName);
      if (!field) return [];
      const bindingInfo = FormItemModel.getDefaultBindingByField(parent.context, field);
      if (!bindingInfo) return [];
      return [
        {
          use: 'FormItemModel',
          stepParams: { fieldSettings: { init: { ...binding, fieldPath: fieldName } } },
          subModels: { field: { use: bindingInfo.modelName } },
        },
      ];
    });
    const options = {
      ...base,
      subModels: { ...base.subModels, grid: { ...base.subModels.grid, subModels: { items } } },
    };
    setConfig({
      version: 2,
      model: options as SharedFormConfig['model'],
      successMessage: t('Submitted successfully!'),
    });
    setSuccessMessage(t('Submitted successfully!'));
  }
  const link = new URL(app.getRouteUrl(`/shared-forms/${encodeURIComponent(name)}`), window.location.origin).href;
  if (loading) return <Spin />;
  if (error || !data || metadataError)
    return (
      <Alert
        type="error"
        message={t('Unable to load shared forms')}
        action={<Button onClick={refresh}>{t('Retry')}</Button>}
      />
    );
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space>
        <Link to="/admin/settings/shared-forms">{t('Shared forms')}</Link>
        <Typography.Title level={4}>{data.record.title}</Typography.Title>
        <Switch checked={data.record.enabled} loading={saving} onChange={(enabled) => update({ enabled })} />
        <Button href={link} target="_blank" rel="noopener noreferrer">
          {t('Open form')}
        </Button>
        <Button
          onClick={() =>
            navigator.clipboard
              .writeText(link)
              .then(() => message.success(t('Link copied successfully')))
              .catch(() => message.error(t('Copy failed')))
          }
        >
          {t('Copy link')}
        </Button>
      </Space>
      <Select
        aria-label={t('Allowed roles')}
        mode="multiple"
        style={{ minWidth: 300 }}
        disabled={saving}
        value={(data.record.allowedRoles || []).map((role) => role.name)}
        options={data.roles
          .filter((role) => role.name !== 'root')
          .map((role) => ({ value: role.name, label: role.title || role.name }))}
        onChange={(roles) => update({ allowedRoles: roles.map((role) => ({ name: role })) })}
      />
      <Typography.Text>{t('If empty, all logged in users and root can access')}</Typography.Text>
      <QRCode value={link} size={112} />
      {!data.record.v2Config && (
        <Alert
          type="info"
          message={t(
            'V1 is preserved. Copy field choices, then review validation, linkage rules, actions and layout in the V2 designer before publishing.',
          )}
        />
      )}
      {!config ? (
        <Button onClick={prepareCopy}>{t('Prepare V2 copy')}</Button>
      ) : (
        <>
          <Button
            type="primary"
            loading={saving}
            disabled={!model}
            onClick={() => model && update({ v2Config: { version: 2, model: model.serialize(), successMessage } })}
          >
            {t('Save V2 configuration')}
          </Button>
          <Typography.Text>{t('Prompt after successful submission')}</Typography.Text>
          <Input.TextArea value={successMessage} onChange={(event) => setSuccessMessage(event.target.value)} />
          {metadata && (
            <NativeForm formKey={name} config={config} metadata={metadata} editable onModel={setCurrentModel} />
          )}
        </>
      )}
    </Space>
  );
}

export default function FormDesigner() {
  const { name = '' } = useParams();
  return <DesignerForKey key={name} name={name} />;
}

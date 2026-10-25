/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { PoweredBy, stripModernClientPrefix, useApp } from '@nocobase/client-v2';
import { useFlowEngine } from '@nocobase/flow-engine';
import { useRequest } from 'ahooks';
import { Alert, Button, Card, Result, Spin, Typography } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { SharedFormConfig } from '../shared/v2Config';
import { NativeForm, type FormMetadata } from './NativeForm';
import { useT } from './locale';

interface MetadataResponse {
  title: string;
  collection: string;
  config: SharedFormConfig | null;
  dataSource: FormMetadata;
}
function FormForKey({ name }: { name: string }) {
  const app = useApp();
  const parent = useFlowEngine();
  const t = useT();
  const [success, setSuccess] = useState(false);
  const onSubmitted = useCallback(() => setSuccess(true), []);
  const { data, loading, error, refresh } = useRequest(
    async () =>
      (
        await app.apiClient.request<{ data: MetadataResponse | null }>({
          url: 'sharedForms:getMetaV2',
          params: { filterByTk: name },
        })
      ).data.data,
    { refreshDeps: [app, name] },
  );
  const message = useRequest(
    async () =>
      parent.context.markdown.render(data?.config?.successMessage || t('Submitted successfully!'), { textOnly: false }),
    { refreshDeps: [data?.config?.successMessage, parent] },
  );
  useEffect(() => {
    const previous = document.title;
    if (data?.title) document.title = data.title;
    return () => {
      document.title = previous;
    };
  }, [data?.title]);
  const status = error && 'response' in error ? (error.response as { status?: number })?.status : undefined;
  if (loading) return <Spin />;
  if (error)
    return (
      <Result
        status={status === 401 ? 'warning' : status === 403 ? '403' : 'error'}
        title={t(status === 401 ? 'Login required' : status === 403 ? 'Access denied' : 'Unable to load shared forms')}
        extra={<Button onClick={refresh}>{t('Retry')}</Button>}
      />
    );
  if (!data) return <Result title={t('The form is not enabled')} />;
  if (!data.config)
    return (
      <Result
        title={t('This form has not been ported to V2')}
        extra={
          <Button href={`${stripModernClientPrefix(app.getPublicPath())}shared-forms/${encodeURIComponent(name)}`}>
            {t('Open in legacy client')}
          </Button>
        }
      />
    );
  return (
    <main style={{ maxWidth: 800, margin: '48px auto', padding: 16 }}>
      <Typography.Title level={2}>{data.title}</Typography.Title>
      {success ? (
        <Card>
          {message.error ? <Typography.Paragraph>{data.config.successMessage}</Typography.Paragraph> : message.data}
          <Button onClick={() => setSuccess(false)}>{t('Submit another response')}</Button>
        </Card>
      ) : (
        <NativeForm formKey={name} config={data.config} metadata={data.dataSource} onSubmitted={onSubmitted} />
      )}
      <PoweredBy />
    </main>
  );
}
export default function SharedFormPage() {
  const { name = '' } = useParams();
  const app = useApp();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const changed = () => setVersion((value) => value + 1);
    app.eventBus.addEventListener('auth:tokenChanged', changed);
    app.eventBus.addEventListener('auth:roleChanged', changed);
    return () => {
      app.eventBus.removeEventListener('auth:tokenChanged', changed);
      app.eventBus.removeEventListener('auth:roleChanged', changed);
    };
  }, [app]);
  return <FormForKey key={`${name}:${version}`} name={name} />;
}

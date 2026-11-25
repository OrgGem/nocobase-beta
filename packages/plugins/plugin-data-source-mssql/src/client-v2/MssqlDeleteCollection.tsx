// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { App, Button, Checkbox, Modal } from 'antd';
import { useFlowContext } from '@nocobase/flow-engine';
import type { DataSourceCollectionActionProps } from '@nocobase/plugin-data-source-manager/client-v2';
import { useTranslation } from 'react-i18next';

export function MssqlDeleteCollection({
  dataSourceKey,
  record,
  selectedRowKeys,
  onSubmitted,
  children,
  isBulk,
}: DataSourceCollectionActionProps) {
  const ctx = useFlowContext();
  const { message: appMessage } = App.useApp();
  const notify = ctx?.message ?? appMessage;
  const { t } = useTranslation('plugin-data-source-mssql');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [cascade, setCascade] = useState(false);
  const keys = isBulk ? selectedRowKeys || [] : record?.name ? [record.name] : [];
  async function submit() {
    if (!keys.length) return;
    setPending(true);
    try {
      await ctx.api.request({
        url: `dataSources/${encodeURIComponent(dataSourceKey)}/collections:destroy`,
        method: 'post',
        params: { filterByTk: keys, cascade: cascade },
      });
      setOpen(false);
      ctx.dataSourceManager.getDataSource(dataSourceKey)?.reload();
      onSubmitted?.();
    } catch {
      notify?.error?.(t('Failed to delete collection'));
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <Button
        type={isBulk ? 'default' : 'link'}
        danger
        disabled={!keys.length}
        onClick={() => {
          setCascade(false);
          setOpen(true);
        }}
      >
        {children || t('Delete')}
      </Button>
      <Modal
        open={open}
        title={t('Delete collection')}
        confirmLoading={pending}
        okButtonProps={{ danger: true }}
        onOk={submit}
        onCancel={() => setOpen(false)}
      >
        <p>{t('Are you sure you want to delete it?')}</p>
        <Checkbox checked={cascade} onChange={(event) => setCascade(event.target.checked)}>
          {t(
            'Automatically drop objects that depend on the collection (such as views), and in turn all objects that depend on those objects',
          )}
        </Checkbox>
      </Modal>
    </>
  );
}

/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState } from 'react';
import { App, Button, Checkbox, Modal } from 'antd';
import { useFlowContext } from '@nocobase/flow-engine';
import type { DataSourceCollectionActionProps } from '@nocobase/plugin-data-source-manager/client-v2';
import { useTranslation } from 'react-i18next';
import { NAMESPACE } from '../constants';

export function PostgresDeleteCollection({
  dataSourceKey,
  record,
  selectedRowKeys,
  onSubmitted,
  children,
  isBulk,
}: DataSourceCollectionActionProps) {
  const { t } = useTranslation(NAMESPACE);
  const ctx = useFlowContext();
  const { notification } = App.useApp();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [cascade, setCascade] = useState(false);
  const keys = isBulk ? selectedRowKeys || [] : record?.name ? [record.name] : [];

  const submit = async () => {
    if (!keys.length) return;
    setPending(true);
    try {
      await ctx.api.request({
        url: `dataSources/${encodeURIComponent(dataSourceKey)}/collections:destroy`,
        method: 'post',
        params: { filterByTk: keys, cascade },
      });
      setOpen(false);
      await ctx.dataSourceManager.getDataSource(dataSourceKey)?.reload();
      onSubmitted?.();
    } catch (error) {
      notification.error({
        message: String(t('Failed to delete collection')),
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setPending(false);
    }
  };

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
        <p>{t('Delete the selected collection and its PostgreSQL table or view?')}</p>
        <Checkbox checked={cascade} onChange={(event) => setCascade(event.target.checked)}>
          {t('Also drop dependent PostgreSQL objects')}
        </Checkbox>
      </Modal>
    </>
  );
}

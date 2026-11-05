/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useState } from 'react';
import { Button, Modal } from 'antd';
import { useFlowContext } from '@nocobase/flow-engine';
import type { DataSourceCollectionActionProps } from '@nocobase/plugin-data-source-manager/client-v2';
import { useTranslation } from 'react-i18next';

export function ElasticsearchDeleteCollection({
  dataSourceKey,
  record,
  selectedRowKeys,
  onSubmitted,
  children,
  isBulk,
}: DataSourceCollectionActionProps) {
  const ctx = useFlowContext();
  const { t } = useTranslation('plugin-data-source-elasticsearch');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const keys = isBulk ? selectedRowKeys || [] : record?.name ? [record.name] : [];
  async function submit() {
    if (!keys.length) return;
    setPending(true);
    try {
      await ctx.api.request({
        url: `dataSources/${encodeURIComponent(dataSourceKey)}/collections:destroy`,
        method: 'post',
        params: { filterByTk: keys, cascade: false },
      });
      setOpen(false);
      ctx.dataSourceManager.getDataSource(dataSourceKey)?.reload();
      onSubmitted?.();
    } catch {
      ctx.message.error(t('Failed to delete collection'));
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
      </Modal>
    </>
  );
}

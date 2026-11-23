// SPDX-License-Identifier: Apache-2.0

import { Checkbox, Collapse, Form, Input, Select, Space, Tooltip } from 'antd';
import React from 'react';
import { useRcloneSession } from '../hooks/useRcloneSession';
import { useT } from '../locale';

export interface RcloneTransferFieldsetBaseProps {
  VariableInput?: React.ComponentType<Record<string, unknown>>;
}

export const RcloneTransferFieldsetBase: React.FC<RcloneTransferFieldsetBaseProps> = ({ VariableInput }) => {
  const t = useT();
  const { enabledConnections, permissions } = useRcloneSession();
  const VarInput = VariableInput ?? (Input as unknown as React.ComponentType<Record<string, unknown>>);

  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Form.Item
        name={['config', 'connectionId']}
        label={t('Rclone RCD Connection')}
        extra={t('Leave empty only when binding an existing Explorer Task ID below.')}
      >
        <Select
          allowClear
          popupMatchSelectWidth
          placeholder={t('Select Rclone Connection')}
          options={enabledConnections.map((c) => ({
            value: c.id,
            label: c.title ? `${c.title} (${c.name})` : c.name,
          }))}
        />
      </Form.Item>

      <Form.Item name={['config', 'operation']} label={t('Transfer Operation')} initialValue="sync/copy">
        <Select
          popupMatchSelectWidth
          options={[
            { value: 'sync/copy', label: t('sync/copy — Copy directory / files') },
            { value: 'sync/move', label: t('sync/move — Move directory / files') },
            { value: 'sync/sync', label: t('sync/sync — Mirror destination to source') },
            { value: 'sync/bisync', label: t('sync/bisync — Bidirectional sync') },
            { value: 'operations/copyfile', label: t('operations/copyfile — Copy single file') },
            { value: 'operations/movefile', label: t('operations/movefile — Move single file') },
          ]}
        />
      </Form.Item>

      <Form.Item name={['config', 'srcFs']} label={t('Source Fs (e.g. s3-prod:bucket)')}>
        <VarInput />
      </Form.Item>

      <Form.Item name={['config', 'srcRemote']} label={t('Source Sub-path / File')}>
        <VarInput />
      </Form.Item>

      <Form.Item name={['config', 'dstFs']} label={t('Destination Fs (e.g. gdrive-backup:archive)')}>
        <VarInput />
      </Form.Item>

      <Form.Item name={['config', 'dstRemote']} label={t('Destination Sub-path / File')}>
        <VarInput />
      </Form.Item>

      <Form.Item name={['config', 'failOnError']} valuePropName="checked" initialValue={true}>
        <Checkbox>
          {t('Fail workflow execution when Rclone job fails (uncheck to handle errors via Condition node)')}
        </Checkbox>
      </Form.Item>

      <Form.Item name={['config', 'dryRun']} valuePropName="checked">
        <Checkbox>{t('Dry Run (simulate without writing)')}</Checkbox>
      </Form.Item>

      <Form.Item name={['config', 'allowLocalPaths']} valuePropName="checked">
        <Tooltip title={!permissions.canLocalFs ? t('Requires High privilege: local-fs permission') : undefined}>
          <Checkbox disabled={!permissions.canLocalFs}>
            {t('Allow host local filesystem paths in srcFs / dstFs')}
          </Checkbox>
        </Tooltip>
      </Form.Item>

      <Collapse
        size="small"
        items={[
          {
            key: 'advanced',
            label: t('Filter Rules & Explorer Task Binding'),
            children: (
              <>
                <Form.Item
                  name={['config', 'filterInclude']}
                  label={t('Include Patterns (comma or newline separated)')}
                >
                  <Input.TextArea rows={2} placeholder="*.pdf, *.parquet" />
                </Form.Item>
                <Form.Item
                  name={['config', 'filterExclude']}
                  label={t('Exclude Patterns (comma or newline separated)')}
                >
                  <Input.TextArea rows={2} placeholder="*.tmp, .DS_Store" />
                </Form.Item>
                <Form.Item name={['config', 'createEmptySrcDirs']} valuePropName="checked">
                  <Checkbox>{t('Create empty source directories')}</Checkbox>
                </Form.Item>
                <Form.Item name={['config', 'deleteEmptySrcDirs']} valuePropName="checked">
                  <Checkbox>{t('Delete empty source directories after move')}</Checkbox>
                </Form.Item>
                <Form.Item
                  name={['config', 'taskId']}
                  label={t('Bound Explorer Task ID (Managed Workflow)')}
                  extra={t('Used by the built-in Explorer Transfer Workflow (e.g. {{$context.data.id}}).')}
                >
                  <VarInput />
                </Form.Item>
              </>
            ),
          },
        ]}
      />
    </Space>
  );
};

export default RcloneTransferFieldsetBase;

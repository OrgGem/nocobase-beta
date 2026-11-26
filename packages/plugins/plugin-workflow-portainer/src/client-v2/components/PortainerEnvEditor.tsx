/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { CloudDownloadOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import {
  WorkflowVariableInput,
  WorkflowVariableJsonTextArea,
  WorkflowVariableTextArea,
} from '@nocobase/plugin-workflow/client-v2';
import { Button, Checkbox, Collapse, Flex, Form, Input, message, Radio, Space } from 'antd';
import React, { useState } from 'react';
import { PORTAINER_RESOURCE } from '../../shared/constants';
import type { ConfigurableEnvItem } from '../../shared/types';
import { useT } from '../locale';
import type { StaticStackContext } from './PortainerTargetFields';

interface StackEnvEntry {
  name: string;
  value: string;
  sensitive?: boolean;
}

export function PortainerEnvEditor({ stackContext }: { stackContext?: StaticStackContext }) {
  const t = useT();
  const api = useApp().apiClient;
  const form = Form.useFormInstance();
  const [loadingStackEnv, setLoadingStackEnv] = useState(false);

  const canLoadFromStack = Boolean(stackContext?.stack?.id);

  const handleLoadFromStack = async () => {
    const stackId = stackContext?.stack?.id;
    if (!stackId) {
      return;
    }
    setLoadingStackEnv(true);
    try {
      const res = await api.request<{ data?: { env?: StackEnvEntry[] } }>({
        url: `${PORTAINER_RESOURCE}:getStackDetail`,
        method: 'get',
        params: {
          ...(stackContext?.instanceId ? { instanceId: stackContext.instanceId } : {}),
          stackId,
          includeValues: true,
        },
      });
      const remoteEnv = Array.isArray(res?.data?.data?.env) ? res.data.data.env : [];
      const currentPairs = (form.getFieldValue(['config', 'envPairs']) as ConfigurableEnvItem[] | undefined) ?? [];
      const existingNames = new Set(currentPairs.map((item) => String(item?.name ?? '').trim()).filter(Boolean));

      let importedCount = 0;
      let skippedSensitiveCount = 0;
      const nextPairs = [...currentPairs];

      for (const entry of remoteEnv) {
        const keyName = String(entry.name ?? '').trim();
        if (!keyName || existingNames.has(keyName)) {
          continue;
        }
        if (entry.sensitive) {
          skippedSensitiveCount += 1;
          continue;
        }
        nextPairs.push({
          name: keyName,
          value: entry.value,
          secret: false,
        });
        existingNames.add(keyName);
        importedCount += 1;
      }

      form.setFieldValue(['config', 'envPairs'], nextPairs);
      if (skippedSensitiveCount > 0) {
        message.info(
          t('Loaded {{count}} variables ({{sensitive}} sensitive keys stay preserved on Portainer in Merge mode)', {
            count: importedCount,
            sensitive: skippedSensitiveCount,
          }),
        );
      } else {
        message.success(t('Loaded {{count}} variables from Portainer Stack', { count: importedCount }));
      }
    } catch {
      message.error(t('Failed to load environment variables from Portainer Stack'));
    } finally {
      setLoadingStackEnv(false);
    }
  };

  return (
    <>
      <Form.Item
        name={['config', 'envStrategy']}
        label={t('Environment merge strategy')}
        initialValue="merge"
        extra={t(
          'Merge keeps existing Portainer Stack variables intact and overrides matching keys; Replace overwrites the entire Stack Env list.',
        )}
      >
        <Radio.Group
          options={[
            { value: 'merge', label: t('Merge & override existing Stack Env') },
            { value: 'replace', label: t('Replace all Stack Env') },
          ]}
        />
      </Form.Item>

      <Form.Item
        label={
          <Flex align="center" justify="space-between" gap="middle" style={{ width: '100%' }}>
            <span>{t('Environment variables (Key-Value)')}</span>
            {canLoadFromStack ? (
              <Button
                size="small"
                htmlType="button"
                icon={<CloudDownloadOutlined />}
                loading={loadingStackEnv}
                onClick={handleLoadFromStack}
              >
                {t('Load Env from Stack')}
              </Button>
            ) : null}
          </Flex>
        }
        extra={t(
          'Add variables such as IMAGE_TAG or runtime settings. Mark sensitive values as Secret to redact them in workflow execution logs.',
        )}
      >
        <Form.List name={['config', 'envPairs']}>
          {(fields, { add, remove }) => (
            <Space direction="vertical" style={{ display: 'flex' }}>
              {fields.map((field, index) => {
                const currentName = String(form.getFieldValue(['config', 'envPairs', field.name, 'name']) ?? '').trim();
                const deleteLabel = currentName
                  ? `${t('Delete environment variable')} ${currentName}`
                  : `${t('Delete environment variable')} #${index + 1}`;

                return (
                  <Flex key={field.key} align="center" gap="small" wrap="wrap" style={{ width: '100%' }}>
                    <Form.Item name={[field.name, 'name']} style={{ flex: '1 1 160px', marginBottom: 0 }}>
                      <Input placeholder="IMAGE_TAG" autoCorrect="off" autoCapitalize="none" spellCheck={false} />
                    </Form.Item>
                    <Form.Item name={[field.name, 'value']} style={{ flex: '2 1 220px', marginBottom: 0 }}>
                      <WorkflowVariableInput placeholder={t('Value or {{variable}}')} />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'secret']}
                      valuePropName="checked"
                      initialValue={false}
                      style={{ marginBottom: 0 }}
                    >
                      <Checkbox>{t('Secret')}</Checkbox>
                    </Form.Item>
                    <Button
                      htmlType="button"
                      aria-label={deleteLabel}
                      icon={<DeleteOutlined />}
                      onClick={() => remove(field.name)}
                    />
                  </Flex>
                );
              })}
              <Button
                htmlType="button"
                icon={<PlusOutlined />}
                onClick={() => add({ name: '', value: '', secret: false })}
                style={{ width: '100%' }}
              >
                {t('Add environment variable')}
              </Button>
            </Space>
          )}
        </Form.List>
      </Form.Item>

      <Collapse
        size="small"
        style={{ marginBottom: 16 }}
        items={[
          {
            key: 'bulk-env',
            label: t('Bulk .env text & dynamic JSON environment'),
            children: (
              <>
                <Form.Item
                  name={['config', 'envText']}
                  label={t('Bulk .env format')}
                  extra={t('Enter KEY=VALUE lines. Supports upstream workflow variables.')}
                >
                  <WorkflowVariableTextArea
                    autoSize={{ minRows: 3, maxRows: 8 }}
                    placeholder={'IMAGE_TAG=v1.0.0\nNODE_ENV=production'}
                  />
                </Form.Item>
                <Form.Item
                  name={['config', 'dynamicEnv']}
                  label={t('Dynamic environment JSON / variable')}
                  extra={t(
                    'Pass a JSON object {"KEY":"VAL"}, an array [{"name":"KEY","value":"VAL"}], or a workflow variable from a build catalog record.',
                  )}
                  style={{ marginBottom: 0 }}
                >
                  <WorkflowVariableJsonTextArea
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    placeholder={'{"IMAGE_TAG": "{{$context.data.imageTag}}"}'}
                  />
                </Form.Item>
              </>
            ),
          },
        ]}
      />
    </>
  );
}

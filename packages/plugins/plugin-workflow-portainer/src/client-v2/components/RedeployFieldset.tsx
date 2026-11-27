/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { WorkflowVariableInput, WorkflowVariableWrapper } from '@nocobase/plugin-workflow/client-v2';
import { Checkbox, Form, InputNumber, Radio } from 'antd';
import React, { useState } from 'react';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from '../../shared/constants';
import { toFiniteNumber } from '../../shared/env';
import type { RedeployTargetMode } from '../../shared/types';
import { useT } from '../locale';
import { PortainerEnvEditor } from './PortainerEnvEditor';
import { PortainerInstanceField, PortainerTargetFields, type StaticStackContext } from './PortainerTargetFields';

export function RedeployFieldset() {
  const t = useT();
  const form = Form.useFormInstance();
  const watchedMode = (Form.useWatch(['config', 'mode'], form) as RedeployTargetMode | undefined) ?? 'stack';
  const [stackContext, setStackContext] = useState<StaticStackContext>({});

  return (
    <>
      <Form.Item
        name={['config', 'mode']}
        label={t('Execution mode')}
        initialValue="stack"
        extra={t(
          'Use Stack API to control Environment, Stack, Git branch, and full Env variables; use Stack Webhook when triggering an unauthenticated Portainer webhook UUID.',
        )}
      >
        <Radio.Group
          options={[
            { value: 'stack', label: t('Stack API (Git / Compose)') },
            { value: 'webhook', label: t('Stack Webhook') },
          ]}
        />
      </Form.Item>

      {watchedMode === 'webhook' ? (
        <>
          <PortainerInstanceField />
          <Form.Item
            name={['config', 'webhookId']}
            label={t('Stack Webhook token')}
            rules={[{ required: true, message: t('Webhook token is required') }]}
            extra={t('The UUID at the end of /api/stacks/webhooks/<token>.')}
          >
            <WorkflowVariableInput placeholder="638e6967-ef77-4906-8af8-236800621360" />
          </Form.Item>
          <Form.Item
            name={['config', 'webhookTag']}
            label={t('Image tag override (optional)')}
            extra={t('Appends ?tag=<value> when triggering a Portainer Stack webhook.')}
          >
            <WorkflowVariableInput placeholder="latest" />
          </Form.Item>
        </>
      ) : (
        <>
          <PortainerTargetFields onStackContextChange={setStackContext} />

          <Form.Item
            name={['config', 'gitReference']}
            label={t('Git branch / tag override (optional)')}
            extra={t(
              'Leave empty to keep the Git reference already configured on Portainer (e.g. refs/heads/main), or pass a branch/tag such as main or refs/tags/v1.2.0.',
            )}
          >
            <WorkflowVariableInput placeholder={stackContext.stack?.gitReference || 'refs/heads/main'} />
          </Form.Item>

          <Form.Item
            name={['config', 'repullImage']}
            valuePropName="checked"
            initialValue={false}
            extra={t(
              'Enable when deploying a separate Stack so Portainer pulls the newly built image from your registry.',
            )}
          >
            <Checkbox>{t('Force pull / repull latest images')}</Checkbox>
          </Form.Item>

          <Form.Item name={['config', 'prune']} valuePropName="checked" initialValue={false}>
            <Checkbox>{t('Prune orphan services on redeploy')}</Checkbox>
          </Form.Item>

          <PortainerEnvEditor stackContext={stackContext} />
        </>
      )}

      <Form.Item
        name={['config', 'timeoutMs']}
        label={t('Request timeout')}
        initialValue={DEFAULT_TIMEOUT_MS}
        extra={t('Increase timeout for Stacks that run long Dockerfile builds during git/redeploy.')}
      >
        <WorkflowVariableWrapper<number>
          render={({ value, onChange }) => (
            <InputNumber
              min={MIN_TIMEOUT_MS}
              max={MAX_TIMEOUT_MS}
              step={5000}
              addonAfter={t('ms')}
              value={toFiniteNumber(value) ?? DEFAULT_TIMEOUT_MS}
              onChange={(nextVal) => onChange?.(typeof nextVal === 'number' ? nextVal : null)}
              style={{ width: '100%' }}
            />
          )}
        />
      </Form.Item>

      <Form.Item name={['config', 'ignoreFail']} valuePropName="checked" initialValue={false}>
        <Checkbox>{t('Ignore failed execution and continue workflow')}</Checkbox>
      </Form.Item>
    </>
  );
}

export default RedeployFieldset;

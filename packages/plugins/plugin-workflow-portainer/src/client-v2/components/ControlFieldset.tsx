/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Checkbox, Form, Radio } from 'antd';
import React from 'react';
import { useT } from '../locale';
import { PortainerTargetFields } from './PortainerTargetFields';

export function ControlFieldset() {
  const t = useT();

  return (
    <>
      <Form.Item
        name={['config', 'action']}
        label={t('Stack operation')}
        initialValue="inspect"
        extra={t(
          'Inspect retrieves Stack status, current Env keys, and container health without restarting services; Start and Stop control the Stack lifecycle.',
        )}
      >
        <Radio.Group
          options={[
            { value: 'inspect', label: t('Inspect Stack & Health') },
            { value: 'start', label: t('Start Stack') },
            { value: 'stop', label: t('Stop Stack') },
          ]}
        />
      </Form.Item>

      <PortainerTargetFields />

      <Form.Item name={['config', 'ignoreFail']} valuePropName="checked" initialValue={false}>
        <Checkbox>{t('Ignore failed execution and continue workflow')}</Checkbox>
      </Form.Item>
    </>
  );
}

export default ControlFieldset;

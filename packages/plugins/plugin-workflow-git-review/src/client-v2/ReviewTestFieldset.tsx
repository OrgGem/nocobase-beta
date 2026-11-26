// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Form, Input } from 'antd';
import { useCurrentWorkflowContext, type TriggerLoaderOf } from '@nocobase/plugin-workflow/client-v2';
import { useT } from './locale';

const sample = [
  'diff --git a/example.txt b/example.txt',
  '--- a/example.txt',
  '+++ b/example.txt',
  '@@ -1 +1 @@',
  '-before',
  '+after',
].join('\n');

export function installReviewTestFieldset(trigger?: { TriggerFieldsetLoader?: TriggerLoaderOf }) {
  const original = trigger?.TriggerFieldsetLoader;
  if (!trigger || !original) return;
  trigger.TriggerFieldsetLoader = async () => {
    const { default: CollectionFieldset } = await original();
    function ReviewTestFieldset() {
      const workflow = useCurrentWorkflowContext();
      const t = useT();
      if (workflow.config?.collection !== 'gitReviewRequests') return <CollectionFieldset />;
      return (
        <Form.Item
          name="reviewTestDiff"
          label={t('Test diff')}
          extra={t('Review test description')}
          initialValue={sample}
          rules={[{ required: true, whitespace: true, max: 100000, message: t('Invalid review test diff') }]}
        >
          <Input.TextArea rows={7} maxLength={100000} />
        </Form.Item>
      );
    }
    return { default: ReviewTestFieldset };
  };
}

// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useState } from 'react';
import { Checkbox, Form, Select } from 'antd';
import { useFlowContext } from '@nocobase/flow-engine';
import { WorkflowVariableInput, WorkflowVariableJsonTextArea } from '@nocobase/plugin-workflow/client-v2';
import { DU_BUSINESS_CATALOG } from '../../server/contracts/du-contracts';
import { PipelineDef, unwrapData } from '../types';
import { useT } from '../locale';

const BUSINESS_OPTIONS = [
  { value: 'document-core', label: 'document-core (v2.0.0)' },
  { value: 'lc-checker', label: 'lc-checker (v1.2.0 - UCP 600 / ISBP 821)' },
  { value: 'example-review', label: 'example-review (v1.0.0)' },
];

export const DocumentUnderstandingFieldset: React.FC = () => {
  const t = useT();
  const ctx = useFlowContext();
  const form = Form.useFormInstance();
  const mode = Form.useWatch(['config', 'mode'], form) || 'business_action';
  const businessId = Form.useWatch(['config', 'businessId'], form) || 'document-core';
  const action = Form.useWatch(['config', 'action'], form) || 'extract';
  const [pipelines, setPipelines] = useState<PipelineDef[]>([]);

  useEffect(() => {
    if (mode !== 'pipeline' || !ctx?.api) return;
    let cancelled = false;
    ctx.api
      .request({ url: 'docUnderstanding:listPipelines' })
      .then((res: unknown) => {
        if (!cancelled) {
          setPipelines(unwrapData<PipelineDef[]>(res, []));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ctx?.api, mode]);

  const actionsForBusiness = Array.from(
    new Set(DU_BUSINESS_CATALOG.filter((item) => item.businessId === businessId).map((item) => item.action)),
  );
  const variantsForAction = DU_BUSINESS_CATALOG.filter(
    (item) => item.businessId === businessId && item.action === action && item.discriminatorValue,
  );

  return (
    <div>
      <Form.Item name={['config', 'mode']} label={t('Execution Mode')} initialValue="business_action">
        <Select
          options={[
            { value: 'business_action', label: t('Canonical Business Action (du-rework)') },
            { value: 'pipeline', label: t('Configured Pipeline') },
          ]}
        />
      </Form.Item>

      {mode === 'pipeline' ? (
        <Form.Item
          name={['config', 'pipelineId']}
          label={t('Pipeline')}
          rules={[{ required: true, message: t('Select a pipeline') }]}
        >
          <Select placeholder={t('Select pipeline')} options={pipelines.map((p) => ({ value: p.id, label: p.name }))} />
        </Form.Item>
      ) : (
        <>
          <Form.Item name={['config', 'businessId']} label={t('Business')} initialValue="document-core">
            <Select options={BUSINESS_OPTIONS} />
          </Form.Item>
          <Form.Item name={['config', 'action']} label={t('Action')} initialValue="extract">
            <Select options={actionsForBusiness.map((act) => ({ value: act, label: act }))} />
          </Form.Item>
          {variantsForAction.length > 0 && (
            <Form.Item name={['config', 'variant']} label={t('Variant / Mode')}>
              <Select
                allowClear
                placeholder={t('Select variant')}
                options={variantsForAction.map((v) => ({
                  value: v.discriminatorValue as string,
                  label: `${v.discriminatorValue} — ${v.description}`,
                }))}
              />
            </Form.Item>
          )}
        </>
      )}

      <Form.Item
        name={['config', 'files']}
        label={t('Document Files / Attachment Variable')}
        extra={t('Bind an attachment field, file URL, or comma-separated upload paths from upstream nodes')}
      >
        <WorkflowVariableInput placeholder="uploads/invoice.pdf" />
      </Form.Item>

      <Form.Item
        name={['config', 'pages']}
        label={t('Page Selection (DI-06)')}
        extra={t('Optional page ranges, e.g. "1-3, 5" (leave empty for all pages)')}
      >
        <WorkflowVariableInput placeholder="1-3" />
      </Form.Item>

      <Form.Item
        name={['config', 'inputJson']}
        label={t('Input Parameters (JSON)')}
        extra={t('Additional action parameters (e.g. referenceData, questions, targetLanguage, ruleSetVersion)')}
      >
        <WorkflowVariableJsonTextArea rows={4} placeholder='{ "outputFormat": "json" }' />
      </Form.Item>

      <Form.Item name={['config', 'ignoreFail']} valuePropName="checked" initialValue={false}>
        <Checkbox>{t('Continue workflow even if document processing fails')}</Checkbox>
      </Form.Item>
    </div>
  );
};

export default DocumentUnderstandingFieldset;

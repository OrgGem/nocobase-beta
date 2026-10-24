import { WorkflowTypedVariableInput, WorkflowVariableTextArea } from '@nocobase/plugin-workflow/client-v2';
import { Checkbox, Form, Select } from 'antd';
import React from 'react';
import { SUPPORTED_OUTPUT_FORMATS } from '../../shared/constants';
import { useCarboneTranslation } from '../locale';
import TemplateSelect from './TemplateSelect';

export default function CarboneRenderFieldset() {
  const { t } = useCarboneTranslation();
  return (
    <>
      <Form.Item name={['config', 'templateId']} label={t('Template')} rules={[{ required: true }]}>
        <TemplateSelect />
      </Form.Item>
      <Form.Item
        name={['config', 'data']}
        label={t('Render input data (JSON)')}
        extra={t('Bind to an object variable, or compose JSON inline. Carbone expects { d: ..., c: ... }.')}
      >
        <WorkflowTypedVariableInput types={['object']} nullable={false} />
      </Form.Item>
      <Form.Item name={['config', 'format']} label={t('Output format')}>
        <Select
          allowClear
          placeholder={t('Use template default')}
          options={SUPPORTED_OUTPUT_FORMATS.map((value) => ({ value, label: value.toUpperCase() }))}
        />
      </Form.Item>
      <Form.Item name={['config', 'filename']} label={t('Filename')}>
        <WorkflowVariableTextArea autoSize={{ minRows: 1, maxRows: 3 }} />
      </Form.Item>
      <Form.Item name={['config', 'persistOutput']} valuePropName="checked" initialValue={true}>
        <Checkbox>{t('Save output as attachment')}</Checkbox>
      </Form.Item>
      <Form.Item name={['config', 'bypassCache']} valuePropName="checked">
        <Checkbox>{t('Bypass cache (always re-render)')}</Checkbox>
      </Form.Item>
      <Form.Item name={['config', 'ignoreFail']} valuePropName="checked">
        <Checkbox>{t('Ignore failed render and continue workflow')}</Checkbox>
      </Form.Item>
    </>
  );
}

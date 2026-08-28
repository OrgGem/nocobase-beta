import React from 'react';
import { FilePdfOutlined } from '@ant-design/icons';
import Instruction from "@nocobase/plugin-workflow";
import { Variable } from '@nocobase/client';
import { NAMESPACE } from '../locale';
import { SUPPORTED_OUTPUT_FORMATS } from '../../shared/constants';
import { TemplateSelect } from './TemplateSelect';

/**
 * Workflow `carbone-render` node config UI.
 *
 * Inputs map 1:1 to the server-side instruction config:
 *   - templateId: selected from the live template list.
 *   - data: any upstream variable (object) — passed straight to Carbone.
 *   - format: dropdown of all supported output formats (no template default
 *             at runtime; server falls back when this is empty).
 *   - filename: optional, supports inline workflow variables.
 *   - bypassCache / persistOutput / ignoreFail: behavior toggles.
 *
 * The job result fields (attachmentId, url, format, size, cacheHit, durationMs,
 * carboneTemplateId) are exposed via `useVariables()` so downstream nodes can
 * reference them — e.g. the mailer attaches `{{$jobsMapByNodeKey.<key>.url}}`.
 */
export default class CarboneRenderInstruction extends Instruction {
  title = `{{t("Render Carbone document", { ns: "${NAMESPACE}" })}}`;
  type = 'carbone-render';
  group = 'extended';
  description = `{{t("Render a managed Carbone template with data from upstream nodes. Returns the attachment id and URL.", { ns: "${NAMESPACE}" })}}`;
  icon = (<FilePdfOutlined />);

  fieldset = {
    templateId: {
      type: 'number',
      required: true,
      title: `{{t("Template", { ns: "${NAMESPACE}" })}}`,
      'x-decorator': 'FormItem',
      'x-component': 'TemplateSelect',
    },
    data: {
      type: 'object',
      title: `{{t("Render input data (JSON)", { ns: "${NAMESPACE}" })}}`,
      description: `{{t("Bind to an object variable, or compose JSON inline. Carbone expects { d: ..., c: ... }.", { ns: "${NAMESPACE}" })}}`,
      'x-decorator': 'FormItem',
      'x-component': 'Variable.Input',
      'x-component-props': {
        nullable: false,
        useTypedConstant: ['object'],
      },
    },
    format: {
      type: 'string',
      title: `{{t("Output format", { ns: "${NAMESPACE}" })}}`,
      'x-decorator': 'FormItem',
      'x-component': 'Select',
      'x-component-props': {
        allowClear: true,
        placeholder: `{{t("Use template default", { ns: "${NAMESPACE}" })}}`,
        style: { width: 200 },
      },
      enum: SUPPORTED_OUTPUT_FORMATS.map((f) => ({ label: f.toUpperCase(), value: f })),
    },
    filename: {
      type: 'string',
      title: `{{t("Filename", { ns: "${NAMESPACE}" })}}`,
      'x-decorator': 'FormItem',
      'x-component': 'Variable.TextArea',
      'x-component-props': {
        autoSize: { minRows: 1, maxRows: 3 },
      },
    },
    persistOutput: {
      type: 'boolean',
      'x-content': `{{t("Save output as attachment", { ns: "${NAMESPACE}" })}}`,
      'x-decorator': 'FormItem',
      'x-component': 'Checkbox',
      default: true,
    },
    bypassCache: {
      type: 'boolean',
      'x-content': `{{t("Bypass cache (always re-render)", { ns: "${NAMESPACE}" })}}`,
      'x-decorator': 'FormItem',
      'x-component': 'Checkbox',
    },
    ignoreFail: {
      type: 'boolean',
      'x-content': `{{t("Ignore failed render and continue workflow", { ns: "${NAMESPACE}" })}}`,
      'x-decorator': 'FormItem',
      'x-component': 'Checkbox',
    },
  };

  components = {
    TemplateSelect,
    Variable,
  };

  /**
   * Expose the job result keys as downstream variables. Each entry shows up in
   * the variable picker as `<NodeTitle> > <Field>`.
   */
  useVariables({ key, title }: any) {
    const fields = [
      { key: 'attachmentId', label: `{{t("Attachment id", { ns: "${NAMESPACE}" })}}` },
      { key: 'url', label: `{{t("Attachment URL", { ns: "${NAMESPACE}" })}}` },
      { key: 'format', label: `{{t("Output format", { ns: "${NAMESPACE}" })}}` },
      { key: 'size', label: `{{t("Size", { ns: "${NAMESPACE}" })}}` },
      { key: 'cacheHit', label: `{{t("Cache hit", { ns: "${NAMESPACE}" })}}` },
      { key: 'durationMs', label: `{{t("Render duration (ms)", { ns: "${NAMESPACE}" })}}` },
      { key: 'carboneTemplateId', label: `{{t("Carbone ID", { ns: "${NAMESPACE}" })}}` },
    ];
    return {
      value: key,
      label: title,
      children: fields.map((f) => ({ isLeaf: true, value: f.key, key: f.key, label: f.label })),
    };
  }
}


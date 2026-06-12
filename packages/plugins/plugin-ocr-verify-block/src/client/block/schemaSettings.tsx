import { ISchema, useField, useFieldSchema } from '@formily/react';
import { SchemaSettings, useDesignable } from '@nocobase/client';
import React from 'react';
import { CategorySelect } from '../components/CategorySelect';
import { tStr } from '../locale';

const editSchema: ISchema = {
  type: 'object',
  properties: {
    sourceMode: {
      title: tStr('Source mode'),
      type: 'string',
      'x-decorator': 'FormItem',
      'x-component': 'Select',
      default: 'currentRecord',
      enum: [
        { label: tStr('Current record'), value: 'currentRecord' },
        { label: tStr('Manual record'), value: 'manualRecord' },
      ],
      required: true,
    },
    collection: {
      title: tStr('Collection'),
      type: 'string',
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      description: tStr('Optional for current-record blocks.'),
    },
    recordId: {
      title: tStr('Record ID'),
      type: 'string',
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      description: tStr('Only used in manual-record mode.'),
    },
    pdfField: {
      title: tStr('PDF attachment field'),
      type: 'string',
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      required: true,
    },
    jsonField: {
      title: tStr('OCR JSON field'),
      type: 'string',
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      required: true,
    },
    statusField: {
      title: tStr('Status field'),
      type: 'string',
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      description: tStr('String field updated to accepted/rejected.'),
    },
    categoryId: {
      title: tStr('Verify category / profile'),
      type: 'string',
      'x-decorator': 'FormItem',
      'x-component': CategorySelect,
      required: true,
    },
  },
};

export const ocrVerifyBlockSettings = new SchemaSettings({
  name: 'blockSettings:ocrVerify',
  items: [
    {
      name: 'editOcrVerifyBlock',
      type: 'modal',
      useComponentProps() {
        const field = useField();
        const fieldSchema = useFieldSchema();
        const { dn } = useDesignable();
        return {
          title: tStr('Edit OCR Verify block'),
          initialValues: fieldSchema['x-component-props'] || {},
          schema: editSchema,
          onSubmit(values) {
            fieldSchema['x-component-props'] = values;
            field.componentProps = values;
            dn.emit('patch', {
              schema: {
                'x-uid': fieldSchema['x-uid'],
                'x-component-props': values,
              },
            });
          },
        };
      },
    },
    {
      name: 'height',
      Component: 'SchemaSettingsBlockHeightItem',
    },
    {
      name: 'remove',
      type: 'remove',
    },
  ],
});

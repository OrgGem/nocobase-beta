import { ISchema, useField, useFieldSchema } from '@formily/react';
import { SchemaSettings, useDesignable } from '@nocobase/client';
import React from 'react';
import { CategorySelect } from '../components/CategorySelect';

const editSchema: ISchema = {
  type: 'object',
  properties: {
    sourceMode: {
      title: 'Source mode',
      type: 'string',
      'x-decorator': 'FormItem',
      'x-component': 'Select',
      default: 'currentRecord',
      enum: [
        { label: 'Current record', value: 'currentRecord' },
        { label: 'Manual record', value: 'manualRecord' },
      ],
      required: true,
    },
    collection: {
      title: 'Collection',
      type: 'string',
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      description: 'Optional for current-record blocks.',
    },
    recordId: {
      title: 'Record ID',
      type: 'string',
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      description: 'Only used in manual-record mode.',
    },
    pdfField: {
      title: 'PDF attachment field',
      type: 'string',
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      required: true,
    },
    jsonField: {
      title: 'OCR JSON field',
      type: 'string',
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      required: true,
    },
    statusField: {
      title: 'Status field',
      type: 'string',
      'x-decorator': 'FormItem',
      'x-component': 'Input',
      description: 'String field updated to accepted/rejected.',
    },
    categoryId: {
      title: 'Verify Category / Profile',
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
          title: 'Edit OCR Verify block',
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

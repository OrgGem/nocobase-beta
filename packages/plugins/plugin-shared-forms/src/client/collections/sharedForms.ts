// SPDX-License-Identifier: Apache-2.0

import { NAMESPACE } from '../locale';

export const sharedFormsCollection = {
  name: 'sharedForms',
  filterTargetKey: 'key',
  fields: [
    {
      type: 'string',
      name: 'title',
      interface: 'input',
      uiSchema: {
        type: 'string',
        title: "{{t('Title')}}",
        required: true,
        'x-component': 'Input',
      },
    },
    {
      type: 'text',
      name: 'description',
      interface: 'textarea',
      uiSchema: {
        type: 'string',
        title: "{{t('Description')}}",
        'x-component': 'Input.TextArea',
      },
    },
    {
      type: 'string',
      name: 'type',
      interface: 'radioGroup',
      uiSchema: {
        type: 'string',
        title: `{{t("Type",{ns:"shared-forms"})}}`,
        'x-component': 'Radio.Group',
        enum: '{{ formTypes }}',
      },
    },
    {
      type: 'string',
      name: 'collection',
      interface: 'collection',
      uiSchema: {
        type: 'string',
        title: "{{t('Collection')}}",
        required: true,
        'x-component': 'DataSourceCollectionCascader',
      },
    },
    {
      type: 'boolean',
      name: 'enabled',
      interface: 'checkbox',
      uiSchema: {
        type: 'string',
        title: `{{t("Enable form",{ns:"${NAMESPACE}"})}}`,
        'x-component': 'Checkbox',
        default: true,
      },
    },
  ],
};

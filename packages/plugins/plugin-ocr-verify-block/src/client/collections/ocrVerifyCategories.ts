import type { CollectionOptions } from '@nocobase/client';
import { COLLECTION, DEFAULT_SETTINGS } from '../../shared/constants';

export const ocrVerifyCategoriesCollection: CollectionOptions = {
  name: COLLECTION.categories,
  title: 'OCR Verify Categories',
  filterTargetKey: 'id',
  titleField: 'title',
  fields: [
    {
      name: 'name',
      type: 'string',
      interface: 'input',
      uiSchema: {
        type: 'string',
        title: 'Name',
        'x-component': 'Input',
      },
    },
    {
      name: 'title',
      type: 'string',
      interface: 'input',
      uiSchema: {
        type: 'string',
        title: 'Title',
        'x-component': 'Input',
      },
    },
    {
      name: 'description',
      type: 'text',
      interface: 'textarea',
      uiSchema: {
        type: 'string',
        title: 'Description',
        'x-component': 'Input.TextArea',
      },
    },
    {
      name: 'callbackUrl',
      type: 'text',
      interface: 'url',
      uiSchema: {
        type: 'string',
        title: 'Callback URL',
        'x-component': 'Input.URL',
      },
    },
    {
      name: 'callbackApiKey',
      type: 'text',
      interface: 'password',
      uiSchema: {
        type: 'string',
        title: 'Callback API Key',
        'x-component': 'Password',
      },
    },
    {
      name: 'acceptStatus',
      type: 'string',
      interface: 'input',
      defaultValue: DEFAULT_SETTINGS.acceptStatus,
      uiSchema: {
        type: 'string',
        title: 'Accept Status',
        'x-component': 'Input',
      },
    },
    {
      name: 'rejectStatus',
      type: 'string',
      interface: 'input',
      defaultValue: DEFAULT_SETTINGS.rejectStatus,
      uiSchema: {
        type: 'string',
        title: 'Reject Status',
        'x-component': 'Input',
      },
    },
    {
      name: 'enabled',
      type: 'boolean',
      interface: 'checkbox',
      defaultValue: true,
      uiSchema: {
        type: 'boolean',
        title: 'Enabled',
        'x-component': 'Checkbox',
      },
    },
  ],
};

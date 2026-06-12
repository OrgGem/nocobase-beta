import type { CollectionOptions } from '@nocobase/client';
import { COLLECTION, DEFAULT_MAPPING, DEFAULT_SETTINGS } from '../../shared/constants';
import { tStr } from '../locale';

export const ocrVerifyCategoriesCollection: CollectionOptions = {
  name: COLLECTION.categories,
  title: tStr('OCR Verify categories'),
  filterTargetKey: 'id',
  titleField: 'title',
  fields: [
    {
      name: 'name',
      type: 'string',
      interface: 'input',
      uiSchema: {
        type: 'string',
        title: tStr('Name'),
        'x-component': 'Input',
      },
    },
    {
      name: 'title',
      type: 'string',
      interface: 'input',
      uiSchema: {
        type: 'string',
        title: tStr('Title'),
        'x-component': 'Input',
      },
    },
    {
      name: 'description',
      type: 'text',
      interface: 'textarea',
      uiSchema: {
        type: 'string',
        title: tStr('Description'),
        'x-component': 'Input.TextArea',
      },
    },
    {
      name: 'callbackUrl',
      type: 'text',
      interface: 'url',
      uiSchema: {
        type: 'string',
        title: tStr('Callback URL'),
        'x-component': 'Input.URL',
      },
    },
    {
      name: 'callbackApiKey',
      type: 'text',
      interface: 'password',
      uiSchema: {
        type: 'string',
        title: tStr('Callback API key'),
        'x-component': 'Password',
      },
    },
    {
      name: 'callbackTimeoutMs',
      type: 'integer',
      interface: 'integer',
      defaultValue: DEFAULT_SETTINGS.callbackTimeoutMs,
      uiSchema: {
        type: 'number',
        title: tStr('Callback timeout (ms)'),
        'x-component': 'InputNumber',
      },
    },
    {
      name: 'acceptStatus',
      type: 'string',
      interface: 'input',
      defaultValue: DEFAULT_SETTINGS.acceptStatus,
      uiSchema: {
        type: 'string',
        title: tStr('Accept status'),
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
        title: tStr('Reject status'),
        'x-component': 'Input',
      },
    },
    {
      name: 'itemsPath',
      type: 'string',
      interface: 'input',
      defaultValue: DEFAULT_MAPPING.itemsPath,
      uiSchema: {
        type: 'string',
        title: tStr('Items path'),
        'x-component': 'Input',
      },
    },
    {
      name: 'idPath',
      type: 'string',
      interface: 'input',
      defaultValue: DEFAULT_MAPPING.idPath,
      uiSchema: {
        type: 'string',
        title: tStr('ID path'),
        'x-component': 'Input',
      },
    },
    {
      name: 'keyPath',
      type: 'string',
      interface: 'input',
      defaultValue: DEFAULT_MAPPING.keyPath,
      uiSchema: {
        type: 'string',
        title: tStr('Key path'),
        'x-component': 'Input',
      },
    },
    {
      name: 'valuePath',
      type: 'string',
      interface: 'input',
      defaultValue: DEFAULT_MAPPING.valuePath,
      uiSchema: {
        type: 'string',
        title: tStr('Value path'),
        'x-component': 'Input',
      },
    },
    {
      name: 'pagePath',
      type: 'string',
      interface: 'input',
      defaultValue: DEFAULT_MAPPING.pagePath,
      uiSchema: {
        type: 'string',
        title: tStr('Page path'),
        'x-component': 'Input',
      },
    },
    {
      name: 'rectPath',
      type: 'string',
      interface: 'input',
      defaultValue: DEFAULT_MAPPING.rectPath,
      uiSchema: {
        type: 'string',
        title: tStr('Rectangle path'),
        'x-component': 'Input',
      },
    },
    {
      name: 'pointsPath',
      type: 'string',
      interface: 'input',
      defaultValue: DEFAULT_MAPPING.pointsPath,
      uiSchema: {
        type: 'string',
        title: tStr('Points path'),
        'x-component': 'Input',
      },
    },
    {
      name: 'confidencePath',
      type: 'string',
      interface: 'input',
      defaultValue: DEFAULT_MAPPING.confidencePath,
      uiSchema: {
        type: 'string',
        title: tStr('Confidence path'),
        'x-component': 'Input',
      },
    },
    {
      name: 'statusPath',
      type: 'string',
      interface: 'input',
      defaultValue: DEFAULT_MAPPING.statusPath,
      uiSchema: {
        type: 'string',
        title: tStr('Status path'),
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
        title: tStr('Enabled'),
        'x-component': 'Checkbox',
      },
    },
  ],
};

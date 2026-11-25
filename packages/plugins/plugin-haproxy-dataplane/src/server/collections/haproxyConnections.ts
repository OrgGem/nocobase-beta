// SPDX-License-Identifier: Apache-2.0

import { defineCollection } from '@nocobase/database';
import { COLLECTIONS, DEFAULT_TIMEOUT_MS } from '../../shared/constants';

export default defineCollection({
  name: COLLECTIONS.connections,
  title: 'HAProxy Data Plane Connections',
  fields: [
    {
      type: 'string',
      name: 'name',
      allowNull: false,
      unique: true,
      interface: 'input',
      uiSchema: { title: 'Name', type: 'string', 'x-component': 'Input' },
    },
    {
      type: 'string',
      name: 'title',
      interface: 'input',
      uiSchema: { title: 'Title', type: 'string', 'x-component': 'Input' },
    },
    {
      type: 'string',
      name: 'baseUrl',
      allowNull: false,
      interface: 'input',
      uiSchema: { title: 'Data Plane Base URL', type: 'string', 'x-component': 'Input' },
    },
    {
      type: 'string',
      name: 'authType',
      defaultValue: 'basic',
      interface: 'select',
      uiSchema: {
        title: 'Auth Type',
        type: 'string',
        'x-component': 'Select',
        enum: [
          { value: 'basic', label: 'Basic Auth' },
          { value: 'none', label: 'No Auth' },
        ],
      },
    },
    {
      type: 'string',
      name: 'username',
      interface: 'input',
      uiSchema: { title: 'Username', type: 'string', 'x-component': 'Input' },
    },
    {
      type: 'text',
      name: 'password',
      interface: 'password',
      uiSchema: { title: 'Password', type: 'string', 'x-component': 'Password' },
    },
    {
      type: 'boolean',
      name: 'tlsSkipVerify',
      defaultValue: false,
      interface: 'checkbox',
      uiSchema: { title: 'Skip TLS Verification', type: 'boolean', 'x-component': 'Checkbox' },
    },
    {
      type: 'integer',
      name: 'timeoutMs',
      defaultValue: DEFAULT_TIMEOUT_MS,
      interface: 'integer',
      uiSchema: { title: 'Request Timeout (ms)', type: 'number', 'x-component': 'InputNumber' },
    },
    {
      type: 'boolean',
      name: 'enabled',
      defaultValue: true,
      interface: 'checkbox',
      uiSchema: { title: 'Enabled', type: 'boolean', 'x-component': 'Checkbox' },
    },
    {
      type: 'text',
      name: 'notes',
      interface: 'textarea',
      uiSchema: { title: 'Notes', type: 'string', 'x-component': 'Input.TextArea' },
    },
    {
      type: 'date',
      name: 'lastCheckAt',
    },
    {
      type: 'string',
      name: 'lastApiVersion',
    },
    {
      type: 'string',
      name: 'lastHaproxyVersion',
    },
    {
      type: 'text',
      name: 'lastError',
    },
  ],
});

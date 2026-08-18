import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'apiPartners',
  title: 'API Partners',
  createdBy: true,
  updatedBy: true,
  fields: [
    {
      type: 'string',
      name: 'name',
      allowNull: false,
      unique: true,
      interface: 'input',
      uiSchema: {
        title: 'Name',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'string',
      name: 'contactEmail',
      interface: 'input',
      uiSchema: {
        title: 'Contact Email',
        type: 'string',
        'x-component': 'Input',
      },
    },
    {
      type: 'text',
      name: 'notes',
      interface: 'textarea',
      uiSchema: {
        title: 'Notes',
        type: 'string',
        'x-component': 'Input.TextArea',
      },
    },
    {
      type: 'boolean',
      name: 'enabled',
      defaultValue: true,
      interface: 'checkbox',
      uiSchema: {
        title: 'Enabled',
        type: 'boolean',
        'x-component': 'Checkbox',
      },
    },
  ],
});

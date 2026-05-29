import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'skillLoopConfigs',
  title: 'Skill Loop Configs',
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
    },
    {
      name: 'skill',
      type: 'belongsTo',
      target: 'skillDefinitions',
      foreignKey: 'skillId',
    },
    {
      name: 'enabled',
      type: 'boolean',
      defaultValue: true,
    },
    {
      name: 'title',
      type: 'string',
      length: 200,
    },
    {
      name: 'templateKey',
      type: 'string',
      length: 80,
      defaultValue: 'confirm',
    },
    {
      name: 'prompt',
      type: 'text',
    },
    {
      // Resolved interaction schema consumed by the generic Skill Hub UI card.
      name: 'schema',
      type: 'text',
    },
    {
      // Optional template-specific state for future loop renderers.
      name: 'config',
      type: 'text',
      defaultValue: null,
    },
    {
      name: 'createdAt',
      type: 'date',
    },
    {
      name: 'updatedAt',
      type: 'date',
    },
    {
      name: 'createdBy',
      type: 'belongsTo',
      target: 'users',
      foreignKey: 'createdById',
    },
  ],
} as CollectionOptions;

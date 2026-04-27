import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'skillDefinitions',
  title: 'Skill Definitions',
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
    },
    {
      name: 'name',
      type: 'string',
      length: 100,
      unique: true,
    },
    {
      name: 'title',
      type: 'string',
      length: 200,
    },
    {
      name: 'description',
      type: 'text',
    },
    {
      name: 'instructions',
      type: 'text',
    },
    {
      // 'node' | 'python'
      name: 'language',
      type: 'string',
      length: 20,
    },
    {
      // Code template with {{placeholder}} support
      name: 'codeTemplate',
      type: 'text',
    },
    {
      // JSON Schema for input parameters (used by AI tool)
      name: 'inputSchema',
      type: 'text',
    },
    {
      // Optional UI schema for human-in-the-loop interaction.
      // Shape: { type: 'form'|'select'|'confirm', prompt: string,
      //          options?: {label,value}[], fields?: Record<string, {type,title,required,enum}> }
      name: 'interactionSchema',
      type: 'text',
    },
    {
      // Pre-installed packages reference (informational)
      name: 'packages',
      type: 'text',
      defaultValue: null,
    },
    {
      name: 'timeoutSeconds',
      type: 'integer',
      defaultValue: 60,
    },
    {
      name: 'maxOutputSizeMb',
      type: 'integer',
      defaultValue: 50,
    },
    {
      name: 'enabled',
      type: 'boolean',
      defaultValue: true,
    },
    {
      // 'CUSTOM' | 'GENERAL' | 'SPECIFIED'
      name: 'toolScope',
      type: 'string',
      length: 20,
      defaultValue: 'CUSTOM',
    },
    {
      name: 'autoCall',
      type: 'boolean',
      defaultValue: false,
    },
    {
      // Which plugin registered this skill. null = built-in / user-created.
      // Format: plugin package name, e.g. 'plugin-skill-pptx-advanced'
      name: 'pluginSource',
      type: 'string',
      length: 200,
      defaultValue: null,
    },
    {
      name: 'storageType',
      type: 'string',
      length: 20,
      defaultValue: 'database', // 'database', 'local', 's3', 'plugin'
    },
    {
      name: 'storageUrl',
      type: 'string',
      length: 1000,
    },
    {
      name: 'file',
      type: 'belongsTo',
      target: 'attachments',
      foreignKey: 'fileId',
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

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'aiDiagrams',
  shared: true,
  dumpRules: 'required',
  migrationRules: ['overwrite', 'schema-only'],
  timestamps: true,
  fields: [
    {
      type: 'uid',
      name: 'id',
      primaryKey: true,
    },
    {
      type: 'string',
      name: 'title',
    },
    {
      type: 'text',
      name: 'description',
    },
    {
      type: 'string',
      name: 'mode',
      defaultValue: 'editable',
    },
    {
      type: 'text',
      name: 'xmlContent',
      length: 'long',
    },
    {
      type: 'text',
      name: 'thumbnailSvg',
      length: 'long',
    },
    {
      type: 'json',
      name: 'metadata',
    },
    {
      // BASIC (per-user owner) | SHARED (role-based) | PUBLIC (system-wide)
      type: 'string',
      name: 'accessLevel',
      defaultValue: 'BASIC',
    },
    {
      // Roles allowed to read/use/manage (for SHARED diagrams)
      type: 'array',
      name: 'allowedRoles',
    },
    {
      // How AI Employees (agents) may reach this diagram when running tools:
      //   inherit  — ride on the triggering user's access (default)
      //   explicit — only agents named in allowedAgents (or holding a role in allowedRoles)
      //   none     — no agent may ever read/use this diagram
      type: 'string',
      name: 'agentAccess',
      defaultValue: 'inherit',
    },
    {
      // AI Employee usernames explicitly granted access when agentAccess === 'explicit'
      type: 'array',
      name: 'allowedAgents',
    },
    {
      type: 'belongsTo',
      name: 'createdBy',
      target: 'users',
      foreignKey: 'createdById',
    },
    {
      type: 'belongsTo',
      name: 'updatedBy',
      target: 'users',
      foreignKey: 'updatedById',
    },
  ],
});

import { CollectionOptions } from '@nocobase/database';

export default {
  name: 'proxyServices',
  title: 'Proxy Services',
  fields: [
    { name: 'id', type: 'bigInt', autoIncrement: true, primaryKey: true },
    // Slug used in URL path: /proxy/<slug>/...
    { name: 'slug', type: 'string', length: 100, unique: true },
    // Human-readable label
    { name: 'title', type: 'string', length: 255 },
    // Target URL, e.g. http://testA:3000
    { name: 'targetUrl', type: 'string', length: 2048 },
    // Optional base path to strip/rewrite
    { name: 'stripPrefix', type: 'boolean', defaultValue: true },
    // Whether to pass auth headers
    { name: 'forwardAuth', type: 'boolean', defaultValue: false },
    // SPA support: rewrite absolute paths in HTML responses
    { name: 'rewriteHtml', type: 'boolean', defaultValue: true },
    // Render mode: 'iframe' (full SPA isolation) or 'embed' (Shadow DOM, server-rendered content)
    { name: 'renderMode', type: 'string', length: 20, defaultValue: 'iframe' },
    // Enabled flag
    { name: 'enabled', type: 'boolean', defaultValue: true },
    // Optional description
    { name: 'description', type: 'text' },
    { name: 'createdAt', type: 'date' },
    { name: 'updatedAt', type: 'date' },
  ],
} as CollectionOptions;

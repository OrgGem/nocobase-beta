/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { defineCollection } from '@nocobase/database';

/**
 * External OCR/document-parse API provider configurations.
 *
 * Each provider describes HOW to call an external service:
 *   - authentication (bearer / api-key-header / basic / custom-headers)
 *   - request format (multipart | json-base64)
 *   - response text extraction (dot-path into JSON response)
 */
export default defineCollection({
  name: 'docParserProviders',
  title: 'Document Parser Providers',
  fields: [
    {
      name: 'title',
      type: 'string',
    },
    {
      name: 'enabled',
      type: 'boolean',
      defaultValue: true,
    },
    // ── Endpoint ──────────────────────────────────────────────────────────────
    {
      name: 'apiEndpoint',
      type: 'string',
      comment: 'Full URL, e.g. https://ocr.example.com/v1/parse',
    },
    // ── Authentication ────────────────────────────────────────────────────────
    {
      name: 'authType',
      type: 'string',
      defaultValue: 'bearer',
      comment: "'bearer' | 'api-key-header' | 'basic' | 'custom-headers' | 'none'",
    },
    {
      // Encrypted at rest via NocoBase password field
      name: 'apiKey',
      type: 'password',
      allowNull: true,
      comment: 'Used for bearer / api-key-header auth',
    },
    {
      name: 'authConfig',
      type: 'json',
      defaultValue: {},
      comment: JSON.stringify({
        headerName: 'X-Api-Key', // for api-key-header
        username: '', // for basic auth
        password: '', // for basic auth
        customHeaders: {}, // for custom-headers: { "X-Foo": "bar" }
      }),
    },
    // ── Request format ────────────────────────────────────────────────────────
    {
      name: 'requestFormat',
      type: 'string',
      defaultValue: 'multipart',
      comment: "'multipart' | 'json-base64' | 'url'",
    },
    {
      name: 'requestConfig',
      type: 'json',
      defaultValue: {},
      comment: JSON.stringify({
        // multipart
        fileFieldName: 'file',
        filenameFieldName: '', // optional extra field for filename
        mimetypeFieldName: '', // optional extra field for mimetype
        extraFields: {}, // extra form fields
        // json-base64
        base64FieldPath: 'file', // e.g. "document.content"
        filenameFieldPath: 'filename',
        mimetypeFieldPath: 'mimetype',
        extraBody: {},
        // url (send download URL instead of file bytes)
        urlFieldPath: 'url',
      }),
    },
    // ── Response extraction ───────────────────────────────────────────────────
    {
      name: 'responseTextPath',
      type: 'string',
      defaultValue: 'text',
      comment: "Dot-path into the JSON response body, e.g. 'data.text' or 'result.pages[0].content'",
    },
    // ── Scope ─────────────────────────────────────────────────────────────────
    {
      name: 'supportedMimetypes',
      type: 'json',
      defaultValue: [],
      comment: 'Empty = handle everything routed to external. e.g. ["application/pdf"]',
    },
    {
      name: 'timeout',
      type: 'integer',
      defaultValue: 60000,
      comment: 'HTTP request timeout in milliseconds',
    },
    {
      name: 'options',
      type: 'json',
      defaultValue: {},
    },
  ],
});

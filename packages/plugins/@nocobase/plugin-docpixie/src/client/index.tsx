/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * DocPixie Plugin — Client Entry
 *
 * Registers the DocPixie plugin settings page in the NocoBase admin panel.
 */

import React from 'react';
import { Plugin } from '@nocobase/client';

const DocPixieSettings: React.FC = () => {
  return (
    <div style={{ padding: 24, maxWidth: 800, margin: '0 auto' }}>
      <h2>DocPixie Document AI</h2>
      <p style={{ color: '#666' }}>
        Adaptive RAG Agent for document analysis — OCR + LLM Vision + structured extraction.
      </p>

      <div
        style={{
          marginTop: 24,
          padding: 16,
          background: '#f6f6f6',
          borderRadius: 8,
          border: '1px solid #e8e8e8',
        }}
      >
        <h3>Configuration</h3>
        <p>Configure DocPixie via the REST API:</p>
        <ul>
          <li>POST /api/docpixie:updateConfig — Update plugin settings</li>
          <li>GET /api/docpixie:getConfig — View current settings</li>
          <li>POST /api/docpixie:processDocument — Ingest a document</li>
          <li>POST /api/docpixie:query — Query documents</li>
        </ul>
      </div>

      <div
        style={{
          marginTop: 16,
          padding: 16,
          background: '#e6f7ff',
          borderRadius: 8,
          border: '1px solid #91d5ff',
        }}
      >
        <p>
          💡 LLM services are configured in the NocoBase AI Settings page. Set your LLM service name in DocPixie config
          to use it for document analysis.
        </p>
      </div>
    </div>
  );
};

export class PluginDocPixieClient extends Plugin {
  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    this.app.pluginSettingsManager.add('plugin-docpixie', {
      title: '{{t("DocPixie Document AI")}}',
      icon: 'FileSearchOutlined',
      Component: DocPixieSettings,
    });
  }
}

export default PluginDocPixieClient;

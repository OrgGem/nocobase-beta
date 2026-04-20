/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React from 'react';
import { Plugin, lazy } from '@nocobase/client';
import { tval } from '@nocobase/utils/client';
import { KnowledgeBaseContext } from './components/KnowledgeBaseContext';

const { KnowledgeBases } = lazy(() => import('./components/KnowledgeBases'), 'KnowledgeBases');
const { Infrastructure } = lazy(() => import('./components/Infrastructure'), 'Infrastructure');

export class PluginKnowledgeBaseClient extends Plugin {
  async load() {
    // Register Knowledge Base work context in AI chat
    try {
      const aiPlugin = this.app.pm.get('ai') as any;
      if (aiPlugin?.aiManager) {
        aiPlugin.aiManager.registerWorkContext('knowledge-base', KnowledgeBaseContext);
      }
    } catch (e) {
      // plugin-ai may not be available
    }

    // Register settings pages under the AI plugin settings area
    this.app.pluginSettingsManager.add('ai.knowledge-base', {
      title: tval('Knowledge base'),
      icon: 'BookOutlined',
      Component: KnowledgeBases,
      aclSnippet: 'pm.plugin-knowledge-base.knowledge-base',
      sort: 300,
    });

    this.app.pluginSettingsManager.add('ai.infrastructure', {
      title: tval('Infrastructure'),
      icon: 'HddOutlined',
      Component: Infrastructure,
      aclSnippet: 'pm.plugin-knowledge-base.knowledge-base',
      sort: 310,
    });
  }
}

export default PluginKnowledgeBaseClient;

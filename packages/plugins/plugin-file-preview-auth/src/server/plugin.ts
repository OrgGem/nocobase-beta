/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import { ExcelParserHandler } from './excel-parser-handler';

export class PluginFilePreviewAuthServer extends Plugin {
  async load() {
    this.registerExcelParser();
  }

  /**
   * Register Excel handler into plugin-document-parser's InternalParserRegistry.
   * Uses prepend:true so SheetJS takes priority over the AI-loader fallback.
   * Silent no-op when plugin-document-parser is not loaded.
   */
  private registerExcelParser() {
    const docParserPlugin = this.pm.get('@nocobase/plugin-document-parser') as any;
    if (!docParserPlugin?.internalParserRegistry) {
      this.log.debug('[FilePreviewAuth] plugin-document-parser not found — Excel parser registration skipped');
      return;
    }

    try {
      docParserPlugin.internalParserRegistry.register(new ExcelParserHandler(), { prepend: true });
      this.log.info('[FilePreviewAuth] Excel parser handler registered into plugin-document-parser');
    } catch (err) {
      // Duplicate registration (e.g. hot-reload) — safe to ignore
      this.log.warn(`[FilePreviewAuth] Excel parser registration skipped: ${err}`);
    }
  }
}

export default PluginFilePreviewAuthServer;

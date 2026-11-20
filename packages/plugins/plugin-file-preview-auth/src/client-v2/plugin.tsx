/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Application, Plugin } from '@nocobase/client-v2';
import { DocumentPreviewController } from '../shared/DocumentPreviewModal';
import type { DocumentPreviewHandle, DocumentPreviewSource } from '../shared/documentPreview';
import { registerAuthenticatedFilePreviewTypes } from './authenticatedPreviewTypes';
import { registerFilePreviewAIWorkContext } from './AIFilePreviewAction';

export type { DocumentPreviewHandle, DocumentPreviewSource };

export class PluginFilePreviewAuthClient extends Plugin<Record<string, never>, Application> {
  private documentPreviewController?: DocumentPreviewController;

  private getDocumentPreviewController(): DocumentPreviewController {
    if (!this.documentPreviewController) {
      this.documentPreviewController = new DocumentPreviewController(this.app);
    }
    return this.documentPreviewController;
  }

  openDocumentPreview(source: DocumentPreviewSource): DocumentPreviewHandle {
    return this.getDocumentPreviewController().openDocumentPreview(source);
  }

  async load() {
    this.getDocumentPreviewController();
    registerFilePreviewAIWorkContext(this.app);
    registerAuthenticatedFilePreviewTypes(this.app);
  }
}

export default PluginFilePreviewAuthClient;

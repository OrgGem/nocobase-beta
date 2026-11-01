import { Plugin, Application } from '@nocobase/client-v2';
import { NAMESPACE } from '../shared/constants';
import { OcrVerifyBlockModel } from './block/OcrVerifyBlockModel';

export class PluginOcrVerifyBlockClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.flowEngine.registerModels({ OcrVerifyBlockModel });
    this.pluginSettingsManager.addMenuItem({
      key: 'ocr-verify-block',
      title: this.t('OCR Verify Block'),
      icon: 'FileSearchOutlined',
      aclSnippet: `pm.${NAMESPACE}.settings`,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ocr-verify-block',
      key: 'index',
      title: this.t('OCR Verify Block'),

      componentLoader: () => import('./pages/SettingsPage'),
    });
  }
}

export default PluginOcrVerifyBlockClient;

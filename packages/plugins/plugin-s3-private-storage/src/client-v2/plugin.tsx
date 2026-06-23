import { Application, Plugin } from '@nocobase/client-v2';
import { PluginFileManagerClientV2 } from '@nocobase/plugin-file-manager/client-v2';
import { NAMESPACE, STORAGE_TYPE_S3_PRIVATE } from '../constants';

const FILE_SIZE_LIMIT_DEFAULT = 1024 * 1024 * 20;

export class PluginS3PrivateStorageClient extends Plugin<Record<string, never>, Application> {
  async load() {
    const fileManagerPlugin = this.app.pm.get(PluginFileManagerClientV2);
    const title = this.app.i18n.t('AWS S3 (Private)', { ns: [NAMESPACE, 'client'], nsMode: 'fallback' });

    fileManagerPlugin.registerStorageType(STORAGE_TYPE_S3_PRIVATE, {
      title,
      formLoader: () => import('./S3PrivateStorageForm'),
      defaultValues: {
        renameMode: 'appendRandomID',
        baseUrl: '',
        rules: { size: FILE_SIZE_LIMIT_DEFAULT },
        options: {
          endpoint: '',
        },
      },
    });
  }
}

export default PluginS3PrivateStorageClient;

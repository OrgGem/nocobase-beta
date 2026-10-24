import { Application, Plugin } from '@nocobase/client-v2';
import { PluginFileManagerClientV2 } from '@nocobase/plugin-file-manager/client-v2';
import { STORAGE_TYPE_SFTP_PRIVATE } from '../constants';

export class PluginSftpPrivateStorageClient extends Plugin<Record<string, never>, Application> {
  async load() {
    const fileManager = this.app.pm.get(PluginFileManagerClientV2);
    fileManager.registerStorageType(STORAGE_TYPE_SFTP_PRIVATE, {
      title: this.t('SFTP Private Storage'),
      formLoader: () => import('./SftpPrivateStorageForm'),
      defaultValues: {
        renameMode: 'appendRandomID',
        rules: { size: 20 * 1024 * 1024 },
        options: { port: 22, authMethod: 'password', basePath: '/' },
      },
    });
  }
}

export default PluginSftpPrivateStorageClient;

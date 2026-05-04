import { Plugin } from '@nocobase/client';
import models from './models';
import { PackageRegistriesSettings } from './PackageRegistriesSettings';

export class PluginPackageRegistryClient extends Plugin {
  async load() {
    this.flowEngine.registerModels(models);

    this.app.pluginSettingsManager.add('plugin-package-registry', {
      title: 'Package Registries',
      icon: 'ApiOutlined',
      Component: PackageRegistriesSettings,
    });
  }
}

export default PluginPackageRegistryClient;

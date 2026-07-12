import { Plugin } from '@nocobase/client';
import models from './models';
import { ensureFieldStyleFormatStyleElement } from '../client-v2/plugin';

export class PluginFieldStyleFormatClient extends Plugin {
  async load() {
    this.flowEngine.registerModels(models);
    ensureFieldStyleFormatStyleElement();
  }
}

export default PluginFieldStyleFormatClient;

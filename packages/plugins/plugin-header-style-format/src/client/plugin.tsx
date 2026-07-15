import { Plugin } from '@nocobase/client';
import { ensureHeaderStyleFormatStyleElement } from '../client-v2/plugin';

export class PluginHeaderStyleFormatClient extends Plugin {
  async load() {
    ensureHeaderStyleFormatStyleElement();
  }
}

export default PluginHeaderStyleFormatClient;

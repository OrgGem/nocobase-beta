import { Plugin } from '@nocobase/client-v2';
import { DetailsJsonFieldItemModel, DisplayJsonPreviewFieldModel, JsonBlockModel } from './models';

export class PluginBlockJsonClientV2 extends Plugin {
  async load() {
    this.flowEngine.registerModels({
      JsonBlockModel,
      DetailsJsonFieldItemModel,
      DisplayJsonPreviewFieldModel,
    });
  }
}

export default PluginBlockJsonClientV2;

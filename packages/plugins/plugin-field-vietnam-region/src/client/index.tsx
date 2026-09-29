import { Plugin } from '@nocobase/client';
import { useVietnamRegionDataSource, useVietnamRegionLoadData } from './vietnamRegionProvider';
import { VietnamRegionFieldInterface } from './vietnamRegion';
import {
  VietnamRegionFieldModel,
  VietnamRegionFilterFieldModel,
  DisplayVietnamRegionFieldModel,
} from '../client-v2/models';

export class PluginFieldVietnamRegionClient extends Plugin {
  async load() {
    this.app.addScopes({
      useVietnamRegionDataSource,
      useVietnamRegionLoadData,
    });
    this.app.dataSourceManager.addFieldInterfaces([VietnamRegionFieldInterface]);
    this.flowEngine.registerModels({
      VietnamRegionFieldModel,
      VietnamRegionFilterFieldModel,
      DisplayVietnamRegionFieldModel,
    });
  }
}

export { VietnamRegionFieldModel, DisplayVietnamRegionFieldModel } from '../client-v2/models';
export default PluginFieldVietnamRegionClient;

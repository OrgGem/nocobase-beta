import { Application, Plugin } from '@nocobase/client-v2';
import { VietnamRegionFieldInterface } from './vietnamRegion';

export class PluginFieldVietnamRegionClient extends Plugin<any, Application> {
  async load() {
    this.app.addFieldInterfaces([VietnamRegionFieldInterface]);
    this.flowEngine.registerModelLoaders({
      VietnamRegionFieldModel: {
        loader: () => import('./models/VietnamRegionFieldModel'),
      },
      VietnamRegionFilterFieldModel: {
        loader: () => import('./models/VietnamRegionFieldModel'),
      },
      DisplayVietnamRegionFieldModel: {
        loader: () => import('./models/DisplayVietnamRegionFieldModel'),
      },
    });
  }
}

export default PluginFieldVietnamRegionClient;

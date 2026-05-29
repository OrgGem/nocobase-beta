import { Plugin, lazy, type DataSource } from '@nocobase/client';
import { NAMESPACE } from '../shared/constants';
import { OcrVerifyBlockProvider } from './block/OcrVerifyBlockProvider';
import { OcrVerifyBlockInitializer } from './block/OcrVerifyBlockInitializer';
import { OcrVerifyBlock } from './block/OcrVerifyBlock';
import { ocrVerifyBlockSettings } from './block/schemaSettings';
import { ocrVerifyCategoriesCollection } from './collections/ocrVerifyCategories';

const { SettingsPage } = lazy(() => import('./components/SettingsPage'), 'SettingsPage');

function addOcrVerifyCategoriesCollection(dataSource: DataSource) {
  dataSource.collectionManager.addCollections([ocrVerifyCategoriesCollection]);
}

export class PluginOcrVerifyBlockClient extends Plugin {
  async load() {
    this.app.addComponents({
      OcrVerifyBlockInitializer,
      OcrVerifyBlock,
    });
    this.app.use(OcrVerifyBlockProvider);
    this.app.schemaSettingsManager.add(ocrVerifyBlockSettings);

    const mainDataSource = this.app.dataSourceManager.getDataSource('main');
    if (mainDataSource) {
      const registerCategoriesCollection = () => addOcrVerifyCategoriesCollection(mainDataSource);
      registerCategoriesCollection();
      mainDataSource.addReloadCallback(registerCategoriesCollection);
    }

    this.app.pluginSettingsManager.add(NAMESPACE, {
      title: 'OCR Verify Block',
      icon: 'FileSearchOutlined',
      Component: SettingsPage,
      aclSnippet: `pm.${NAMESPACE}.settings`,
    });

    const register = (name: string) => {
      this.app.schemaInitializerManager.addItem(name, 'otherBlocks.ocrVerify', {
        name: 'ocrVerify',
        title: 'OCR Verify',
        Component: 'OcrVerifyBlockInitializer',
      });
    };

    register('page:addBlock');
    register('popup:addNew:addBlock');
    register('popup:common:addBlock');
    register('RecordFormBlockInitializers');
    register('mobilePage:addBlock');
  }
}

export default PluginOcrVerifyBlockClient;

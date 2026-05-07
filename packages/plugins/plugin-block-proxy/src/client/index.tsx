import { Plugin } from '@nocobase/client';
import { ProxyBlock } from './ProxyBlock';
import { ProxyBlockProvider } from './ProxyBlockProvider';
import { proxyBlockSettings } from './schemaSettings';
import { ProxyServiceManager } from './ProxyServiceManager';
import { ProxyBlockInitializer, useProxyServices } from './ProxyBlockInitializer';
import { ProxyBlockModel } from './models/ProxyBlockModel';
import { ProxyServiceSelect } from './ProxyServiceSelect';
import { NAMESPACE } from './locale';

export class PluginBlockProxyClient extends Plugin {
  async load() {
    // Register components
    this.app.addComponents({
      ProxyBlock: ProxyBlock as any,
      ProxyBlockInitializer,
      ProxyServiceSelect,
    });

    // Register schema settings (gear icon on block)
    this.app.schemaSettingsManager.add(proxyBlockSettings);

    // Register component provider
    this.app.use(ProxyBlockProvider);

    // Register FlowEngine model
    this.flowEngine.registerModels({
      ProxyBlockModel,
    });

    // Register settings page (admin → Plugin Settings → Proxy Services)
    this.app.pluginSettingsManager.add(NAMESPACE, {
      title: this.t('Proxy Services'),
      icon: 'ApiOutlined',
      Component: ProxyServiceManager,
      aclSnippet: `pm.${NAMESPACE}`,
    });

    const title = `{{t("Proxy Service", { ns: ["${NAMESPACE}", "client"], nsMode: "fallback" })}}`;

    const commonSettings = {
      title,
      type: 'subMenu' as const,
      icon: 'ApiOutlined',
      useChildren: useProxyServices,
    };

    // Register in all block initializer categories
    this.app.schemaInitializerManager.addItem('page:addBlock', 'otherBlocks.proxyBlock', commonSettings);
    this.app.schemaInitializerManager.addItem('popup:common:addBlock', 'otherBlocks.proxyBlock', commonSettings);
    this.app.schemaInitializerManager.addItem('popup:addNew:addBlock', 'otherBlocks.proxyBlock', commonSettings);
  }
}

export default PluginBlockProxyClient;

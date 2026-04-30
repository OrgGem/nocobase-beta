import { Plugin, lazy } from '@nocobase/client';
import { NAMESPACE } from './locale';

const { SettingsPage } = lazy(() => import('./components/SettingsPage'), 'SettingsPage');

export class PluginMarkItDownParserClient extends Plugin {
  async load() {
    const locale = this.app.i18n.language || 'en-US';
    try {
      const messages = await import(`../locale/${locale}.json`).catch(() => import('../locale/en-US.json'));
      this.app.i18n.addResourceBundle(locale, NAMESPACE, messages.default || messages, true, true);
    } catch {
      // Locale resources are optional.
    }

    this.app.pluginSettingsManager.add(NAMESPACE, {
      title: '{{t("MarkItDown Parser", { ns: "' + NAMESPACE + '" })}}',
      icon: 'FileMarkdownOutlined',
      Component: SettingsPage,
      aclSnippet: `pm.${NAMESPACE}`,
    });
  }
}

export default PluginMarkItDownParserClient;

import { Plugin, lazy } from '@nocobase/client';
import WorkflowPlugin from '@nocobase/plugin-workflow/client';
import { NAMESPACE } from './locale';
import CarboneRenderInstruction from './workflow/CarboneRenderInstruction';

const { SettingsPage } = lazy(() => import('./components/SettingsPage'), 'SettingsPage');

export class PluginCarboneTemplateManagerClient extends Plugin {
  declare app: any;
  async load() {
    const locale = this.app.i18n.language || 'en-US';
    try {
      const messages = await import(`../locale/${locale}.json`).catch(
        () => import('../locale/en-US.json'),
      );
      this.app.i18n.addResourceBundle(locale, NAMESPACE, messages.default || messages, true, true);
    } catch {
      // Locale file may not exist for this language — silently skip
    }

    this.app.pluginSettingsManager.add(NAMESPACE, {
      title: `{{t("Carbone Template Manager", { ns: "${NAMESPACE}" })}}`,
      icon: 'FileWordOutlined',
      Component: SettingsPage,
      aclSnippet: `pm.${NAMESPACE}.settings`,
    });

    // P6 — register the workflow instruction. Skipped silently when the
    // workflow plugin isn't enabled.
    const workflow = this.app.pm.get('workflow') as any;
    workflow?.registerInstruction('carbone-render', CarboneRenderInstruction);
  }
}

export default PluginCarboneTemplateManagerClient;

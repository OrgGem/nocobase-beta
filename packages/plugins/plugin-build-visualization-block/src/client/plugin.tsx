import { Plugin } from '@nocobase/client';

import { BuildVisualizationBlockInitializer } from './BuildVisualizationBlockInitializer';
import { SettingsPage } from './SettingsPage';

/**
 * Block initializers the "Build Visualization Block" item is added to so it is
 * reachable from desktop pages, both popup "add block" menus, and mobile pages.
 */
const BLOCK_INITIALIZERS = [
  'page:addBlock',
  'popup:common:addBlock',
  'popup:addNew:addBlock',
  'mobile:addBlock',
] as const;

/** Item key within the `dataBlocks` group of each block initializer. */
const INITIALIZER_ITEM_KEY = 'dataBlocks.buildVisualizationBlock';

/**
 * Client-side plugin for `plugin-build-visualization-block`.
 *
 * - `afterAdd` performs soft availability checks for the data-visualization and
 *   AI plugins (the block leans on both at build/render time). Missing plugins
 *   are reported with `console.warn` and never throw, so this plugin still loads
 *   in environments where they are absent.
 * - `load` registers the {@link BuildVisualizationBlockInitializer} component and
 *   wires it into the "Add block" menus.
 * - `remove` unregisters those menu items (Req 8.4).
 *
 * This plugin uses the v1 client runtime (`@nocobase/client`); it must not
 * import from the v2 runtime.
 */
export class PluginBuildVisualizationBlockClient extends Plugin {
  // Req 8.1: surface (but do not enforce) the soft dependencies on
  // data-visualization and AI so a misconfigured environment is diagnosable.
  async afterAdd() {
    const { pm } = this.app;

    try {
      const dataVisualization = pm.get('@nocobase/plugin-data-visualization') || pm.get('plugin-data-visualization');
      if (!dataVisualization) {
        console.warn('[plugin-build-visualization-block] plugin-data-visualization is not available');
      }
    } catch {
      console.warn('[plugin-build-visualization-block] plugin-data-visualization is not available');
    }

    try {
      const ai = pm.get('@nocobase/plugin-ai') || pm.get('plugin-ai');
      if (!ai) {
        console.warn('[plugin-build-visualization-block] plugin-ai is not available');
      }
    } catch {
      console.warn('[plugin-build-visualization-block] plugin-ai is not available');
    }
  }

  async load() {
    this.app.addComponents({ BuildVisualizationBlockInitializer });

    this.app.pluginSettingsManager.add('plugin-build-visualization-block', {
      icon: 'DashboardOutlined',
      title: this.t('Build Visualization Block'),
      Component: SettingsPage,
      aclSnippet: 'pm.plugin-build-visualization-block.settings',
    });

    // NOTE: deliberately omit `type: 'item'` so the entry renders as a standard
    // clickable item in the "Add block" dropdown (see
    // plugin-setup-architecture-instructions.md, "type: 'item' trap").
    BLOCK_INITIALIZERS.forEach((initializer) => {
      this.app.schemaInitializerManager.addItem(initializer, INITIALIZER_ITEM_KEY, {
        name: 'buildVisualizationBlock',
        title: '{{t("Build Visualization Block", { ns: "plugin-build-visualization-block" })}}',
        Component: 'BuildVisualizationBlockInitializer',
      });
    });
  }

  // Req 8.4: tear down the registered items on uninstall/disable.
  async remove() {
    this.app.pluginSettingsManager.remove('plugin-build-visualization-block');
    BLOCK_INITIALIZERS.forEach((initializer) => {
      this.app.schemaInitializerManager.removeItem(initializer, INITIALIZER_ITEM_KEY);
    });
  }
}

export default PluginBuildVisualizationBlockClient;

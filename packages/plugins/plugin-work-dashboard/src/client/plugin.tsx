import { Plugin } from '@nocobase/client';
import { getVisualizationTemplateRegistry } from 'plugin-visualization-templates/client';

import { workDashboardTemplates } from './templates';

export class PluginWorkDashboardClient extends Plugin {
  async load() {
    getVisualizationTemplateRegistry().registerMany(workDashboardTemplates);
  }

  async remove() {
    const registry = getVisualizationTemplateRegistry();
    workDashboardTemplates.forEach((t) => registry.remove(t.key));
  }
}

export default PluginWorkDashboardClient;

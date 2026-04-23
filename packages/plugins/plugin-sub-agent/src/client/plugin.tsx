import { Plugin } from '@nocobase/client';
import { SubAgents } from './SubAgents';

export class PluginSubAgentClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add('ai.sub-agents', {
      title: 'Sub Agents',
      icon: 'RobotOutlined',
      Component: SubAgents,
    });
  }
}

export default PluginSubAgentClient;

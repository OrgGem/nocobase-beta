import { InstallOptions, Plugin } from '@nocobase/server';
import { resolve } from 'path';
import {
  getConfig,
  setConfig,
  getDriverStatus,
  prepareSession,
  markLiveViewOpened,
  getScreenshot,
  stopSession,
  buildWorkflowCache,
} from './actions';
import { PlaywrightDriver, IBrowserDriver } from './drivers';
import { BrowserSessionService, BrowserProfileService, BrowserPolicyService } from './services';
import {
  browserOpenUrlTool,
  browserClickElementTool,
  browserInputTextTool,
  browserScrollTool,
  browserReadPageTool,
  browserGetSessionTool,
  browserStopSessionTool,
  browserListSessionsTool,
  browserGetArtifactsTool,
  browserRunCachedWorkflowTool,
} from './tools';

export class PluginAIBrowserServer extends Plugin {
  static instance: PluginAIBrowserServer;
  declare app: any;
  driver: IBrowserDriver | null = null;
  sessionService: BrowserSessionService | null = null;
  profileService: BrowserProfileService | null = null;
  policyService: BrowserPolicyService | null = null;

  async load() {
    PluginAIBrowserServer.instance = this;
    await (this as any).importCollections(resolve(__dirname, 'collections'));

    // Initialize driver
    this.driver = new PlaywrightDriver();

    // Initialize services
    this.sessionService = new BrowserSessionService((this as any).app, this.driver);
    this.profileService = new BrowserProfileService((this as any).app);
    this.policyService = new BrowserPolicyService((this as any).app);

    // Register resource and actions
    (this as any).app.resourceManager.define({
      name: 'aiBrowser',
      actions: {
        getConfig,
        setConfig,
        getDriverStatus,
        prepareSession,
        markLiveViewOpened,
        getScreenshot,
        stopSession,
        buildWorkflowCache,
      },
    });

    // ACL — logged-in users can read; admin snippet for writes
    (this as any).app.acl.allow('aiBrowserSessions', ['list', 'get'], 'loggedIn');
    (this as any).app.acl.allow('aiBrowserTasks', ['list', 'get'], 'loggedIn');
    (this as any).app.acl.allow('aiBrowserProfiles', ['list', 'get'], 'loggedIn');
    (this as any).app.acl.allow('aiBrowserActionEvents', ['list', 'get'], 'loggedIn');
    (this as any).app.acl.allow('aiBrowserWorkflowCaches', ['list', 'get'], 'loggedIn');
    (this as any).app.acl.allow('aiBrowser', 'getConfig', 'loggedIn');
    (this as any).app.acl.allow('aiBrowser', 'getDriverStatus', 'loggedIn');
    (this as any).app.acl.allow('aiBrowser', 'prepareSession', 'loggedIn');
    (this as any).app.acl.allow('aiBrowser', 'markLiveViewOpened', 'loggedIn');
    (this as any).app.acl.allow('aiBrowser', 'getScreenshot', 'loggedIn');
    (this as any).app.acl.allow('aiBrowser', 'stopSession', 'loggedIn');

    (this as any).app.acl.registerSnippet({
      name: 'pm.ai-browser',
      actions: [
        'aiBrowserSessions:*',
        'aiBrowserTasks:*',
        'aiBrowserProfiles:*',
        'aiBrowserActionEvents:*',
        'aiBrowserWorkflowCaches:*',
        'aiBrowserCachedSteps:*',
        'aiBrowserElementFingerprints:*',
        'aiBrowserConfig:*',
        'aiBrowser:setConfig',
        'aiBrowser:buildWorkflowCache',
        'aiBrowser:stopSession',
      ],
    });

    // Register AI tools
    this.registerAITools();
  }

  private registerAITools() {
    const app = (this as any).app;
    const toolsManager = app.aiManager?.toolsManager;
    if (!toolsManager) {
      app.logger.warn('[plugin-ai-browser] aiManager.toolsManager not available; skipping tool registration');
      return;
    }

    const allTools = [
      browserOpenUrlTool,
      browserClickElementTool,
      browserInputTextTool,
      browserScrollTool,
      browserReadPageTool,
      browserGetSessionTool,
      browserStopSessionTool,
      browserListSessionsTool,
      browserGetArtifactsTool,
      browserRunCachedWorkflowTool,
    ];

    toolsManager.registerTools(
      allTools.map((item: any) => {
        const name = `${item.groupName}_${item.tool.name}`;
        return {
          scope: 'GENERAL',
          defaultPermission: name === 'browser_open_url' ? 'ASK' : 'ALLOW',
          silence: false,
          execution: item.tool.execution,
          introduction: {
            title: item.tool.title,
            about: item.tool.description,
          },
          definition: {
            name,
            description: item.tool.description,
            schema: item.tool.schema,
          },
          invoke: item.tool.invoke,
        };
      }),
    );

    app.logger.info(`[plugin-ai-browser] Registered ${allTools.length} AI tools`);
  }

  async install(options?: InstallOptions) {}

  async upgrade() {}

  async beforeDestroy() {
    if (this.driver) {
      await this.driver.dispose().catch(() => {});
    }
  }
}

export default PluginAIBrowserServer;

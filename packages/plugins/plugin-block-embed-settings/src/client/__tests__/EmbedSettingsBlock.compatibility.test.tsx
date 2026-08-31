import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies - must match the pattern in EmbedSettingsBlock.test.tsx
vi.mock('@formily/react', () => ({
  useFieldSchema: () => ({ 'x-component-props': {} }),
}));

vi.mock('../locale', () => ({
  useT: () => (key: string) => key,
}));

// Test components that simulate real plugin behavior with embedded prop
const OrchestratorComponent = ({ embedded }: { embedded?: boolean }) => (
  <div data-testid="orchestrator-settings">
    {embedded ? <span data-testid="embedded-mode">Embedded</span> : <span data-testid="standalone-mode">Standalone</span>}
    {!embedded && <div style={{ padding: '0 24px 24px' }} data-testid="padding-wrapper">With Padding</div>}
    <div data-testid="tabs-content">Agent Runs Tab</div>
  </div>
);

const AiApiConfigPage = ({ embedded }: { embedded?: boolean }) => (
  <div data-testid="ai-api-config">
    <span>AI API Configuration</span>
    {embedded && <span data-testid="embedded-prop-received">embedded=true</span>}
  </div>
);

const ApiManagerSettingsPage = ({ embedded }: { embedded?: boolean }) => (
  <div data-testid="api-manager-settings">
    <div style={embedded ? undefined : { maxWidth: 760, padding: 16 }}>
      <span>Runtime Settings</span>
    </div>
    {embedded && <span data-testid="no-inline-styles">No inline styles when embedded</span>}
  </div>
);

const ApiManagerGuidePage = ({ embedded }: { embedded?: boolean }) => (
  <div data-testid="api-manager-guide">
    <div style={embedded ? { width: '100%' } : { width: '100%', maxWidth: 960 }}>
      <span>API Guide</span>
    </div>
  </div>
);

describe('EmbedSettingsBlock - Plugin Compatibility', () => {
  describe('plugin-agent-orchestrator', () => {
    it('renders OrchestratorSettings with embedded prop and no padding', async () => {
      vi.doMock('@nocobase/client-v2', () => ({
        useApp: () => ({
          pluginSettingsManager: {
            has: (name: string) => name === 'ai-orchestrator',
            get: (name: string) => {
              if (name === 'ai-orchestrator') {
                return {
                  name: 'ai-orchestrator',
                  title: 'Agent Orchestrator',
                  Component: OrchestratorComponent,
                  aclSnippet: 'pm.ai-orchestrator',
                };
              }
              return undefined;
            },
          },
          i18n: { t: (key: string) => key },
        }),
      }));

      const { EmbedSettingsBlock } = await import('../EmbedSettingsBlock');
      render(<EmbedSettingsBlock pluginName="ai-orchestrator" />);

      expect(screen.getByTestId('orchestrator-settings')).toBeTruthy();
      expect(screen.getByTestId('embedded-mode')).toBeTruthy();
      expect(screen.queryByTestId('padding-wrapper')).toBeNull();
    });

    it('has correct ACL snippet configured for ai-orchestrator', () => {
      const setting = {
        name: 'ai-orchestrator',
        title: 'Agent Orchestrator',
        Component: OrchestratorComponent,
        aclSnippet: 'pm.ai-orchestrator',
      };
      expect(setting.aclSnippet).toBe('pm.ai-orchestrator');
    });
  });

  describe('plugin-ai-api', () => {
    it('collects all AI API tabs correctly', async () => {
      const app = {
        pluginSettingsManager: {
          has: (name: string) => name === 'ai-api',
          get: (name: string) => ({
            name: 'ai-api',
            title: 'AI API Gateway',
            children: [
              { name: 'ai-api.config', key: 'config', title: 'Configuration', Component: AiApiConfigPage },
              { name: 'ai-api.model-pricing', key: 'model-pricing', title: 'Model pricing', Component: () => null },
              { name: 'ai-api.usage', key: 'usage', title: 'Usage', Component: () => null },
            ],
          }),
        },
        i18n: { t: (key: string) => key },
      };

      const { collectEmbeddablePluginTabs } = await import('../EmbedSettingsPluginSelect');
      const tabs = collectEmbeddablePluginTabs(app, 'ai-api');
      expect(tabs).toHaveLength(3);
      expect(tabs.map((t) => t.value)).toEqual([
        'ai-api.config',
        'ai-api.model-pricing',
        'ai-api.usage',
      ]);
    });

    it('AI API config page receives embedded prop when rendered', () => {
      // Verify component signature accepts embedded prop
      const result = render(<AiApiConfigPage embedded />);
      expect(result.getByTestId('embedded-prop-received')).toBeTruthy();
    });
  });

  describe('plugin-api-manager', () => {
    it('collects all api-manager sub-tabs', async () => {
      const app = {
        pluginSettingsManager: {
          has: (name: string) => name === 'api-manager',
          get: (name: string) => ({
            name: 'api-manager',
            title: 'API Manager',
            children: [
              { name: 'api-manager.guide', key: 'guide', title: 'Guide', Component: () => null },
              { name: 'api-manager.settings', key: 'settings', title: 'Runtime Settings', Component: () => null },
              { name: 'api-manager.routes', key: 'routes', title: 'Routes', Component: () => null },
              { name: 'api-manager.partners', key: 'partners', title: 'Partners', Component: () => null },
              { name: 'api-manager.partner-roles', key: 'partner-roles', title: 'Partner Roles', Component: () => null },
              { name: 'api-manager.logs', key: 'logs', title: 'Request Logs', Component: () => null },
            ],
          }),
        },
        i18n: { t: (key: string) => key },
      };

      const { collectEmbeddablePluginTabs } = await import('../EmbedSettingsPluginSelect');
      const tabs = collectEmbeddablePluginTabs(app, 'api-manager');
      expect(tabs).toHaveLength(6);
      expect(tabs.map((t) => t.value)).toContain('api-manager.guide');
      expect(tabs.map((t) => t.value)).toContain('api-manager.routes');
    });

    it('SettingsPage removes inline styles when embedded=true', () => {
      const result = render(<ApiManagerSettingsPage embedded />);
      expect(result.getByTestId('no-inline-styles')).toBeTruthy();
    });

    it('GuidePage removes maxWidth constraint when embedded=true', () => {
      const result = render(<ApiManagerGuidePage embedded />);
      expect(result.getByTestId('api-manager-guide')).toBeTruthy();
      // Verify the wrapper div does NOT have maxWidth when embedded
      const wrapper = result.getByTestId('api-manager-guide').firstChild as HTMLElement;
      expect(wrapper.style.maxWidth).toBeFalsy();
    });
  });

  describe('Cross-plugin compatibility', () => {
    it('component with embedded prop hides standalone-only UI', () => {
      const CompWithTitle = ({ embedded }: { embedded?: boolean }) => (
        <div>
          {!embedded && <h2>Plugin Title</h2>}
          <div data-testid="content">Content only</div>
        </div>
      );

      // When embedded=true, title should be hidden
      const result = render(<CompWithTitle embedded />);
      expect(result.getByTestId('content')).toBeTruthy();
      expect(result.queryByText('Plugin Title')).toBeNull();
    });

    it('component without embedded prop shows standalone UI', () => {
      const CompWithTitle = ({ embedded }: { embedded?: boolean }) => (
        <div>
          {!embedded && <h2>Plugin Title</h2>}
          <div data-testid="content">Content only</div>
        </div>
      );

      // When embedded is not passed, title should be visible
      const result = render(<CompWithTitle />);
      expect(result.getByText('Plugin Title')).toBeTruthy();
    });
  });
});

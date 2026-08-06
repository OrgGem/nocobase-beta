import { describe, expect, it } from 'vitest';
import PluginAppObservabilityServer from '../plugin';

describe('PluginAppObservabilityServer', () => {
  it('exposes an independent NocoBase server plugin class', () => {
    expect(PluginAppObservabilityServer).toBeTypeOf('function');
    expect(PluginAppObservabilityServer.prototype.load).toBeTypeOf('function');
    expect(PluginAppObservabilityServer.prototype.beforeLoad).toBeTypeOf('function');
  });
});

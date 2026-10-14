import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GeneralPage from '../pages/GeneralPage';
import ModelPricingPage from '../pages/ModelPricingPage';
import ModelMetadataPage from '../pages/ModelMetadataPage';
import ModelRoutingPage from '../pages/ModelRoutingPage';
import UsageGroupsPage from '../pages/UsageGroupsPage';
import UsagePage from '../pages/UsagePage';

const { app } = vi.hoisted(() => ({
  app: {
    apiClient: { request: vi.fn() },
    i18n: { t: vi.fn((key: string) => key) },
  },
}));

vi.mock('@nocobase/client-v2', () => ({ useApp: () => app }));
vi.mock('@nocobase/flow-engine', () => ({
  tExpr: (key: string) => key,
  // Embedded settings have an application but must not require the settings route's local context.
  useFlowContext: () => {
    throw new Error('Settings route context unavailable');
  },
}));

describe('AI API embedded settings', () => {
  beforeEach(() => {
    app.apiClient.request.mockReset();
    app.apiClient.request.mockImplementation(async ({ url }: { url: string }) => ({
      data: {
        data: url === 'aiApiConfig:get' ? {} : url === 'aiApiUsageMonitor:summary' ? { costsByCurrency: [] } : [],
      },
    }));
  });
  afterEach(cleanup);

  it.each([
    ['configuration', GeneralPage, 'aiApiConfig:get'],
    ['pricing', ModelPricingPage, 'aiApiModelPrices:list'],
    ['metadata', ModelMetadataPage, 'aiApiModelMetadata:list'],
    ['routing', ModelRoutingPage, 'aiApiVirtualModels:list'],
    ['usage groups', UsageGroupsPage, 'aiApiUsageGroups:list'],
    ['usage', UsagePage, 'aiApiUsageMonitor:summary'],
  ] as const)('loads %s using the embedded application API', async (_label, Page, url) => {
    render(<Page />);
    await waitFor(() => expect(app.apiClient.request).toHaveBeenCalledWith(expect.objectContaining({ url })));
    expect(app.i18n.t).toHaveBeenCalledWith(expect.any(String), { ns: ['plugin-ai-api', 'client'] });
  });
});

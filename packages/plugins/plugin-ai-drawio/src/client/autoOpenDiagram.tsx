import React from 'react';
import { Drawer } from 'antd';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { DrawioBlock } from './DrawioBlock';
import { getActiveHandle } from './lib/activeRegistry';
import type { DrawioActiveHandle } from './lib/activeRegistry';

type OpenDiagramOptions = {
  title?: string;
  description?: string;
};

type HostState = {
  open: boolean;
  diagramId?: string;
  title?: string;
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let state: HostState = { open: false };
let currentApp: any = null;

function getApiClient(app: any) {
  const apiClient = app?.apiClient;
  if (!apiClient) {
    throw new Error('NocoBase API client is not available.');
  }
  return apiClient;
}

function renderHost() {
  if (!container) {
    container = document.createElement('div');
    container.setAttribute('data-ai-drawio-auto-host', 'true');
    document.body.appendChild(container);
  }
  if (!root) {
    root = createRoot(container);
  }

  const Providers = currentApp?.getComposeProviders?.();
  if (!Providers) {
    throw new Error('NocoBase app providers are not available.');
  }

  root.render(
    <Providers>
      <Drawer
        open={state.open}
        onClose={() => {
          state = { ...state, open: false };
          renderHost();
        }}
        width="100%"
        title={state.title || 'Drawio Diagram'}
        destroyOnClose
        styles={{ body: { padding: 0 } }}
      >
        {state.diagramId && <DrawioBlock diagramId={state.diagramId} height="calc(100vh - 56px)" />}
      </Drawer>
    </Providers>,
  );
}

function waitForHandle(diagramId: string, timeoutMs = 8000): Promise<DrawioActiveHandle | null> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const handle = getActiveHandle();
      if (handle?.diagramId === diagramId) {
        resolve(handle);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(null);
        return;
      }
      window.setTimeout(tick, 100);
    };
    tick();
  });
}

export async function createAndOpenDiagram(app: any, options: OpenDiagramOptions = {}) {
  currentApp = app;
  const apiClient = getApiClient(app);
  const title = options.title || `AI diagram ${new Date().toLocaleString()}`;

  const response = await apiClient.resource('aiDiagrams').create({
    values: {
      title,
      description: options.description || '',
      mode: 'editable',
    },
  });
  const diagramId = response?.data?.data?.id || response?.data?.id;
  if (!diagramId) {
    throw new Error('Failed to create draw.io diagram.');
  }

  state = { open: true, diagramId, title };
  renderHost();

  const handle = await waitForHandle(diagramId);
  if (!handle) {
    throw new Error('Drawio editor did not become ready in time.');
  }

  return handle;
}

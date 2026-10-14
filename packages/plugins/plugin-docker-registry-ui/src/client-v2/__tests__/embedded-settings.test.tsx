import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RegistryManagerPage from '../pages/RegistryManagerPage';
import RegistryGuidePage from '../pages/RegistryGuidePage';
import RegistrySettingsPage from '../pages/RegistrySettingsPage';

const { context, api, permissions, translate } = vi.hoisted(() => ({
  context: { api: {}, router: { navigate: vi.fn() }, message: { success: vi.fn(), error: vi.fn() } },
  api: {
    getPublicSettings: vi.fn(),
    getSettings: vi.fn(),
    listRepositories: vi.fn(),
    testConnection: vi.fn(),
    listTags: vi.fn(),
    getImageDetails: vi.fn(),
    updateSettings: vi.fn(),
    downloadImage: vi.fn(),
  },
  permissions: {
    canRead: true,
    canDelete: true,
    canDownload: true,
    canUpload: true,
    canConfigure: true,
    canManage: true,
  },
  translate: (key: string) => key,
}));

vi.mock('@nocobase/flow-engine', () => ({
  useFlowEngineContext: () => context,
  useFlowContext: () => {
    throw new Error('No local settings context');
  },
}));
vi.mock('../api', () => ({ registryApi: api }));
vi.mock('../locale', () => ({ useT: () => translate }));
vi.mock('../permissions', () => ({ useDockerRegistryPermissions: () => permissions }));

function HostLocation() {
  const location = useLocation();
  return <output data-testid="host-location">{location.pathname + location.search}</output>;
}

describe('Docker Registry embedded settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getPublicSettings.mockResolvedValue({});
    api.getSettings.mockResolvedValue({ displayName: 'Registry', credentialMode: 'none', storage: 'filesystem' });
    api.updateSettings.mockResolvedValue({ displayName: 'Registry', credentialMode: 'none', storage: 'filesystem' });
    api.listRepositories.mockResolvedValue({ items: ['team/backend'] });
    api.testConnection.mockResolvedValue({ reachable: true, authentication: 'public' });
    api.listTags.mockResolvedValue({ items: ['1.4.2'] });
    api.getImageDetails.mockResolvedValue({ kind: 'image', layers: [], configData: {} });
  });
  afterEach(cleanup);

  it('keeps repository, tag and Back navigation inside one block and ignores host query parameters', async () => {
    render(
      <MemoryRouter initialEntries={['/portal/dashboard?name=unrelated&tag=host']}>
        <HostLocation />
        <section data-testid="first">
          <RegistryManagerPage embedded />
        </section>
        <section data-testid="second">
          <RegistryManagerPage embedded />
        </section>
      </MemoryRouter>,
    );
    const first = within(screen.getByTestId('first'));
    const second = within(screen.getByTestId('second'));
    fireEvent.click(await first.findByRole('button', { name: 'Open' }));
    fireEvent.click(await first.findByRole('button', { name: 'Download image' }));
    fireEvent.click(await screen.findByText('Docker save tar'));
    await waitFor(() => expect(api.downloadImage).toHaveBeenCalledWith(context, 'team/backend', '1.4.2', 'docker'));
    fireEvent.click(await first.findByRole('button', { name: 'Inspect' }));
    await waitFor(() => expect(api.getImageDetails).toHaveBeenCalledWith(context, 'team/backend', '1.4.2'));
    fireEvent.click(first.getByRole('button', { name: /Back$/ }));
    expect(await first.findByRole('button', { name: 'Inspect' })).toBeTruthy();
    fireEvent.click(first.getByRole('button', { name: /Back$/ }));
    expect(await first.findByRole('button', { name: 'Open' })).toBeTruthy();
    expect(second.getByRole('button', { name: 'Open' })).toBeTruthy();
    expect(screen.getByTestId('host-location').textContent).toBe('/portal/dashboard?name=unrelated&tag=host');
    expect(context.router.navigate).not.toHaveBeenCalled();
    expect(first.queryByRole('button', { name: 'Settings' })).toBeNull();
  });

  it('preserves standalone URL navigation', async () => {
    render(
      <MemoryRouter>
        <RegistryManagerPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(context.router.navigate).toHaveBeenCalledWith('/admin/settings/docker-registry/images?name=team%2Fbackend');
  });

  it.each([
    ['settings', RegistrySettingsPage, api.getSettings],
    ['guide', RegistryGuidePage, api.getPublicSettings],
  ] as const)('loads the %s tab without a local settings context', async (_label, Page, request) => {
    render(<Page embedded />);
    await waitFor(() => expect(request).toHaveBeenCalledWith(context));
  });
});

// SPDX-License-Identifier: Apache-2.0

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsSearchInjector } from '../../shared/SettingsSearchInjector';

afterEach(cleanup);

type SettingsMenuProps = {
  entries: string[];
  testId?: string;
};

function SettingsMenu({ entries, testId = 'settings-menu' }: SettingsMenuProps) {
  return (
    <ul className="ant-menu" data-testid={testId}>
      {entries.map((entry) => (
        <li className="ant-menu-item" key={entry}>
          {entry}
        </li>
      ))}
    </ul>
  );
}

function SettingsLayout({
  children,
  headerClassName = 'ant-page-header',
}: React.PropsWithChildren<{ headerClassName?: string }>) {
  return (
    <div className="ant-layout ant-layout-has-sider">
      <aside className="ant-layout-sider" data-testid="settings-sider">
        <div className="ant-layout-sider-children">{children}</div>
      </aside>
      <main className="ant-layout-content">
        <div className={headerClassName}>Settings</div>
        <Link to="/admin/settings-other">Open similarly named page</Link>
        <Link to="/admin">Leave Settings</Link>
        <div>Settings content</div>
      </main>
    </div>
  );
}

function ShellWithSettings({ children }: React.PropsWithChildren) {
  return (
    <div className="ant-layout ant-layout-has-sider">
      <aside className="ant-layout-sider" data-testid="shell-sider">
        <div className="ant-layout-sider-children">
          <ul className="ant-menu" data-testid="shell-menu">
            <li className="ant-menu-item">Dashboard</li>
          </ul>
        </div>
      </aside>
      <div>{children}</div>
    </div>
  );
}

function SettingsRoutes() {
  return (
    <Routes>
      <Route
        path="/admin"
        element={
          <>
            <Link to="/admin/settings/general">Open Settings</Link>
            <Link to="/admin/settings-other">Open similarly named page</Link>
          </>
        }
      />
      <Route
        path="/admin/settings/:page"
        element={
          <SettingsLayout>
            <SettingsMenu entries={['General', 'Mail', 'Users']} />
          </SettingsLayout>
        }
      />
      <Route
        path="/admin/settings-other"
        element={
          <SettingsLayout>
            <SettingsMenu entries={['Other page']} />
          </SettingsLayout>
        }
      />
    </Routes>
  );
}

function renderRoutedSettings(initialPath = '/admin') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SettingsSearchInjector>
        <SettingsRoutes />
      </SettingsSearchInjector>
    </MemoryRouter>,
  );
}

describe('SettingsSearchInjector', () => {
  it('adds search after client-side navigation into Settings and removes it after leaving', async () => {
    renderRoutedSettings();

    expect(document.getElementById('settings-sidebar-search')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Open Settings' }));
    expect(await screen.findByRole('searchbox', { name: 'Settings Search' })).toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Open similarly named page' }));
    await waitFor(() => expect(document.getElementById('settings-sidebar-search')).toBeNull());
  });

  it('does not treat a route with a Settings-like prefix as the Settings section', async () => {
    renderRoutedSettings('/admin/settings-other');

    await waitFor(() => expect(screen.getByText('Other page')).toBeTruthy());
    expect(document.getElementById('settings-sidebar-search')).toBeNull();
  });

  it('injects into the Settings sidebar instead of an earlier application-shell sidebar', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/settings/general']}>
        <SettingsSearchInjector>
          <ShellWithSettings>
            <SettingsRoutes />
          </ShellWithSettings>
        </SettingsSearchInjector>
      </MemoryRouter>,
    );

    const search = await screen.findByRole('searchbox', { name: 'Settings Search' });
    expect(screen.getByTestId('settings-sider').contains(search)).toBe(true);
    expect(screen.getByTestId('shell-sider').contains(search)).toBe(false);
    fireEvent.input(search, { target: { value: 'mail' } });
    expect(screen.getByTestId('shell-menu').querySelector('.ant-menu-item')?.getAttribute('style')).toBeNull();
  });

  it('works when the client router uses a basename', async () => {
    render(
      <MemoryRouter basename="/v" initialEntries={['/v/admin/settings/general']}>
        <SettingsSearchInjector>
          <SettingsRoutes />
        </SettingsSearchInjector>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('searchbox', { name: 'Settings Search' })).toBeTruthy();
  });

  it('recognizes a valid V2 PageHeader without the standard ant-page-header class', async () => {
    render(
      <MemoryRouter initialEntries={['/admin/settings/single']}>
        <SettingsSearchInjector>
          <Routes>
            <Route
              path="/admin/settings/:page"
              element={
                <SettingsLayout headerClassName="ant-page-header-no-children">
                  <SettingsMenu entries={['General']} />
                </SettingsLayout>
              }
            />
          </Routes>
        </SettingsSearchInjector>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('searchbox', { name: 'Settings Search' })).toBeTruthy();
  });

  it('waits for a delayed Settings menu, then retains and reapplies the filter when that menu is replaced', async () => {
    function DelayedSettings() {
      const [menuVersion, setMenuVersion] = useState(0);
      const [menuVisible, setMenuVisible] = useState(false);
      const entries = menuVersion === 0 ? ['Mail', 'Users'] : ['Mail settings', 'General'];

      return (
        <div className="ant-layout ant-layout-has-sider">
          <aside key={menuVersion} className="ant-layout-sider" data-testid="settings-sider">
            <div className="ant-layout-sider-children">
              <button type="button" onClick={() => setMenuVisible(true)}>
                Mount menu
              </button>
              <button type="button" onClick={() => setMenuVersion((version) => version + 1)}>
                Replace menu
              </button>
              {menuVisible && <SettingsMenu entries={entries} />}
            </div>
          </aside>
          <main className="ant-layout-content">
            <div className="ant-page-header">Settings</div>
            <div>Settings content</div>
          </main>
        </div>
      );
    }

    render(
      <MemoryRouter initialEntries={['/admin/settings/general']}>
        <SettingsSearchInjector>
          <Routes>
            <Route path="/admin/settings/:page" element={<DelayedSettings />} />
          </Routes>
        </SettingsSearchInjector>
      </MemoryRouter>,
    );

    expect(document.getElementById('settings-sidebar-search')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mount menu' }));
    const search = await screen.findByRole('searchbox', { name: 'Settings Search' });
    fireEvent.input(search, { target: { value: 'mail' } });
    expect(screen.getByText('Mail').style.display).toBe('');
    expect(screen.getByText('Users').style.display).toBe('none');

    fireEvent.click(screen.getByRole('button', { name: 'Replace menu' }));
    await waitFor(() => {
      const replacementSearch = screen.getByRole('searchbox', { name: 'Settings Search' }) as HTMLInputElement;
      expect(replacementSearch.value).toBe('mail');
      expect(screen.getByText('Mail settings').style.display).toBe('');
      expect(screen.getByText('General').style.display).toBe('none');
    });
    expect(document.querySelectorAll('#settings-sidebar-search')).toHaveLength(1);
  });

  it('restores original inline display values when the filter is cleared', async () => {
    function ProviderUnmountHarness() {
      const [providerMounted, setProviderMounted] = useState(true);

      return (
        <>
          {providerMounted && (
            <SettingsSearchInjector>
              <button type="button" onClick={() => setProviderMounted(false)}>
                Remove search provider
              </button>
            </SettingsSearchInjector>
          )}
          <div className="ant-layout ant-layout-has-sider">
            <aside className="ant-layout-sider" data-testid="settings-sider">
              <div className="ant-layout-sider-children">
                <SettingsMenu entries={['Mail', 'Users']} />
              </div>
            </aside>
            <main className="ant-layout-content">
              <div className="ant-page-header">Settings</div>
            </main>
          </div>
        </>
      );
    }

    render(
      <MemoryRouter initialEntries={['/admin/settings/general']}>
        <ProviderUnmountHarness />
      </MemoryRouter>,
    );

    const usersItem = await screen.findByText('Users');
    usersItem.style.display = 'inline-flex';
    fireEvent.input(screen.getByRole('searchbox', { name: 'Settings Search' }), {
      target: { value: 'mail' },
    });
    expect(usersItem.style.display).toBe('none');

    fireEvent.input(screen.getByRole('searchbox', { name: 'Settings Search' }), {
      target: { value: '' },
    });
    expect(usersItem.style.display).toBe('inline-flex');

    fireEvent.input(screen.getByRole('searchbox', { name: 'Settings Search' }), {
      target: { value: 'mail' },
    });
    expect(usersItem.style.display).toBe('none');

    fireEvent.click(screen.getByRole('button', { name: 'Remove search provider' }));

    expect(usersItem.isConnected).toBe(true);
    expect(usersItem.style.display).toBe('inline-flex');
    expect(document.getElementById('settings-sidebar-search')).toBeNull();
  });
});

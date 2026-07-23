import { describe, expect, it } from 'vitest';
import {
  getHubAppPath,
  getHubBasename,
  getHubPagePath,
  getHubPopupPath,
  getHubTabPath,
  normalizeHubLink,
  redirectLegacyNextAppLocation,
} from '../hubRouteContract';

describe('hubRouteContract', () => {
  it('builds main, public-path and sub-app basenames', () => {
    expect(getHubBasename('/')).toBe('/hub');
    expect(getHubBasename('/nocobase/')).toBe('/nocobase/hub');
    expect(getHubBasename('/apps/crm/')).toBe('/apps/crm/hub');
  });

  it('builds app, page, tab and popup paths', () => {
    expect(getHubAppPath('sales')).toBe('/hub/sales');
    expect(getHubPagePath('sales', 'orders')).toBe('/hub/sales/orders');
    expect(getHubTabPath('sales', 'orders', 'details')).toBe('/hub/sales/orders/tabs/details');
    expect(getHubPopupPath('sales', 'orders', 'create')).toBe('/hub/sales/orders/popups/create');
  });

  it('redirects legacy paths while preserving search and hash', () => {
    expect(redirectLegacyNextAppLocation('/next-app/sales/orders', '?role=admin', '#details')).toBe(
      '/hub/sales/orders?role=admin#details',
    );
  });

  it('maps admin links into the current Hub app and leaves external links unchanged', () => {
    expect(normalizeHubLink('/admin/orders', 'sales')).toBe('/sales/orders');
    expect(normalizeHubLink('/admin', 'sales')).toBe('/sales');
    expect(normalizeHubLink('', 'sales')).toBe('/sales');
    expect(normalizeHubLink('/orders', 'sales')).toBe('/sales/orders');
    expect(normalizeHubLink('/hub/operations/orders', 'sales')).toBe('/operations/orders');
    expect(normalizeHubLink('https://example.com', 'sales')).toBe('https://example.com');
  });
});

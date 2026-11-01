/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import * as client from '@nocobase/client-v2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useN8nRequest } from '../hooks/useN8nRequest';

let instanceId: string | number | null = '90071992547409933';
vi.mock('../context/InstanceContext', () => ({ useCurrentInstance: () => ({ instanceId }) }));
afterEach(() => {
  vi.restoreAllMocks();
});
describe('n8n native V2 request lifecycle', () => {
  it('preserves string IDs, clears data when switching instance and ignores a late previous response', async () => {
    const app = client.createMockClient();
    vi.spyOn(client, 'useApp').mockReturnValue(app);
    const requests: { resolve: (value: unknown) => void }[] = [];
    const request = vi
      .spyOn(app.apiClient, 'request')
      .mockImplementation(() => new Promise((resolve) => requests.push({ resolve })));
    const hook = renderHook(() => useN8nRequest('n8nWorkflows', 'list'));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(request.mock.calls[0][0]).toMatchObject({ params: { instanceId: '90071992547409933' } });
    instanceId = '90071992547409934';
    hook.rerender();
    expect(hook.result.current.data).toBeNull();
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => requests[1].resolve({ data: { data: [{ id: 'new' }] } }));
    await act(async () => requests[0].resolve({ data: { data: [{ id: 'old' }] } }));
    expect(hook.result.current.data).toEqual([{ id: 'new' }]);
    instanceId = null;
    hook.rerender();
    expect(hook.result.current.data).toBeNull();
    hook.unmount();
  });
});

/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import '@testing-library/jest-dom/vitest';
import { createMockClient } from '@nocobase/client-v2';
import { FlowEngineProvider } from '@nocobase/flow-engine';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Permissions from '../Permissions';
vi.mock('../locale', () => ({ useT: () => (key: string) => key }));
afterEach(cleanup);

describe('V2 role permission requests', () => {
  it('switches to explicit action permissions and removes only view while preserving other actions and IDs', async () => {
    const app = createMockClient();
    const record = {
      id: '90071992547409931',
      usingActionsConfig: false,
      actions: [
        { id: '90071992547409932', name: 'view' },
        { id: '90071992547409933', name: 'create' },
      ],
    };
    app.apiMock.onGet('rolesResources:list').reply(() => [200, { data: [record] }]);
    app.apiMock.onPost('rolesResources:update').reply(() => {
      record.usingActionsConfig = true;
      return [200, { data: record }];
    });
    app.apiMock.onPost(`rolesResources/${record.id}/actions:destroy`).reply(() => {
      record.actions = record.actions.filter((action) => action.name !== 'view');
      return [200, {}];
    });
    render(
      <FlowEngineProvider engine={app.flowEngine}>
        <App>
          <Permissions
            activeRole={{ name: 'member', title: 'Member', strategy: { actions: ['view'] } }}
            activeKey="sharedForms"
            currentUserRole={null}
            onRoleChange={vi.fn()}
          />
        </App>
      </FlowEngineProvider>,
    );
    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(app.apiMock.history.post).toHaveLength(2));
    expect(app.apiMock.history.post[0].params.filterByTk).toBe(record.id);
    expect(app.apiMock.history.post[1].params.filterByTk).toBe('90071992547409932');
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(record.actions.map((action) => action.name)).toEqual(['create']);
  });
});

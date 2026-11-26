// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Form } from 'antd';
import { fireEvent, render, screen } from '@testing-library/react';
import { installReviewTestFieldset } from '../../client-v2/ReviewTestFieldset';
import type { TriggerLoaderOf } from '@nocobase/plugin-workflow/client-v2';

const state = vi.hoisted(() => ({ collection: 'gitReviewRequests' }));
vi.mock('@nocobase/plugin-workflow/client-v2', () => ({
  useCurrentWorkflowContext: () => ({ config: { collection: state.collection } }),
}));
vi.mock('../../client-v2/locale', () => ({ useT: () => (key: string) => key }));

it('submits an editable test diff from the canvas and keeps the native picker for other collections', async () => {
  const trigger: { TriggerFieldsetLoader: TriggerLoaderOf } = {
    TriggerFieldsetLoader: async () => ({ default: () => <span>Native record picker</span> }),
  };
  installReviewTestFieldset(trigger);
  const { default: Fieldset } = await trigger.TriggerFieldsetLoader();
  const onFinish = vi.fn();
  const view = render(
    <Form onFinish={onFinish}>
      <Fieldset />
      <button type="submit">Run</button>
    </Form>,
  );
  const input = screen.getByLabelText('Test diff');
  expect(screen.getByDisplayValue(/diff --git/)).toBe(input);
  fireEvent.change(input, { target: { value: '+updated line' } });
  fireEvent.click(screen.getByText('Run'));
  await vi.waitFor(() => expect(onFinish).toHaveBeenCalledWith({ reviewTestDiff: '+updated line' }));
  state.collection = 'users';
  view.rerender(
    <Form>
      <Fieldset />
    </Form>,
  );
  expect(screen.getByText('Native record picker')).toBeInTheDocument();
});

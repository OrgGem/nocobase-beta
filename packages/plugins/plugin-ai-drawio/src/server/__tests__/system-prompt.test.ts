// SPDX-License-Identifier: Apache-2.0

import type { Context } from '@nocobase/actions';
import { expect, it, vi } from 'vitest';
import Plugin from '../plugin';
import { getSystemPrompt } from '../actions/getSystemPrompt';

it('loads the source server entry and serves the prompt using the registered tool contracts', async () => {
  expect(Plugin).toBeTypeOf('function');
  const ctx = { set: vi.fn() } as unknown as Context;
  const next = vi.fn();
  await getSystemPrompt(ctx, next);
  expect(ctx.body).toContain('drawio-display_model_diagram');
  expect(ctx.body).toContain('drawio-inspect_active_diagram');
  expect(ctx.body).toContain('mxCell');
  expect(ctx.withoutDataWrapping).toBe(true);
  expect(ctx.set).toHaveBeenCalledWith({ 'Content-Type': 'text/plain; charset=UTF-8' });
  expect(next).toHaveBeenCalledOnce();
});

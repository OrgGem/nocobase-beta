// SPDX-License-Identifier: Apache-2.0

import { createMockClient } from '@nocobase/client-v2';
import NativeAuth from '@nocobase/plugin-auth/client-v2';
import { describe, expect, it, vi } from 'vitest';
import Plugin from '../plugin';
import { authType } from '../../constants';

describe('OIDC native V2 authentication contract', () => {
  it('registers lazy sign-in and admin settings loaders using the native Auth registry', async () => {
    const app = createMockClient();
    const auth = new NativeAuth({}, app);
    vi.spyOn(app.pm, 'get').mockReturnValue(auth);
    const register = vi.spyOn(auth, 'registerType');
    await new Plugin({}, app).load();
    expect(register).toHaveBeenCalledWith(
      authType,
      expect.objectContaining({
        signInButtonLoader: expect.any(Function),
        adminSettingsFormLoader: expect.any(Function),
      }),
    );
    const options = register.mock.calls[0][1];
    expect((await options.signInButtonLoader()).default).toBeTypeOf('function');
    expect((await options.adminSettingsFormLoader()).default).toBeTypeOf('function');
    vi.restoreAllMocks();
  });
});

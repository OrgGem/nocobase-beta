/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockClient, useApp } from '@nocobase/client-v2';
import { filePreviewTypes } from '@nocobase/plugin-file-manager/client-v2';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { installAiChatFilePreviewEffect } from '../chatFilePreviewEffect';

describe('AI file preview native V2 context', () => {
  it('gives detached native File Manager previewers the application flow context', async () => {
    const app = createMockClient();
    vi.spyOn(filePreviewTypes, 'getTypeByFile').mockReturnValue({
      Previewer: ({ onClose }) => (
        <button onClick={onClose}>{useApp() === app ? 'Native preview context' : 'Missing context'}</button>
      ),
    });
    installAiChatFilePreviewEffect(app);
    const anchor = document.createElement('a');
    anchor.href = 'https://files.example/report.pdf';
    anchor.textContent = 'report.pdf';
    document.body.appendChild(anchor);
    fireEvent.click(anchor);
    fireEvent.click(await screen.findByRole('button', { name: 'Native preview context' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Native preview context' })).toBeNull());
    (window as Window & { __pluginAiChatFilePreviewV2Cleanup?: () => void }).__pluginAiChatFilePreviewV2Cleanup?.();
    anchor.remove();
    vi.restoreAllMocks();
  });
});

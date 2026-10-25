/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useDrawioHost } from '../drawioHost';

afterEach(cleanup);
describe('Drawio V2 shared editor lifecycle', () => {
  it('elects one editor host across multiple AI cards and hands ownership to the next card on unmount', async () => {
    function Card({ id }: { id: string }) {
      return <div>{useDrawioHost() ? `host-${id}` : `card-${id}`}</div>;
    }
    const view = render(
      <>
        <Card key="a" id="a" />
        <Card key="b" id="b" />
      </>,
    );
    await waitFor(() => expect(screen.getByText('host-a')).toBeDefined());
    expect(screen.queryByText('host-b')).toBeNull();
    view.rerender(<Card key="b" id="b" />);
    await waitFor(() => expect(screen.getByText('host-b')).toBeDefined());
  });
});

// SPDX-License-Identifier: Apache-2.0

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

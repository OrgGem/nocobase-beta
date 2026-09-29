/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

const { mockFlowContext } = vi.hoisted(() => ({ mockFlowContext: { flowSettingsEnabled: true } }));

vi.mock('../../../../..', () => ({
  useFlowContext: () => mockFlowContext,
}));

vi.mock('../../embedded/FlowsSettings', () => ({
  FlowsSettings: () => <div data-testid="flows-settings">settings</div>,
}));

vi.mock('../../../../../reactive', () => ({
  observer: (component: unknown) => component,
}));

import { FlowsModalWrapper } from '../FlowsModalWrapper';
import { FlowsDrawerWrapper } from '../FlowsDrawerWrapper';

const fakeModel = { translate: (k: string) => k } as unknown as React.ComponentProps<typeof FlowsModalWrapper>['model'];

function setSettingsEnabled(v: boolean) {
  mockFlowContext.flowSettingsEnabled = v;
}

// FlowsModalWrapper

describe('FlowsModalWrapper', () => {
  it('renders children only when flowSettingsEnabled is false', () => {
    setSettingsEnabled(false);
    render(
      <FlowsModalWrapper model={fakeModel}>
        <span data-testid="child">Hello</span>
      </FlowsModalWrapper>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('opens Modal when clicking the wrapper div (non-interactive child)', () => {
    setSettingsEnabled(true);
    render(
      <FlowsModalWrapper model={fakeModel}>
        <span data-testid="child">content</span>
      </FlowsModalWrapper>,
    );

    fireEvent.click(screen.getByTestId('child'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does NOT open Modal when clicking a nested button', () => {
    setSettingsEnabled(true);
    const onClick = vi.fn();
    render(
      <FlowsModalWrapper model={fakeModel}>
        <button data-testid="inner-btn" onClick={onClick}>
          press me
        </button>
      </FlowsModalWrapper>,
    );

    fireEvent.click(screen.getByTestId('inner-btn'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does NOT open Modal when typing Space inside a nested input', () => {
    setSettingsEnabled(true);
    render(
      <FlowsModalWrapper model={fakeModel}>
        <input data-testid="inner-input" />
      </FlowsModalWrapper>,
    );

    const input = screen.getByTestId('inner-input');
    input.focus();
    fireEvent.keyDown(input, { key: ' ' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens Modal via Enter keydown on the wrapper div itself', () => {
    setSettingsEnabled(true);
    render(
      <FlowsModalWrapper model={fakeModel}>
        <span data-testid="child">content</span>
      </FlowsModalWrapper>,
    );

    const wrapper = screen.getByRole('button');
    fireEvent.keyDown(wrapper, { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

// FlowsDrawerWrapper

describe('FlowsDrawerWrapper', () => {
  it('renders children only when flowSettingsEnabled is false', () => {
    setSettingsEnabled(false);
    render(
      <FlowsDrawerWrapper model={fakeModel}>
        <span data-testid="child">Hello</span>
      </FlowsDrawerWrapper>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('opens Drawer when clicking the wrapper div (non-interactive child)', () => {
    setSettingsEnabled(true);
    render(
      <FlowsDrawerWrapper model={fakeModel}>
        <span data-testid="child">content</span>
      </FlowsDrawerWrapper>,
    );

    fireEvent.click(screen.getByTestId('child'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does NOT open Drawer when clicking a nested button', () => {
    setSettingsEnabled(true);
    const onClick = vi.fn();
    render(
      <FlowsDrawerWrapper model={fakeModel}>
        <button data-testid="inner-btn" onClick={onClick}>
          press me
        </button>
      </FlowsDrawerWrapper>,
    );

    fireEvent.click(screen.getByTestId('inner-btn'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does NOT open Drawer when typing Space inside a nested input', () => {
    setSettingsEnabled(true);
    render(
      <FlowsDrawerWrapper model={fakeModel}>
        <input data-testid="inner-input" />
      </FlowsDrawerWrapper>,
    );

    const input = screen.getByTestId('inner-input');
    input.focus();
    fireEvent.keyDown(input, { key: ' ' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

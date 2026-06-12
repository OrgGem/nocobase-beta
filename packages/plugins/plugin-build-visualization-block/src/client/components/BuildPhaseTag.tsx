import React from 'react';
import { Tag } from 'antd';
import { useField } from '@formily/react';
import { isField } from '@formily/core';
import { BuildPhase } from '../../shared/constants';
import { useT } from '../locale';

/** Ant Design Tag colors for each build phase. */
const PHASE_COLORS: Record<BuildPhase, string> = {
  idle: 'default',
  queued: 'default',
  analyzing: 'processing',
  generating: 'processing',
  completed: 'success',
  failed: 'error',
};

/** Localization keys for each build phase label. */
const PHASE_LABELS: Record<BuildPhase, string> = {
  idle: 'Idle',
  queued: 'Queued',
  analyzing: 'Analyzing',
  generating: 'Generating',
  completed: 'Completed',
  failed: 'Failed',
};

const PHASES = Object.keys(PHASE_COLORS) as BuildPhase[];

function isBuildPhase(value: unknown): value is BuildPhase {
  return typeof value === 'string' && (PHASES as string[]).includes(value);
}

export interface BuildPhaseTagProps {
  /**
   * The phase to render. When omitted, the value is read from the surrounding
   * Formily field, allowing the tag to be used as a read-pretty field
   * component as well as a plain presentational tag.
   */
  value?: BuildPhase;
}

/**
 * A small Ant Design `Tag` that renders a build phase with a phase-specific
 * color and a localized label.
 */
export const BuildPhaseTag = (props: BuildPhaseTagProps) => {
  const t = useT();
  const field = useField();
  const fieldValue = isField(field) ? field.value : undefined;
  const phase = props.value ?? fieldValue;

  if (!isBuildPhase(phase)) {
    return null;
  }

  return (
    <Tag color={PHASE_COLORS[phase]} aria-label={t(PHASE_LABELS[phase])}>
      {t(PHASE_LABELS[phase])}
    </Tag>
  );
};

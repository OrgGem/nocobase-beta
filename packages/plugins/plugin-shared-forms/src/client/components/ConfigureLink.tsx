// SPDX-License-Identifier: Apache-2.0

import { useFilterByTk } from '@nocobase/client';
import React from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../locale';

export function ConfigureLink() {
  const value = useFilterByTk();
  const t = useT();

  return <Link to={`/admin/settings/shared-forms/${value}`}>{t('Configure')}</Link>;
}

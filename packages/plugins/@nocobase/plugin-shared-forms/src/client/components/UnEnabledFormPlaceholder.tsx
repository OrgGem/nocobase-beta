/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Result } from 'antd';
import React from 'react';
import { useSharedFormTranslation } from '../locale';

export const UnEnabledFormPlaceholder = () => {
  const { t } = useSharedFormTranslation();
  return <Result status="warning" title={t('The form is not enabled')} />;
};

export const UnFoundFormPlaceholder = () => {
  const { t } = useSharedFormTranslation();
  return <Result status="404" title={t('The form is not found')} />;
};

export const AccessDeniedPlaceholder = () => {
  const { t } = useSharedFormTranslation();
  return (
    <Result
      status="403"
      title={t('Access denied')}
      subTitle={t('You do not have permission to access this form. Please contact the administrator.')}
    />
  );
};

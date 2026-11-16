// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from 'react-i18next';
export const namespace = 'plugin-visualization-templates';
export const useT = () => useTranslation([namespace, 'client']).t;

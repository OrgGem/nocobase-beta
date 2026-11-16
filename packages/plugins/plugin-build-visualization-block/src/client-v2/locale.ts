// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from 'react-i18next';
export { PLUGIN_NAME as NAMESPACE } from '../shared/constants';
export const useT = () => useTranslation(['plugin-build-visualization-block', 'client']).t;

/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

// Helper constants for all PostgreSQL templates
// Import complete field interfaces configuration
import { NAMESPACE } from '../../constants';
import { POSTGRES_AVAILABLE_INTERFACES } from './field-interfaces-config';

export const nsT = (key: string) => `{{t(${JSON.stringify(key)}, { ns: "${NAMESPACE}" })}}`;

// Calendar, Tree, and File templates support all field types
export const CALENDAR_FIELD_INTERFACES = POSTGRES_AVAILABLE_INTERFACES;
export const TREE_FIELD_INTERFACES = POSTGRES_AVAILABLE_INTERFACES;
export const FILE_FIELD_INTERFACES = POSTGRES_AVAILABLE_INTERFACES;

// SQL and View templates support read-only subset (they're based on queries/views)
export const SQL_FIELD_INTERFACES = {
  include: [
    // Basic text types (read-only)
    'input',
    'textarea',
    'email',
    'url',
    'phone',
    // Numeric types (read-only)
    'integer',
    'number',
    'percent',
    'currency',
    // Visual
    'password',
    'color',
    'icon',
    // Choices (single selection for display)
    'checkbox',
    'select',
    'radio',
    // Date & Time (all variants for display)
    'datetime',
    'datetimeNoTz',
    'date',
    'time',
    'unixTimestamp',
    // Advanced types (read-only)
    'json',
    'uuid',
    // Media (read-only display)
    'richText',
    'markdown',
    'attachment',
    // System fields
    'id',
    'createdAt',
    'updatedAt',
  ],
};

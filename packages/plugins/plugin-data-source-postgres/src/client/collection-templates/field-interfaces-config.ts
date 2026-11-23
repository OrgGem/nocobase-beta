/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * Complete Field Interfaces Configuration for PostgreSQL Templates
 * Matches main datasource field types
 */

export const POSTGRES_AVAILABLE_INTERFACES = {
  include: [
    // Basic text types (Single line text, Long text, Phone, Email, URL)
    'input', // Single line text
    'textarea', // Long text
    'phone', // Phone
    'email', // Email
    'url', // URL

    // Numeric types (Integer, Number, Percent)
    'integer', // Integer
    'number', // Number
    'percent', // Percent
    'currency', // Currency (bonus)

    // Security (Password)
    'password', // Password

    // Visual (Color, Icon)
    'color', // Color
    'icon', // Icon

    // Choices (Checkbox, Single select, Multiple select, Radio group, Checkbox group)
    'checkbox', // Checkbox (boolean)
    'select', // Single select
    'multipleSelect', // Multiple select
    'radio', // Radio group
    'checkboxGroup', // Checkbox group

    // Media (Markdown, Rich Text)
    'markdown', // Markdown
    'richText', // Rich Text

    // Date & Time (all variants)
    'datetime', // Datetime (with time zone)
    'datetimeNoTz', // Datetime (without time zone)
    'date', // DateOnly
    'time', // Time
    'unixTimestamp', // Unix Timestamp

    // Advanced types
    'json', // JSON field
    'uuid', // UUID

    // Relationships (NocoBase interface names)
    'm2o', // Many to One
    'obo', // One to One (belongs to)
    'oho', // One to One (has one)
    'o2m', // One to Many
    'm2m', // Many to Many
    'm2m_array', // Many to Many (array)

    // System fields
    'id', // ID (auto)
    'createdAt', // Created at
    'updatedAt', // Updated at
    'sort', // Sort order
  ],
};

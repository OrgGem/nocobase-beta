// Columns query — uses sys.columns directly (no INFORMATION_SCHEMA.COLUMNS join
// for better performance on databases with many objects)
// Adapted from dbgate-plugin-mssql/src/backend/sql/columns.js (GPL-3.0)

export const columnsQuery = `
select c.name as columnName, t.name as dataType, c.object_id as objectId, c.is_identity as isIdentity,
    c.max_length as maxLength, c.precision, c.scale, c.is_nullable as isNullable,
    c.max_length as charMaxLength,
    d.definition as defaultValue, d.name as defaultConstraint,
    m.definition as computedExpression, m.is_persisted as isPersisted, c.column_id as columnId,
    c.precision as numericPrecision,
    c.scale as numericScale,
    c.is_sparse as isSparse,
    ep.value as columnComment
from sys.columns c
inner join sys.types t on c.system_type_id = t.system_type_id and c.user_type_id = t.user_type_id
inner join sys.objects o on c.object_id = o.object_id
INNER JOIN sys.schemas u ON u.schema_id=o.schema_id
left join sys.default_constraints d on c.default_object_id = d.object_id
left join sys.computed_columns m on m.object_id = c.object_id and m.column_id = c.column_id
left join sys.extended_properties ep on ep.major_id = c.object_id
    and ep.minor_id = c.column_id
    and ep.name = 'MS_Description'
    and ep.class = 1
where o.type = 'U' and o.object_id =OBJECT_ID_CONDITION and u.name =SCHEMA_NAME_CONDITION
order by c.column_id`;

// Base columns (for content hash computation) — same optimization
export const baseColumnsQuery = `
select c.name as columnName, t.name as dataType, c.object_id as objectId,
    c.is_identity as isIdentity,
    c.max_length as maxLength, c.precision, c.scale, c.is_nullable as isNullable,
    c.max_length as charMaxLength,
    d.definition as defaultValue, d.name as defaultConstraint,
    m.definition as computedExpression, m.is_persisted as isPersisted,
    c.column_id as columnId,
    c.precision as numericPrecision,
    c.scale as numericScale,
    ep.value as columnComment
from sys.columns c
inner join sys.types t on c.system_type_id = t.system_type_id and c.user_type_id = t.user_type_id
inner join sys.objects o on c.object_id = o.object_id
INNER JOIN sys.schemas u ON u.schema_id=o.schema_id
left join sys.default_constraints d on c.default_object_id = d.object_id
left join sys.computed_columns m on m.object_id = c.object_id and m.column_id = c.column_id
left join sys.extended_properties ep on ep.major_id = c.object_id
    and ep.minor_id = c.column_id
    and ep.name = 'MS_Description'
    and ep.class = 1
where o.type = 'U' and o.object_id =OBJECT_ID_CONDITION and u.name =SCHEMA_NAME_CONDITION
order by c.column_id`;

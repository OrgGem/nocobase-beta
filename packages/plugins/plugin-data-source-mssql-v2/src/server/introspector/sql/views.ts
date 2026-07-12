// Views query
// Adapted from dbgate-plugin-mssql/src/backend/sql/views.js (GPL-3.0)
export const viewsQuery = `
select o.name as pureName, s.name as schemaName, o.object_id as objectId,
    o.create_date as createDate, o.modify_date as modifyDate,
    ep.value as objectComment
from sys.views o
inner join sys.schemas s on o.schema_id = s.schema_id
left join sys.extended_properties ep on ep.major_id = o.object_id
    and ep.minor_id = 0
    and ep.name = 'MS_Description'
    and ep.class = 1
where o.object_id =OBJECT_ID_CONDITION and s.name =SCHEMA_NAME_CONDITION`;

// View columns query — uses sys.columns directly (no INFORMATION_SCHEMA.COLUMNS)
export const viewColumnsQuery = `
select c.name as columnName, t.name as dataType, c.object_id as objectId,
    c.max_length as maxLength, c.precision, c.scale, c.is_nullable as isNullable,
    c.max_length as charMaxLength,
    COLUMNPROPERTY(c.object_id, c.name, 'IsIdentity') as isIdentity,
    ep.value as columnComment
from sys.columns c
inner join sys.types t on c.system_type_id = t.system_type_id and c.user_type_id = t.user_type_id
inner join sys.objects o on c.object_id = o.object_id
INNER JOIN sys.schemas u ON u.schema_id=o.schema_id
left join sys.extended_properties ep on ep.major_id = c.object_id
    and ep.minor_id = c.column_id
    and ep.name = 'MS_Description'
    and ep.class = 1
where o.type = 'V' and o.object_id =OBJECT_ID_CONDITION and u.name =SCHEMA_NAME_CONDITION
order by c.column_id`;

// Table sizes query
export const tableSizesQuery = `
SELECT
    t.object_id as objectId,
    SUM(p.rows) as tableRowCount
FROM sys.tables t
INNER JOIN sys.partitions p ON t.object_id = p.object_id
    AND p.index_id IN (0, 1)
INNER JOIN sys.schemas s ON t.schema_id = s.schema_id
where t.object_id =OBJECT_ID_CONDITION and s.name =SCHEMA_NAME_CONDITION
GROUP BY t.object_id`;

// Programmables (procedures + functions) query
export const programmablesQuery = `
select o.name as pureName, s.name as schemaName, o.object_id as objectId,
    o.type as sqlObjectType, o.create_date as createDate, o.modify_date as modifyDate
from sys.objects o
inner join sys.schemas s on o.schema_id = s.schema_id
where o.type in ('P','FN','IF','TF')
and o.object_id =OBJECT_ID_CONDITION and s.name =SCHEMA_NAME_CONDITION`;

// Procedure parameters query
export const proceduresParametersQuery = `
select p.name as parameterName, t.name as dataType,
    p.max_length as maxLength, p.precision, p.scale,
    p.is_output as isOutput,
    p.object_id as parentObjectId,
    p.parameter_id as parameterId
from sys.parameters p
inner join sys.types t on p.system_type_id = t.system_type_id and p.user_type_id = t.user_type_id
inner join sys.objects o on p.object_id = o.object_id
where o.type = 'P'
and o.object_id =OBJECT_ID_CONDITION`;

// Function parameters query
export const functionParametersQuery = `
select p.name as parameterName, t.name as dataType,
    p.max_length as maxLength, p.precision, p.scale,
    p.is_output as isOutput,
    p.object_id as parentObjectId,
    p.parameter_id as parameterId
from sys.parameters p
inner join sys.types t on p.system_type_id = t.system_type_id and p.user_type_id = t.user_type_id
inner join sys.objects o on p.object_id = o.object_id
where o.type in ('FN','IF','TF')
and o.object_id =OBJECT_ID_CONDITION`;

// Triggers query
export const triggersQuery = `
select t.name as triggerName, t.object_id, o.name as tableName,
    s.name as schemaName,
    te.type_desc as triggerTiming,
    t.is_instead_of_trigger,
    m.definition,
    (select STUFF((
        select ',' + e.type_desc
        from sys.trigger_events e
        where e.object_id = t.object_id
        for xml path('')
    ), 1, 1, '')) as eventType
from sys.triggers t
inner join sys.objects o on t.parent_id = o.object_id
inner join sys.schemas s on o.schema_id = s.schema_id
inner join sys.trigger_events te on t.object_id = te.object_id
inner join sys.sql_modules m on t.object_id = m.object_id
where o.object_id =OBJECT_ID_CONDITION and s.name =SCHEMA_NAME_CONDITION`;

// Tables list query
// Adapted from dbgate-plugin-mssql/src/backend/sql/tables.js (GPL-3.0)

export const tablesQuery = `
select
    o.name as pureName,
    s.name as schemaName,
    o.object_id as objectId,
    o.create_date as createDate,
    o.modify_date as modifyDate,
    ep.value as objectComment
from sys.tables o
inner join sys.schemas s on o.schema_id = s.schema_id
left join sys.extended_properties ep on ep.major_id = o.object_id
    and ep.minor_id = 0
    and ep.name = 'MS_Description'
    and ep.class = 1
where o.object_id =OBJECT_ID_CONDITION and s.name =SCHEMA_NAME_CONDITION`;

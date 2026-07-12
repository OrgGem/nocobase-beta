export const indexcolsQuery = `
select ic.object_id, ic.index_id, c.name as columnName,
    ic.is_descending_key as isDescending, ic.is_included_column as isIncludedColumn
from sys.index_columns ic
inner join sys.columns c on ic.object_id = c.object_id and ic.column_id = c.column_id
inner join sys.indexes i on ic.object_id = i.object_id and ic.index_id = i.index_id
inner join sys.objects o on i.object_id = o.object_id
INNER JOIN sys.schemas u ON u.schema_id=o.schema_id
where i.is_primary_key=0
and i.is_hypothetical=0 and indexproperty(i.object_id, i.name, 'IsStatistics') = 0
and objectproperty(i.object_id, 'IsUserTable') = 1
and i.object_id =OBJECT_ID_CONDITION and u.name =SCHEMA_NAME_CONDITION
order by ic.object_id, ic.index_id, ic.key_ordinal`;

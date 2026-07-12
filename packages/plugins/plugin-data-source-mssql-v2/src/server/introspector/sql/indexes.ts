export const indexesQuery = `
select i.object_id, i.name as constraintName, i.type_desc as indexType,
    i.is_unique as isUnique, i.index_id, i.is_unique_constraint,
    i.filter_definition AS filterDefinition
from sys.indexes i
inner join sys.objects o on i.object_id = o.object_id
INNER JOIN sys.schemas u ON u.schema_id=o.schema_id
where i.is_primary_key=0
and i.is_hypothetical=0 and indexproperty(i.object_id, i.name, 'IsStatistics') = 0
and objectproperty(i.object_id, 'IsUserTable') = 1
and i.index_id between 1 and 254
and i.object_id =OBJECT_ID_CONDITION and u.name =SCHEMA_NAME_CONDITION`;

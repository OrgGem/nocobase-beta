// Foreign keys query — uses sys.foreign_keys instead of slower INFORMATION_SCHEMA views
export const foreignKeysQuery = `
SELECT
    schemaName = SCHEMA_NAME(o.schema_id),
    pureName = o.name,
    columnName = pc.name,
    refSchemaName = SCHEMA_NAME(ro.schema_id),
    refTableName = ro.name,
    refColumnName = rpc.name,
    constraintName = fk.name,
    updateAction = fk.update_referential_action_desc,
    deleteAction = fk.delete_referential_action_desc,
    objectId = o.object_id
FROM sys.foreign_keys fk
INNER JOIN sys.foreign_key_columns fkc
    ON fk.object_id = fkc.constraint_object_id
INNER JOIN sys.objects o
    ON fk.parent_object_id = o.object_id
INNER JOIN sys.columns pc
    ON fkc.parent_object_id = pc.object_id
    AND fkc.parent_column_id = pc.column_id
INNER JOIN sys.objects ro
    ON fk.referenced_object_id = ro.object_id
INNER JOIN sys.columns rpc
    ON fkc.referenced_object_id = rpc.object_id
    AND fkc.referenced_column_id = rpc.column_id
INNER JOIN sys.schemas s
    ON o.schema_id = s.schema_id
where o.object_id =OBJECT_ID_CONDITION and s.name =SCHEMA_NAME_CONDITION
ORDER BY fkc.constraint_column_id`;

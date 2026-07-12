// Load SQL code for views, procedures, functions, triggers
// Adapted from dbgate-plugin-mssql (GPL-3.0)
export const loadSqlCodeQuery = `
select o.name as pureName, s.name as schemaName, m.definition as codeText
from sys.objects o
inner join sys.schemas s on o.schema_id = s.schema_id
inner join sys.sql_modules m on o.object_id = m.object_id
where o.type in ('V','P','FN','IF','TF','TR')
and o.object_id =OBJECT_ID_CONDITION and s.name =SCHEMA_NAME_CONDITION`;

// Modifications tracking (for incremental analysis)
export const modificationsQuery = `
select o.name as pureName, s.name as schemaName,
    o.object_id as objectId, o.type as type, o.modify_date as modifyDate
from sys.objects o
inner join sys.schemas s on o.schema_id = s.schema_id
where o.type in ('U','V','P','FN','IF','TF','TR')
and o.object_id =OBJECT_ID_CONDITION and s.name =SCHEMA_NAME_CONDITION
order by o.modify_date desc`;

// List databases
export const listDatabasesQuery = `
SELECT
    d.name as name,
    d.database_id,
    d.state_desc as status,
    d.recovery_model_desc as recoveryModel,
    d.compatibility_level as compatibilityLevel,
    d.is_read_only as isReadOnly,
    CAST(SUM(CAST(mf.size AS bigint) * 8 / 1024) AS bigint) as sizeOnDisk,
    CAST(SUM(CAST(mf.size AS bigint) * 8 / 1024)
        - SUM(CAST(FILEPROPERTY(mf.name, 'SpaceUsed') AS bigint) * 8 / 1024) AS bigint) as logSizeOnDisk
FROM sys.databases d
LEFT JOIN sys.master_files mf ON d.database_id = mf.database_id
WHERE d.database_id > 4
GROUP BY d.name, d.database_id, d.state_desc, d.recovery_model_desc,
    d.compatibility_level, d.is_read_only
ORDER BY d.name`;

// List processes — uses DMV views instead of deprecated sys.sysprocesses
export const listProcessesQuery = `
SELECT
    r.session_id as processId,
    r.blocking_session_id as blockedBy,
    r.status,
    s.login_name as login,
    s.host_name as host,
    s.program_name as program,
    r.command,
    r.cpu_time as cpuTime,
    r.reads + r.writes as physicalIo,
    r.granted_query_memory as memoryUsage,
    r.start_time as lastBatch,
    r.open_transaction_count as openTransactions,
    DB_NAME(r.database_id) as databaseName
FROM sys.dm_exec_requests r
RIGHT JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
WHERE s.session_id > 50
  AND s.is_user_process = 1
ORDER BY r.session_id`;

// List variables (server configuration)
export const listVariablesQuery = `
SELECT
    name as variable,
    CAST(value AS sql_variant) as value,
    description
FROM sys.configurations
ORDER BY name`;

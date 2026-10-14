---
"@aws-blocks/bb-distributed-data": patch
"@aws-blocks/bb-data": patch
"@aws-blocks/data-common": patch
"@aws-blocks/blocks": patch
---

Validate SQL with the latest `dsql-lint` 0.2 release

`DistributedDatabase` depends on `@aws/dsql-lint` `^0.2.20`, so local and
synth-time validation follows each 0.2 release. Migrations and queries that use
partial indexes, `ALTER TABLE ... ADD CONSTRAINT ... NOT VALID`, identity
columns, `ALTER DEFAULT PRIVILEGES`, and `SELECT ... FOR KEY SHARE` validate
cleanly. The local mock runs `ALTER TABLE ASYNC ... VALIDATE CONSTRAINT`, and the
SQL Building Block docs reflect Aurora DSQL's PostgreSQL compatibility, including
foreign keys.

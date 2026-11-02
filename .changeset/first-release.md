---
'@snyder-tech/payload-surrealdb': minor
---

First release: a SurrealDB 3.3 database adapter for Payload 4.0.0-beta.6. Covers CRUD, real transactions, unique and index handling, versions and drafts, globals, relationships, joins, `findDistinct`, geo queries, collation, the job queue and migrations. Payload's own database suites (queues, database, kv, versions, select, localization, relationships, joins, sort, fields) run against it in CI, with the remaining differences listed in `tests/conformance/expected-failures.json`.

# payload-surrealdb

Use [SurrealDB](https://surrealdb.com) as the database for [Payload CMS](https://payloadcms.com) 4.

It works like Payload's official adapters (`@payloadcms/db-mongodb`, `@payloadcms/db-postgres`): add it to your Payload config, point it at a SurrealDB server, and Payload creates and manages everything else.

> **Beta.** Payload 4 is itself in beta, so this adapter is pinned to one Payload version (see [Compatibility](#compatibility)). Expect changes between releases.

## What works

- Everything Payload asks of a database: create, find, count, update, upsert and delete, including bulk updates and deletes.
- Real transactions: if a save fails halfway, nothing is written.
- Unique fields: a duplicate value comes back as a normal Payload validation error on that field.
- Versions, drafts, autosave, globals, localization and field selection.
- Relationships, uploads, joins and sorting by a related document's field.
- The job queue, safe to run from several workers at once.
- Migrations (`payload migrate`, `migrate:create`, `migrate:down`, `migrate:fresh` and the rest).
- Point fields with `near`, `within` and `intersects` queries.

Payload's own database test suites run against this adapter on every change. The few tests that don't pass are listed with the reason in [`tests/conformance/expected-failures.json`](tests/conformance/expected-failures.json).

## Compatibility

| This adapter | Payload               | SurrealDB    | Node        |
| ------------ | --------------------- | ------------ | ----------- |
| 0.1.x (beta) | 4.0.0-beta.6, exactly | 3.3 or newer | 24 or newer |

Payload 4 changes its database interface between betas, so the adapter requires one exact Payload version, and your package manager warns you if they don't match. Each release says which Payload beta it was tested with.

## Install

```sh
pnpm add @snyder-tech/payload-surrealdb@beta
# or
npm install @snyder-tech/payload-surrealdb@beta
```

You also need a SurrealDB 3.3+ server. For local development, Docker is the quickest way. This keeps your data in a Docker volume called `surrealdb-data`:

```sh
docker run -d --name surrealdb --user root -p 127.0.0.1:8000:8000 \
  -v surrealdb-data:/data \
  surrealdb/surrealdb:v3.3.5 start --user root --pass root rocksdb:/data/db
```

Use a real password anywhere other than your own machine.

## Quick start

```ts
// payload.config.ts
import { surrealdbAdapter } from '@snyder-tech/payload-surrealdb'
import { buildConfig } from 'payload'

export default buildConfig({
  db: surrealdbAdapter({
    url: process.env.SURREAL_URL, // for example ws://127.0.0.1:8000/rpc
    namespace: 'my-app',
    database: 'cms',
    auth: {
      username: process.env.SURREAL_USER,
      password: process.env.SURREAL_PASSWORD,
    },
  }),
  // collections, globals, ...
})
```

On start, the adapter creates the namespace, the database, a table per collection and the indexes your fields ask for. There's no schema to write by hand.

## Options

| Option                            | Default           | What it does                                                                                                                                             |
| --------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                             | required          | The server's RPC address: `ws://` or `wss://` for full support, `http(s)://` for no transactions (see below). `false` starts Payload without connecting. |
| `namespace`, `database`           | required          | Where your data lives in SurrealDB.                                                                                                                      |
| `auth`                            | required          | `{ username, password }` (plus `namespace`/`database` for a scoped user).                                                                                |
| `pool.size`                       | `2`               | Number of WebSocket connections, from 2 to 4.                                                                                                            |
| `requestTimeout`                  | `30000`           | Milliseconds a query may take before it fails.                                                                                                           |
| `transactionOptions`              | on                | `{ timeoutMs, acquireTimeoutMs }` (both 30 s by default), or `false` to turn transactions off.                                                           |
| `ensureIndexes`                   | `true`            | Create indexes from your field config on start. Turn off if your migrations manage indexes.                                                              |
| `provisionDatabase`               | `true`            | Create the namespace and database on start. Turn off for a user that is only allowed into one database.                                                  |
| `collation`                       | off               | `true` sorts text alphabetically (`a, á, B, b`) rather than by byte value. `{ numericOrdering: true }` also sorts `Post 2` before `Post 10`.             |
| `migrationDir`                    | Payload's default | Folder for migration files.                                                                                                                              |
| `prodMigrations`                  | none              | Migrations to run on start when `NODE_ENV` is `production`.                                                                                              |
| `allowIDOnCreate`                 | `true`            | Let `create` accept an `id` in its data.                                                                                                                 |
| `allowAdditionalKeys`             | `false`           | Keep keys that aren't in your Payload schema.                                                                                                            |
| `disableFallbackSort`             | `false`           | Turn off the extra sort that keeps results in a stable order.                                                                                            |
| `bulkOperationsSingleTransaction` | `false`           | Run each document of a bulk operation in its own transaction.                                                                                            |

## How your data is stored

- Each collection is a table, named after its slug (or `dbName`). Versions live in `_<name>_versions`, globals in `_global_<slug>`.
- A document is stored as one record, exactly as Payload sees it: groups, arrays, blocks and translations are nested inside it.
- Relationships are SurrealDB record links, dates are real datetimes, and points are geometry, so you can query the data with SurrealQL too.
- New IDs are [ULIDs](https://github.com/ulid/spec): text IDs that sort in creation order.

## Transactions

With a `ws://` or `wss://` URL, every Payload write runs in a real transaction. If two requests change the same document at the same moment, one wins and the other gets a `409` error, and nothing is half-saved.

A transaction left open longer than `transactionOptions.timeoutMs` is cancelled automatically. If the connection drops, the server undoes any open transactions, and the adapter reconnects on its own.

With an `http://` or `https://` URL, SurrealDB can't hold a transaction open across requests, so Payload runs without them. Use a WebSocket URL wherever you can.

## Migrations

Migrations are TypeScript files with `up` and `down` functions. Each gets `{ payload, req, session }`, where `session` is the open SurrealDB transaction:

```ts
import type { MigrateDownArgs, MigrateUpArgs } from '@snyder-tech/payload-surrealdb'

export async function up({ session }: MigrateUpArgs): Promise<void> {
  await session?.query('UPDATE posts SET featured = false WHERE featured = NONE').collect()
}

export async function down({ session }: MigrateDownArgs): Promise<void> {
  await session?.query('UPDATE posts UNSET featured').collect()
}
```

`payload migrate:fresh` deletes every table in the database before running all migrations, and asks before doing it.

## Known limitations

- **Date filters and date sorts don't use an index yet.** SurrealDB 3.3 has a bug that makes indexed date queries skip rows ([surrealdb/surrealdb#7654](https://github.com/surrealdb/surrealdb/issues/7654)). The adapter works around it, so results are always correct, but those queries read the whole table. That's fine for thousands of documents; it gets slower at hundreds of thousands.
- **Point queries have no spatial index**, because SurrealDB 3.3 has none, so `near`, `within` and `intersects` also read the whole table.
- **Cloudflare Workers** work only with an `http(s)://` URL, so without transactions.
- **Differences from Payload's SQL adapters**, which match the MongoDB adapter:
  - A relationship to a document that doesn't exist is saved as given rather than rejected.
  - A language with no value reads as `null` instead of falling back to the default language.
  - IDs are text, so GraphQL treats `id` as a String.
  - Drizzle-only features (`afterSchemaInit`, `payload.db.tables`, `payload.db.execute`) don't exist here.

## Contributing

Bug reports, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). The reasons behind the adapter's design are in [docs/decisions.mdx](docs/decisions.mdx).

## License

[MIT](LICENSE). Parts of the code are ported from Payload's MIT-licensed MongoDB adapter; see [NOTICE](NOTICE).

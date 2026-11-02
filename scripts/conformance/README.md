# Conformance runner

Runs Payload's own `int` test suites against this adapter, and judges the result against `tests/conformance/`.

```sh
node scripts/conformance/run.mjs <group>...     # or: all
node scripts/conformance/evaluate.mjs <results.json> <payload-checkout-dir>
```

Needs git, Docker, pnpm and Node 24.22.1 (Payload's `better-sqlite3` does not build on Node 26).

## What a run does

1. Shallow-clones `payloadcms/payload` at `v<peerDependencies.payload>` into `.conformance/payload-<tag>` (gitignored). An existing checkout is reset and cleaned.
2. Copies `src/` into the checkout as the workspace package `packages/payload-surrealdb`, with its `payload` dependencies rewritten to the checkout's own (`workspace:*`).
3. Adds a `surrealdb` entry to the checkout's `test/dbAdapters.ts`. It throws if the anchor line is not there exactly once, so a Payload change cannot silently run the suites on another adapter.
4. Applies every `patches/*.patch` with `git apply`. `versions-helpers.patch` makes the versions suite clear a global through the public API on any adapter that is not Drizzle, where it checked for Mongoose only.
5. Runs `pnpm install`, starts `surrealdb/surrealdb:v<version>` with `docker run` on a free local port and waits until it is ready.
6. For each group, runs `pnpm test:int <suites> --retry=0` with the JSON reporter and `-t` excluding the skip list, then evaluates the report. The container is always removed at the end.

## Groups

`groups.json` maps a group to the suite paths. They are split to run in parallel in CI.

| Group                             | Suites                                                            |
| --------------------------------- | ----------------------------------------------------------------- |
| `queues`                          | `test/queues/`                                                    |
| `database-kv`                     | `test/database/`, `test/kv/`                                      |
| `versions-select-localization`    | `test/versions/`, `test/select/`, `test/localization/`            |
| `relationships-joins-sort-fields` | `test/relationships/`, `test/joins/`, `test/sort/`, `test/fields` |

`test/fields` has no trailing slash on purpose: Vitest filters by substring, so it also runs `test/fields-relationship`. The other entries keep the slash to stay exact.

## Environment

| Variable            | Default                   | Meaning                                                         |
| ------------------- | ------------------------- | --------------------------------------------------------------- |
| `SURREALDB_VERSION` | `3.3.2`                   | Image tag is `v<version>`                                       |
| `SURREALDB_PORT`    | a free port               | Host port for the container                                     |
| `PAYLOAD_TAG`       | `v<peer payload version>` | Payload tag to clone, for trying a newer beta                   |
| `CONFORMANCE_DIR`   | `<repo>/.conformance`     | Work directory (checkout and reports in `results/<group>.json`) |

## The verdict

`evaluate.mjs` exits 1 on:

- a failed test that is not in `tests/conformance/expected-failures.json`,
- an expected failure that now passes, or no longer exists (the list only shrinks),
- a skip-listed test (`tests/conformance/skip-list.json`) that ran,
- a test file that crashed before running a test, or a report without a passing test.

An expected failure counts only when its file is in the report, so each group judges its own suites.

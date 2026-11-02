# Contributing

## Setup

You need Node 24, pnpm and Docker. Start a local SurrealDB for the tests (port 8123, user `root`, password `root`):

```sh
docker run -d --name surrealdb-test -p 127.0.0.1:8123:8000 \
  surrealdb/surrealdb:v3.3.2 start --user root --pass root memory
```

The tests read the URL from `SURREAL_TEST_URL` and default to `ws://127.0.0.1:8123/rpc`.

```sh
pnpm install
pnpm verify   # format check, lint, typecheck, tests, build; the same as CI
```

`pnpm verify` must pass before a pull request.

## Changes

A change to `src/` needs a test in `tests/` that fails without it. Add a changeset with `pnpm changeset` for any change users can see.

## Conformance suites

The adapter is also run against Payload's own database suites: `node scripts/conformance/run.mjs <group>`. Groups and details are in [`scripts/conformance/README.md`](scripts/conformance/README.md). `tests/conformance/expected-failures.json` may only shrink, and each entry needs a reason.

## Bugs and ideas

Open a GitHub issue with your SurrealDB version, Payload version and a minimal repro.

## Releasing

Maintainers release. Run `pnpm changeset version`, review and merge the result, then run the Release workflow from `develop`. It runs `pnpm verify` and publishes to npm.

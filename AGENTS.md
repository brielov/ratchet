# AGENTS.md

Guidance for agents working in this repository.

## Project

`ratchet` is a small Bun-only SQL migrator for `Bun.SQL`.

The design goal is deliberately narrow:

- forward-only `.sql` migrations
- one library entrypoint: `migrate(sql, directory, options?)`
- one CLI with conventional commands: `init`, `create`, `up`, `status`
- no runtime support outside Bun
- no database-specific drivers or dialect branches unless Bun's own SQL abstraction forces it
- no hidden metadata setup baked into the migrator

Before changing SQL behavior, read Bun's current SQL docs in `node_modules/bun-types/docs/runtime/sql.mdx` or <https://bun.com/docs/runtime/sql>. Do not guess how `Bun.SQL` behaves.

## Runtime And APIs

Default to Bun APIs.

- Use `bun` commands, not Node/npm/yarn/pnpm equivalents.
- Use `Bun.env`, not `process.env`, for project code.
- Use `Bun.argv` for CLI argv input.
- Use `Bun.file`, `Bun.write`, `Glob`, and `Bun.CryptoHasher` where they fit.
- Use `Bun.SQL` / `SQL` from `"bun"`; do not add `pg`, `mysql2`, `better-sqlite3`, `postgres`, or migration-framework dependencies.
- Tests should use `bun:test`.

Node built-ins are acceptable for small filesystem/path utilities when Bun has no clearer API already used here, for example `node:path`, `node:fs/promises`, and `node:util`.

## Current Layout

- `src/index.ts`: public library export.
- `src/migrator.ts`: migration logic, status logic, init/create helpers.
- `src/cli.ts`: executable CLI and argument parsing.
- `src/migrator.test.ts`: Bun tests, mostly SQLite `:memory:` integration coverage.

Keep the library surface intentionally small. Export `migrate` from `src/index.ts`; avoid exposing helper APIs unless there is a concrete user need.

## Migration Semantics

Preserve these behavioral rules unless the user explicitly changes the product direction:

- Migration files are top-level `*.sql` files sorted lexicographically.
- `init` creates the migration directory and writes `0000_ratchet.sql`.
- The metadata table is created by that visible first migration file, not by hidden runtime DDL.
- The default metadata table is `ratchet_migrations`, but it is configurable.
- Table names must remain simple unquoted SQL identifiers.
- Applied migrations are tracked by `name`, `checksum`, and `applied_at`.
- Checksums are SHA-256 over the full file contents.
- Already-applied files with changed checksums must fail.
- Blank SQL files are valid no-op migrations and should still be recorded.
- `migrate` should apply pending files in a transaction via `sql.begin`.
- Use `tx.file(path)` for non-empty SQL files so Bun handles SQL file execution.

The first run may execute `0000_ratchet.sql` before the metadata table exists. This is the bootstrap path and is intentional.

## CLI Conventions

Supported commands:

```sh
ratchet init
ratchet create add_users
ratchet up
ratchet status
ratchet drop
```

`drop` is a development-only convenience that wipes the connected database so
migrations can be replayed from scratch. The implementation branches on
`sql.options.adapter`:

- PostgreSQL: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` plus
  best-effort default grants.
- MySQL / MariaDB: enumerates `information_schema.tables` for the current
  database and drops every table and view with `FOREIGN_KEY_CHECKS=0`.
- SQLite: closes the connection and unlinks the database file along with any
  `-journal`, `-wal`, and `-shm` sidecars. `:memory:` is a no-op.

`drop` is disabled when `NODE_ENV=production` and requires the user to type
`drop` to confirm unless `--yes` is passed. Do not add a second name (e.g.
`reset`, `clear`) for the same behavior.

Defaults:

- directory: `migrations`
- table: `ratchet_migrations`
- connection: `new SQL()` so Bun can auto-detect its supported environment variables

Overrides:

- flags: `--dir`, `--table`, `--url`
- env: `RATCHET_DIR`, `RATCHET_TABLE`, `RATCHET_DATABASE_URL`

Flag values should override env values, and env values should override defaults.

## Quality Bar

Keep changes small and boring.

- Do not add dependencies for trivial helpers.
- Do not introduce framework-style abstractions.
- Do not add rollback/down support unless explicitly requested.
- Do not add database-specific SQL syntax to generated migrations unless it is known to work through Bun.SQL for PostgreSQL, MySQL, and SQLite.
- Keep generated SQL and CLI output plain.
- Keep files ASCII unless there is a clear reason otherwise.

## Verification

Run these before handing work back when code changes:

```sh
bun test
bun x tsc --noEmit
bun x oxlint .
```

For CLI behavior changes, also run a temporary SQLite smoke test:

```sh
tmp=$(mktemp -d)
bun src/cli.ts init --dir "$tmp/migrations"
bun src/cli.ts create empty --dir "$tmp/migrations"
bun src/cli.ts up --dir "$tmp/migrations" --url "sqlite://$tmp/app.db"
bun src/cli.ts status --dir "$tmp/migrations" --url "sqlite://$tmp/app.db"
rm -rf "$tmp"
```

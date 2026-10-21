# AGENTS.md

Guidance for agents working in this repository.

## Project

`ratchet` is a small, strict, forward-only SQL migrator for `Bun.SQL`.

The design goal is deliberately narrow:

- forward-only `.sql` migrations, no rollback/down support
- library entrypoints: `migrate(sql, directory?, options?)` and `getMigrationStatus(sql, directory?, options?)`
- one CLI with three commands: `create`, `up`, `status`
- `Bun.SQL` only: no `bun:sqlite` `Database`, no other drivers, no runtime support outside Bun
- dialect branches only where `Bun.SQL` or the database forces them (locking, table existence, SQLite statement splitting)

Before changing SQL behavior, read Bun's SQL typings in `node_modules/bun-types/sql.d.ts` or <https://bun.com/docs/runtime/sql>, and probe the real behavior on every engine. Do not guess how `Bun.SQL` behaves; several behaviors below were found by probing, not documented.

## Runtime And APIs

- Use `bun` commands, not Node/npm/yarn/pnpm equivalents.
- Use `Bun.env`, `Bun.argv`, `Bun.file`, `Bun.write`, `Glob`, and `Bun.CryptoHasher` where they fit.
- Do not add `pg`, `mysql2`, `better-sqlite3`, `postgres`, or migration-framework dependencies.
- Node built-ins are fine for small filesystem/path utilities (`node:path`, `node:fs/promises`, `node:util`).

## Layout

- `src/index.ts`: public library exports. Keep the surface small.
- `src/migrator.ts`: file loading, planning, locking, applying, status, `create`.
- `src/statements.ts`: SQLite statement splitter (port of `sqlite3_complete`) and the blank/comment-only check.
- `src/cli.ts`: executable CLI and argument parsing.
- `src/*.test.ts`: `bun:test` suites. `migrator.test.ts` runs every integration test against each configured database.

## Migration Semantics

Preserve these rules unless the user explicitly changes the product direction:

- Files are top-level `<version>_<name>.sql`; any other `*.sql` file is an error. Sort is by numeric version; duplicate versions are an error.
- `migrate` creates the metadata table itself with `CREATE TABLE IF NOT EXISTS` (columns `name`, `checksum`, `applied_at`), after taking the lock. `getMigrationStatus` never creates it.
- Table names are simple lowercase unquoted identifiers.
- Checksums are SHA-256 over the file with a leading BOM stripped and CRLF normalized to LF. The raw-bytes checksum (what 0.3 recorded) is also accepted.
- Before running anything, refuse on changed, missing, or out-of-order files.
- Each pending file runs in its own transaction together with its metadata insert. Inside that transaction the file is re-checked against the metadata table and skipped if another migrator recorded it.
- Failures in a file are wrapped in `MigrationError` (migration name, files applied before it, `cause`). `RatchetError`s and errors outside file execution are not wrapped.
- Locking: PostgreSQL `pg_advisory_lock` and MySQL/MariaDB `GET_LOCK` on a reserved connection; SQLite `BEGIN IMMEDIATE` per file plus a `busy_timeout` for the run when none is set.
- SQLite files are split into statements and run one at a time. Bun's SQLite adapter (verified on 1.4.3) silently ignores runtime errors from any statement after the first in a multi-statement string. PostgreSQL and MySQL run the whole file as one simple query.
- Minimum Bun is 1.4.0: on 1.3.x a migration that fails inside `begin` on a reserved connection also surfaces the database error as an unhandled rejection. To check another Bun version, install it with `bun add bun@<version>` in a scratch directory and run that binary's `bun test` with the database env vars set.
- MariaDB rejects `GET_LOCK(name, -1)` (returns NULL), so the lock uses a long finite timeout.

## CLI Conventions

```sh
ratchet create <name>
ratchet up
ratchet status
```

- Defaults: directory `migrations`, table `ratchet_migrations`, connection `new SQL()`.
- Overrides: flags `--dir`, `--table`, `--url`; env `RATCHET_DIR`, `RATCHET_TABLE`, `RATCHET_DATABASE_URL`. Flags beat env, env beats defaults, empty values count as unset.
- `status` exits with 1 only for changed, missing, or out-of-order files.
- `init` and `drop` were removed in 0.4 and print a short explanation. Do not bring them back.

## Quality Bar

Keep changes small and boring.

- Do not add dependencies for trivial helpers.
- Do not introduce framework-style abstractions.
- Keep CLI output plain and files ASCII unless there is a clear reason otherwise.
- Every safety mechanism should have a test that fails when it is removed.

## Verification

Run these before handing work back when code changes:

```sh
bun test
bun x tsc --noEmit
bun x oxlint .
bun x oxfmt --check src
```

`bun test` alone covers SQLite. For changes to SQL behavior, also run the suite against real servers:

```sh
docker run -d --rm --name ratchet-pg -e POSTGRES_PASSWORD=ratchet -e POSTGRES_DB=ratchet -p 127.0.0.1:54329:5432 postgres:17-alpine
docker run -d --rm --name ratchet-mysql -e MYSQL_ROOT_PASSWORD=ratchet -e MYSQL_DATABASE=ratchet -p 127.0.0.1:53306:3306 mysql:8.4
docker run -d --rm --name ratchet-mariadb -e MARIADB_ROOT_PASSWORD=ratchet -e MARIADB_DATABASE=ratchet -p 127.0.0.1:53307:3306 mariadb:11

RATCHET_TEST_POSTGRES_URL=postgres://postgres:ratchet@127.0.0.1:54329/ratchet \
RATCHET_TEST_MYSQL_URL="mysql://root:ratchet@127.0.0.1:53306/ratchet?sslmode=require" \
RATCHET_TEST_MARIADB_URL=mysql://root:ratchet@127.0.0.1:53307/ratchet \
bun test
```

These databases are wiped before every test; never point them at real data. MySQL 8.4 needs `sslmode=require` (or public key retrieval) for its default auth plugin.

Do not use `expect(query).rejects` on a `Bun.SQL` query in tests: queries are lazy and `expect` never runs it, so the test hangs. Await the query and inspect the outcome instead.

## Release Flow

This package is installed directly from GitHub tags, so version metadata and
the README install command must move together with every release tag.

When preparing a release after code changes:

1. Choose the next SemVer version and use a `v`-prefixed Git tag name, for
   example `0.2.1` in `package.json` and `v0.2.1` in Git.
2. Update `package.json` `"version"` to the new version.
3. Update the README install example so `bun add github:brielov/ratchet#vX.Y.Z`
   points to the same tag you are about to create.
4. Run the verification commands above. Include the SQLite CLI smoke test when
   CLI behavior changed.
5. Commit the code, docs, `package.json`, README tag update, and any required
   lockfile changes together.
6. Create the annotated release tag on that commit, for example:

   ```sh
   git tag -a v0.2.1 -m "v0.2.1"
   ```

7. Push the commit and the tag:

   ```sh
   git push origin main
   git push origin v0.2.1
   ```

Do not create or push a release tag until `package.json` and the README install
example both reference that exact version.

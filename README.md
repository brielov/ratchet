# ratchet

A small Bun-only SQL migrator built on `Bun.SQL`. Forward-only, file-based,
and works with every database engine `Bun.SQL` supports
(PostgreSQL, MySQL, SQLite).

## Install

ratchet is not published to npm. Install it directly from GitHub and pin to
a tag:

```sh
bun add github:brielov/ratchet#v0.2.1
```

You can also track `main`, but pinning to a tag is recommended:

```sh
bun add github:brielov/ratchet
```

> Requires Bun. There is no Node fallback by design.

## Library

```ts
import { SQL } from "bun";
import { migrate } from "ratchet";

const sql = new SQL();
try {
  const result = await migrate(sql, "migrations");
  console.log(`applied ${result.applied.length} migration(s)`);
} finally {
  await sql.close();
}
```

`migrate(sql, directory, options?)` reads every top-level `*.sql` file in
`directory`, sorts them lexicographically, and applies the pending ones inside
a single `sql.begin` transaction. It does **not** close the connection —
that is your responsibility.

### Options

| Option   | Default                | Description                          |
| -------- | ---------------------- | ------------------------------------ |
| `table`  | `ratchet_migrations` | Name of the metadata table to track. |

### Behavior

- **Forward-only.** No down/rollback support, by design.
- **Lexicographic order.** The file with the smallest name runs first.
- **Drift detection.** Each file's contents are SHA-256 hashed; editing an
  applied file is rejected.
- **Out-of-order detection.** A pending file that sorts before any applied
  file is rejected so you can rename it instead of silently skipping it.
- **No-op migrations.** Blank `.sql` files are valid and are still recorded.
- **No hidden DDL.** The metadata table is created by a real, visible first
  migration (`0000_ratchet.sql`) that you can read and edit like any other.

### Errors

Ratchet's validation and setup errors are `RatchetError`. Database read and
execution errors from `Bun.SQL` are allowed to bubble with their original error
type so callers can inspect adapter-specific details:

```ts
import { SQL } from "bun";
import { RatchetError, migrate } from "ratchet";

try {
  await migrate(sql, "migrations");
} catch (error) {
  if (error instanceof RatchetError) {
    console.error(error.message);
    return;
  }
  if (error instanceof SQL.SQLError) {
    console.error("database error:", error.message);
    return;
  }
  throw error;
}
```

### Programmatic status

```ts
import { getMigrationStatus } from "ratchet";

const status = await getMigrationStatus(sql, "migrations");
if (status.pending.length > 0) {
  console.log(`pending: ${status.pending.map((f) => f.name).join(", ")}`);
}
```

## CLI

```sh
ratchet init                 # writes migrations/0000_ratchet.sql
ratchet create add_users     # writes migrations/0001_add_users.sql
ratchet up                   # applies pending migrations
ratchet status               # prints applied / pending / changed / missing
ratchet drop                 # wipes the database so you can re-run migrations
```

`ratchet create` accepts a free-form name and slugifies it. If you don't
pass a name, a memorable random one is generated.

### Configuration

| Flag      | Env                      | Default                         |
| --------- | ------------------------ | ------------------------------- |
| `--dir`   | `RATCHET_DIR`          | `migrations`                    |
| `--table` | `RATCHET_TABLE`        | `ratchet_migrations`          |
| `--url`   | `RATCHET_DATABASE_URL` | Bun's auto-detected env vars    |

Flags override env vars. If no URL is set, ratchet calls `new SQL()` and
lets Bun auto-detect from `DATABASE_URL`, `POSTGRES_URL`, `MYSQL_URL`, etc.

> [!IMPORTANT]
> Use the same `--table` for `init` and `up`. The metadata table is created by
> `0000_ratchet.sql`; if `--table` doesn't match what that file creates,
> ratchet refuses to apply migrations and tells you which value to use.

### `drop`

`ratchet drop` is a development convenience that wipes the connected database
so you can re-run every migration against a clean slate without recreating
the database container or hand-running `DROP DATABASE`.

What it actually does depends on the engine:

- **PostgreSQL.** `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` and
  best-effort restore of default grants. Anything outside `public` is
  untouched.
- **MySQL / MariaDB.** Drops every table and view in the database currently
  selected by the connection, with `FOREIGN_KEY_CHECKS` disabled for the
  duration. The database itself is preserved.
- **SQLite.** Closes the connection and deletes the database file along with
  any `-journal`, `-wal`, and `-shm` sidecars. `:memory:` is a no-op (closing
  the connection already discards it).

It requires you to type `drop` to confirm, or pass `--yes` to skip the
prompt. It is disabled when `NODE_ENV=production`.

After `drop`, run `ratchet up` to replay every migration from scratch.

## Caveats

- **Single-process migrator.** ratchet does not take an advisory lock, so
  do not run `ratchet up` from multiple processes simultaneously against
  the same database.
- **Connection ownership.** `migrate(sql, ...)` does not close `sql`.
- **Single-transaction apply.** All pending migrations run inside one
  `sql.begin`. DDL that cannot run inside a transaction (for example
  `CREATE INDEX CONCURRENTLY` on PostgreSQL) is not supported.

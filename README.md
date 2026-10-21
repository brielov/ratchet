# ratchet

A small, strict, forward-only SQL migrator for `Bun.SQL`. Plain `.sql` files,
applied in order, one transaction each, never twice. Works with every engine
`Bun.SQL` supports: PostgreSQL, MySQL, MariaDB, and SQLite.

## Install

ratchet is not published to npm. Install it directly from GitHub and pin to
a tag:

```sh
bun add github:brielov/ratchet#v0.4.0
```

> Requires Bun 1.4.0 or newer. There is no Node fallback by design. Bun 1.3.x
> reports a failed migration's database error a second time as an unhandled
> rejection, which can crash your process.

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

`migrate(sql, directory?, options?)` creates the metadata table if needed,
then applies every pending migration in `directory` (default `migrations`).
It resolves to `{ applied, alreadyApplied }`, two lists of file names. It does
**not** close the connection.

| Option  | Default              | Description                        |
| ------- | -------------------- | ---------------------------------- |
| `table` | `ratchet_migrations` | Name of the metadata table to use. |

It is safe to call `migrate` on every app start, from every instance at
once: concurrent migrators wait for each other and each file runs exactly
once.

### Status

```ts
import { getMigrationStatus } from "ratchet";

const status = await getMigrationStatus(sql, "migrations");
```

| Field        | Type                                    | Meaning                                        |
| ------------ | --------------------------------------- | ---------------------------------------------- |
| `files`      | `{ name, path, checksum }[]`            | Every migration file, in run order.            |
| `records`    | `{ name, checksum, appliedAt: Date }[]` | Every row in the metadata table.               |
| `pending`    | `{ name, path, checksum }[]`            | Files not applied yet.                         |
| `changed`    | `{ name, expected, actual }[]`          | Applied files whose contents changed.          |
| `missing`    | `{ name, checksum, appliedAt: Date }[]` | Applied records whose file is gone.            |
| `outOfOrder` | `{ name, path, checksum }[]`            | Pending files that sort before an applied one. |

`getMigrationStatus` is read-only. It never creates the metadata table; a
database that has never been migrated reports every file as pending.

### Errors

Every error ratchet raises itself is a `RatchetError`. When a migration file
fails to execute, you get a `MigrationError` (a subclass) that tells you which
file failed and which files were committed before it. The database error is
kept as `cause`:

```ts
import { SQL } from "bun";
import { MigrationError, RatchetError, migrate } from "ratchet";

try {
  await migrate(sql, "migrations");
} catch (error) {
  if (error instanceof MigrationError) {
    console.error(`${error.migration} failed; applied before it: ${error.applied.join(", ")}`);
    console.error(error.cause); // the original SQL.SQLError
  } else if (error instanceof RatchetError) {
    console.error(error.message); // validation problem, nothing was run
  }
  throw error;
}
```

Connection errors and the like are not wrapped and bubble up unchanged.

## Migration files

- Files live directly in the migrations directory and are named
  `<version>_<name>.sql`, e.g. `0001_add_users.sql`. Any other `.sql` file
  there is an error. Other file types and subdirectories are ignored.
- Files run in numeric version order (`9_x.sql` before `10_y.sql`). Two files
  with the same version (`0003_a.sql` and `0003_b.sql`, a classic merge
  result) are an error.
- A file may contain any number of statements. Blank and comment-only files
  are valid no-ops and are still recorded.
- Do not put `BEGIN`/`COMMIT` in a file; ratchet wraps each file in its own
  transaction.

## Guarantees

Before running anything, ratchet checks the whole directory against the
database and refuses to proceed if:

- an applied file was **changed** (SHA-256 checksum mismatch; line endings and
  a UTF-8 BOM are normalized first, so a git `autocrlf` checkout is not a
  change),
- an applied file is **missing**,
- a pending file sorts **before** an already-applied one.

Then each pending file runs in its own transaction together with the insert
that records it. If a file fails, that transaction rolls back, nothing after
it runs, and every earlier file stays committed. Fix the file and run again.

Concurrent migrators are serialized:

- **PostgreSQL**: session-level `pg_advisory_lock` on a reserved connection.
  The server drops the lock if the process dies.
- **MySQL / MariaDB**: `GET_LOCK` on a reserved connection, with the same
  cleanup on disconnect.
- **SQLite**: each file runs in a `BEGIN IMMEDIATE` transaction, which re-checks
  the metadata table, and ratchet sets `busy_timeout` for the run (if you have
  not set one) so other processes wait instead of failing.

### Engine notes

- **MySQL / MariaDB commit DDL implicitly.** If a file with several DDL
  statements fails halfway, the statements before the failure stay applied and
  the file is not recorded. Prefer one DDL statement per migration there.
  The `MigrationError` message points this out.
- **PostgreSQL**: statements that cannot run in a transaction, like
  `CREATE INDEX CONCURRENTLY`, are not supported. Behind a transaction-pooling
  proxy such as PgBouncer, point ratchet at a direct connection, because
  session advisory locks need a real session.
- **SQLite**: ratchet splits files into statements with SQLite's own rules
  (including `CREATE TRIGGER ... BEGIN ... END;`) and runs them one at a time.
  It has to, because Bun's SQLite adapter silently ignores errors from any
  statement after the first in a multi-statement string.

## CLI

```sh
ratchet create add_users     # writes migrations/0001_add_users.sql
ratchet up                   # applies pending migrations
ratchet status               # prints applied / pending / changed / missing / out of order
```

`ratchet status` exits with 1 when `up` would refuse to run (changed, missing,
or out-of-order files). Pending files alone are not a failure.

### Configuration

| Flag          | Env                    | Default                      |
| ------------- | ---------------------- | ---------------------------- |
| `-d, --dir`   | `RATCHET_DIR`          | `migrations`                 |
| `-t, --table` | `RATCHET_TABLE`        | `ratchet_migrations`         |
| `-u, --url`   | `RATCHET_DATABASE_URL` | Bun's auto-detected env vars |

Flags override env vars. Empty env vars count as unset. If no URL is set,
ratchet calls `new SQL()` and lets Bun pick up `DATABASE_URL`, `POSTGRES_URL`,
`MYSQL_URL`, and so on.

## Upgrading from 0.3

- Existing databases keep working as they are. Records and checksums written
  by 0.3 are accepted, and an existing `0000_ratchet.sql` stays as a harmless
  applied migration. Keep it.
- New projects no longer need a bootstrap file. `ratchet init` is gone; run
  `ratchet create <name>`.
- `ratchet drop` is gone. Reset development databases with your database's
  own tooling.
- `bun:sqlite` `Database` connections, `--sqlite-extension` and
  `--sqlite-library` are gone. Pass a `Bun.SQL` instance.
- `ratchet create` requires a name.
- Files must be named `<version>_<name>.sql`, and duplicate versions are
  rejected.
- `migrate` resolves to `{ applied, alreadyApplied }`. `skipped` was renamed
  and `directory` / `table` are no longer echoed back.
- `getMigrationStatus` returns `{ files, records, pending, changed, missing,
outOfOrder }`. `applied` was renamed to `records`, `tableOk`, `tableError`,
  `directory` and `table` are gone, and each record's `applied_at` is now
  `appliedAt`, always a `Date`.

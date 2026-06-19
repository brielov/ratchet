# ratchet

A small Bun-only SQL migrator built on `Bun.SQL`. Forward-only, file-based,
and works with every database engine `Bun.SQL` supports
(PostgreSQL, MySQL, SQLite).

## Install

```sh
bun add ratchet
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

Every error ratchet throws is a `RatchetError`:

```ts
import { RatchetError, migrate } from "ratchet";

try {
  await migrate(sql, "migrations");
} catch (error) {
  if (error instanceof RatchetError) {
    console.error(error.message);
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
ratchet clear                # clears the metadata table only
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

### `clear`

`ratchet clear` deletes every row from the metadata table. It does **not**
drop application schema or data. Use it only on disposable development
databases.

It requires you to type the table name and `clear` to confirm, or pass
`--yes` to skip the prompt. It is disabled when `NODE_ENV=production`.

Re-running `ratchet up` after `clear` will replay every migration against
the existing schema. For a true reset, drop the database and recreate it
before running `up`.

## Caveats

- **Single-process migrator.** ratchet does not take an advisory lock, so
  do not run `ratchet up` from multiple processes simultaneously against
  the same database.
- **Connection ownership.** `migrate(sql, ...)` does not close `sql`.
- **Single-transaction apply.** All pending migrations run inside one
  `sql.begin`. DDL that cannot run inside a transaction (for example
  `CREATE INDEX CONCURRENTLY` on PostgreSQL) is not supported.

import { Glob, type SQL } from "bun";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { containsSql, splitSqliteStatements } from "./statements.ts";

export const DEFAULT_DIRECTORY = "migrations";
export const DEFAULT_TABLE = "ratchet_migrations";

const TABLE_PATTERN = /^[a-z_][a-z0-9_]*$/;
const FILE_PATTERN = /^(\d+)_.+\.sql$/;
const SQLITE_BUSY_TIMEOUT_MS = 30_000;
// GET_LOCK has no portable "wait forever": MySQL accepts -1, MariaDB returns NULL.
const MYSQL_LOCK_TIMEOUT_SECONDS = 365 * 24 * 60 * 60;

export type MigrateOptions = {
  table?: string;
};

export type MigrationFile = {
  name: string;
  path: string;
  checksum: string;
};

export type MigrationRecord = {
  name: string;
  checksum: string;
  appliedAt: Date;
};

export type ChangedMigration = {
  name: string;
  expected: string;
  actual: string;
};

export type MigrateResult = {
  applied: string[];
  alreadyApplied: string[];
};

export type MigrationStatus = {
  files: MigrationFile[];
  records: MigrationRecord[];
  pending: MigrationFile[];
  changed: ChangedMigration[];
  missing: MigrationRecord[];
  outOfOrder: MigrationFile[];
};

export type CreateMigrationResult = {
  directory: string;
  path: string;
  name: string;
};

type Dialect = "postgres" | "mysql" | "sqlite";

type Migration = MigrationFile & {
  version: bigint;
  sql: string;
  // Checksum of the bytes on disk, before line-ending normalization. Accepted
  // so records written by ratchet <= 0.3 keep matching.
  rawChecksum: string;
};

type Plan = {
  done: Migration[];
  pending: Migration[];
  changed: ChangedMigration[];
  missing: MigrationRecord[];
  outOfOrder: Migration[];
};

export class RatchetError extends Error {
  override name = "RatchetError";
}

/**
 * Thrown when a migration file fails to execute. That file's transaction was
 * rolled back; the files listed in `applied` were committed before it. The
 * original database error is available as `cause`.
 */
export class MigrationError extends RatchetError {
  override name = "MigrationError";
  readonly migration: string;
  readonly applied: string[];

  constructor(migration: string, applied: string[], message: string, cause: unknown) {
    super(message, { cause });
    this.migration = migration;
    this.applied = applied;
  }
}

/**
 * Applies every pending migration in `directory`, in version order, one
 * transaction per file. Concurrent callers against the same database are
 * serialized with a database lock. Does not close `sql`.
 */
export async function migrate(
  sql: SQL,
  directory = DEFAULT_DIRECTORY,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const table = normalizeTable(options.table);
  const dialect = dialectOf(sql);
  const migrations = await readMigrations(directory);

  return withMigrationLock(sql, dialect, table, async (conn) => {
    await conn`
      CREATE TABLE IF NOT EXISTS ${conn(table)} (
        name VARCHAR(255) PRIMARY KEY,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `;

    const plan = planMigrations(migrations, await readRecords(conn, table));
    assertPlanIsClean(plan, directory);

    const applied: string[] = [];
    const alreadyApplied = plan.done.map((migration) => migration.name);

    for (const migration of plan.pending) {
      let ran: boolean;
      try {
        ran = await applyMigration(conn, dialect, table, migration);
      } catch (error) {
        throw error instanceof RatchetError
          ? error
          : migrationError(migration, applied, dialect, error);
      }
      (ran ? applied : alreadyApplied).push(migration.name);
    }

    return { applied, alreadyApplied };
  });
}

/**
 * Compares the migration directory with the database without changing
 * either. A missing metadata table is reported as nothing applied.
 */
export async function getMigrationStatus(
  sql: SQL,
  directory = DEFAULT_DIRECTORY,
  options: MigrateOptions = {},
): Promise<MigrationStatus> {
  const table = normalizeTable(options.table);
  const dialect = dialectOf(sql);
  const migrations = await readMigrations(directory);
  const records = (await tableExists(sql, dialect, table)) ? await readRecords(sql, table) : [];
  const plan = planMigrations(migrations, records);

  return {
    files: migrations.map(toMigrationFile),
    records,
    pending: plan.pending.map(toMigrationFile),
    changed: plan.changed,
    missing: plan.missing,
    outOfOrder: plan.outOfOrder.map(toMigrationFile),
  };
}

/** Writes an empty `NNNN_<name>.sql` file numbered after the highest existing version. */
export async function createMigrationFile(
  directory = DEFAULT_DIRECTORY,
  title: string,
): Promise<CreateMigrationResult> {
  const slug = slugifyMigrationName(title);
  if (slug === "") {
    throw new RatchetError(
      `invalid migration name "${title}"; use letters or numbers, for example \`ratchet create add_users\`.`,
    );
  }

  await mkdir(directory, { recursive: true });

  let highest = 0n;
  for (const name of await listSqlFiles(directory)) {
    const match = FILE_PATTERN.exec(name);
    if (match && BigInt(match[1]!) > highest) {
      highest = BigInt(match[1]!);
    }
  }

  const name = `${String(highest + 1n).padStart(4, "0")}_${slug}.sql`;
  const path = join(directory, name);

  try {
    await writeFile(path, "", { flag: "wx" });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new RatchetError(`${path} already exists; choose a different migration name.`);
    }
    throw error;
  }

  return { directory, path, name };
}

export function slugifyMigrationName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeTable(table = DEFAULT_TABLE): string {
  if (!TABLE_PATTERN.test(table)) {
    throw new RatchetError(
      `invalid migration table "${table}"; use a simple unquoted SQL identifier like "${DEFAULT_TABLE}". Table names must start with a lowercase letter or underscore and contain only lowercase letters, numbers, and underscores.`,
    );
  }

  return table;
}

function dialectOf(sql: SQL): Dialect {
  const adapter = (sql.options as { adapter?: string }).adapter ?? "postgres";

  switch (adapter) {
    case "postgres":
    case "sqlite":
      return adapter;
    case "mysql":
    case "mariadb":
      return "mysql";
    default:
      throw new RatchetError(`unsupported Bun.SQL adapter "${adapter}".`);
  }
}

/**
 * Runs `fn` while holding a lock that excludes other migrators. PostgreSQL and
 * MySQL use a session-level advisory lock on a reserved connection, which the
 * server releases on its own if the process dies. SQLite has no session lock;
 * each migration runs in a BEGIN IMMEDIATE transaction and re-checks the
 * metadata table instead, and a busy timeout makes writers wait their turn.
 */
async function withMigrationLock<T>(
  sql: SQL,
  dialect: Dialect,
  table: string,
  fn: (conn: SQL) => Promise<T>,
): Promise<T> {
  if (dialect === "sqlite") {
    return withSqliteBusyTimeout(sql, () => fn(sql));
  }

  const conn = await sql.reserve();
  try {
    if (dialect === "postgres") {
      const key = postgresLockKey(table);
      await conn`SELECT pg_advisory_lock(${key}::bigint)`;
      try {
        return await fn(conn);
      } finally {
        await conn`SELECT pg_advisory_unlock(${key}::bigint)`.catch(() => {});
      }
    }

    const [row] = await conn<{ acquired: number | null }[]>`
      SELECT GET_LOCK(SHA2(CONCAT('ratchet:', IFNULL(DATABASE(), ''), ':', ${table}), 256), ${MYSQL_LOCK_TIMEOUT_SECONDS}) AS acquired
    `;
    if (Number(row?.acquired) !== 1) {
      throw new RatchetError(`could not acquire the MySQL migration lock for "${table}".`);
    }
    try {
      return await fn(conn);
    } finally {
      await conn`
        SELECT RELEASE_LOCK(SHA2(CONCAT('ratchet:', IFNULL(DATABASE(), ''), ':', ${table}), 256))
      `.catch(() => {});
    }
  } finally {
    conn.release();
  }
}

async function withSqliteBusyTimeout<T>(sql: SQL, fn: () => Promise<T>): Promise<T> {
  const [row] = await sql<{ timeout: number }[]>`PRAGMA busy_timeout`;
  if (Number(row?.timeout) > 0) {
    return fn();
  }

  await sql.unsafe(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  try {
    return await fn();
  } finally {
    await sql.unsafe("PRAGMA busy_timeout = 0").catch(() => {});
  }
}

/** Returns false when another migrator recorded this file after we planned. */
async function applyMigration(
  conn: SQL,
  dialect: Dialect,
  table: string,
  migration: Migration,
): Promise<boolean> {
  const run = async (tx: SQL): Promise<boolean> => {
    const [existing] = await tx<{ checksum: string }[]>`
      SELECT checksum FROM ${tx(table)} WHERE name = ${migration.name}
    `;
    if (existing) {
      if (!checksumMatches(existing.checksum, migration)) {
        throw checksumError([
          { name: migration.name, expected: existing.checksum, actual: migration.checksum },
        ]);
      }
      return false;
    }

    for (const statement of statementsFor(dialect, migration.sql)) {
      await tx.unsafe(statement).simple();
    }

    await tx`
      INSERT INTO ${tx(table)} (name, checksum)
      VALUES (${migration.name}, ${migration.checksum})
    `;
    return true;
  };

  return dialect === "sqlite" ? conn.begin("immediate", run) : conn.begin(run);
}

function statementsFor(dialect: Dialect, sql: string): string[] {
  if (dialect === "sqlite") {
    return splitSqliteStatements(sql);
  }

  return containsSql(sql) ? [sql] : [];
}

async function tableExists(sql: SQL, dialect: Dialect, table: string): Promise<boolean> {
  let rows: { present: unknown }[];

  switch (dialect) {
    case "postgres":
      rows = await sql`SELECT to_regclass(${table}) IS NOT NULL AS present`;
      break;
    case "mysql":
      rows = await sql`
        SELECT COUNT(*) > 0 AS present
        FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = ${table}
      `;
      break;
    case "sqlite":
      rows = await sql`
        SELECT COUNT(*) > 0 AS present
        FROM sqlite_master
        WHERE type = 'table' AND name = ${table}
      `;
      break;
  }

  const present = rows[0]?.present;
  return present === true || Number(present) === 1;
}

async function readRecords(sql: SQL, table: string): Promise<MigrationRecord[]> {
  const rows = await sql<{ name: string; checksum: string; applied_at: unknown }[]>`
    SELECT name, checksum, applied_at FROM ${sql(table)}
  `;
  return rows
    .map((row) => ({ name: row.name, checksum: row.checksum, appliedAt: toDate(row.applied_at) }))
    .sort((left, right) => compareNames(left.name, right.name));
}

function planMigrations(migrations: Migration[], records: MigrationRecord[]): Plan {
  const recordsByName = new Map(records.map((record) => [record.name, record]));
  const names = new Set(migrations.map((migration) => migration.name));
  const plan: Plan = { done: [], pending: [], changed: [], missing: [], outOfOrder: [] };
  let latestApplied: bigint | undefined;

  for (const migration of migrations) {
    const record = recordsByName.get(migration.name);

    if (!record) {
      plan.pending.push(migration);
      continue;
    }

    latestApplied = migration.version;

    if (checksumMatches(record.checksum, migration)) {
      plan.done.push(migration);
    } else {
      plan.changed.push({
        name: migration.name,
        expected: record.checksum,
        actual: migration.checksum,
      });
    }
  }

  if (latestApplied !== undefined) {
    const latest = latestApplied;
    plan.outOfOrder = plan.pending.filter((migration) => migration.version < latest);
  }

  plan.missing = records.filter((record) => !names.has(record.name));
  return plan;
}

function assertPlanIsClean(plan: Plan, directory: string): void {
  if (plan.missing.length > 0) {
    const names = plan.missing.map((record) => record.name).join(", ");
    throw new RatchetError(
      `applied migration file missing: ${names}. Restore the missing file(s) to ${directory} from version control before running migrations. If this database is disposable, recreate it and run migrations from scratch.`,
    );
  }

  if (plan.changed.length > 0) {
    throw checksumError(plan.changed);
  }

  if (plan.outOfOrder.length > 0) {
    const names = plan.outOfOrder.map((migration) => migration.name).join(", ");
    const latest = plan.done.at(-1)?.name;
    throw new RatchetError(
      `pending migration sorts before applied migration ${latest}: ${names}. Migrations are forward-only and must run in version order; renumber the pending file(s) to come after ${latest}, or rebuild this database before applying them.`,
    );
  }
}

async function readMigrations(directory: string): Promise<Migration[]> {
  await assertDirectory(directory);

  const names = await listSqlFiles(directory);
  const invalid = names.filter((name) => !FILE_PATTERN.test(name));
  if (invalid.length > 0) {
    throw new RatchetError(
      `invalid migration file name: ${invalid.join(", ")}. Migration files must be named <version>_<name>.sql, for example 0001_add_users.sql; move other .sql files out of ${directory}.`,
    );
  }

  const migrations = await Promise.all(
    names.map(async (name): Promise<Migration> => {
      const path = join(directory, name);
      const raw = await Bun.file(path).text();
      const sql = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");

      return {
        name,
        path,
        version: BigInt(FILE_PATTERN.exec(name)![1]!),
        sql,
        checksum: sha256(sql),
        rawChecksum: sha256(raw),
      };
    }),
  );

  migrations.sort((left, right) =>
    left.version === right.version
      ? compareNames(left.name, right.name)
      : left.version < right.version
        ? -1
        : 1,
  );

  const duplicates = migrations.filter(
    (migration, index) =>
      migrations[index - 1]?.version === migration.version ||
      migrations[index + 1]?.version === migration.version,
  );
  if (duplicates.length > 0) {
    throw new RatchetError(
      `duplicate migration version: ${duplicates.map((migration) => migration.name).join(", ")}. Each migration needs a unique version number; renumber the file that has not been applied yet.`,
    );
  }

  return migrations;
}

async function listSqlFiles(directory: string): Promise<string[]> {
  const names: string[] = [];

  for await (const name of new Glob("*.sql").scan({ cwd: directory, onlyFiles: true })) {
    names.push(name);
  }

  return names.sort(compareNames);
}

async function assertDirectory(directory: string): Promise<void> {
  let info;

  try {
    info = await stat(directory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new RatchetError(
        `migration directory not found: ${directory}; create your first migration with \`ratchet create <name> --dir ${directory}\`, or pass the directory that contains your *.sql migrations with --dir.`,
      );
    }

    throw error;
  }

  if (!info.isDirectory()) {
    throw new RatchetError(
      `${directory} is not a directory; pass the directory that contains your *.sql migrations with --dir.`,
    );
  }
}

function migrationError(
  migration: Migration,
  applied: string[],
  dialect: Dialect,
  cause: unknown,
): MigrationError {
  const hint =
    dialect === "mysql"
      ? " (MySQL commits DDL statements implicitly, so statements in this file that ran before the failure may not have been rolled back)"
      : "";
  return new MigrationError(
    migration.name,
    applied,
    `migration ${migration.name} failed: ${errorMessage(cause)}${hint}`,
    cause,
  );
}

// PostgreSQL and MySQL return a Date. SQLite returns CURRENT_TIMESTAMP as
// "YYYY-MM-DD HH:MM:SS" text, which is UTC.
function toDate(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }

  const text = String(value);
  return new Date(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)
      ? `${text.replace(" ", "T")}Z`
      : text,
  );
}

function checksumMatches(recorded: string, migration: Migration): boolean {
  return recorded === migration.checksum || recorded === migration.rawChecksum;
}

function checksumError(changed: ChangedMigration[]): RatchetError {
  const names = changed.map((change) => change.name).join(", ");
  return new RatchetError(
    `migration checksum mismatch: ${names}. Applied migration files are immutable; restore the file contents that were originally applied, or create a new migration for the new change.`,
  );
}

function toMigrationFile(migration: Migration): MigrationFile {
  return { name: migration.name, path: migration.path, checksum: migration.checksum };
}

// Plain code-unit comparison; localeCompare depends on the machine's locale.
function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function postgresLockKey(table: string): string {
  const hex = sha256(`ratchet:${table}`).slice(0, 16);
  return BigInt.asIntN(64, BigInt(`0x${hex}`)).toString();
}

function sha256(input: string): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

#!/usr/bin/env bun

import { SQL } from "bun";
import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  createMigrationFile,
  DEFAULT_DIRECTORY,
  DEFAULT_TABLE,
  getMigrationStatus,
  initMigrationDirectory,
  migrate,
  type RatchetConnection,
} from "./migrator.ts";

type CliConfig = {
  command?: string;
  directory: string;
  table: string;
  url?: string;
  title?: string;
  help: boolean;
  yes: boolean;
  sqliteExtensions: string[];
  sqliteLibrary?: string;
};

const HELP = `ratchet

Usage:
  ratchet init [--dir migrations] [--table ratchet_migrations]
  ratchet create [name] [--dir migrations]
  ratchet up [--dir migrations] [--table ratchet_migrations] [--url DATABASE_URL] [--sqlite-extension PATH]
  ratchet status [--dir migrations] [--table ratchet_migrations] [--url DATABASE_URL] [--sqlite-extension PATH]
  ratchet drop [--url DATABASE_URL] [--yes]

Environment:
  RATCHET_DIR
  RATCHET_TABLE
  RATCHET_DATABASE_URL
  RATCHET_SQLITE_EXTENSIONS
  RATCHET_SQLITE_LIBRARY

SQLite:
  --sqlite-extension PATH may be passed more than once. When set, ratchet uses
  bun:sqlite for up/status so SQLite extensions can be loaded before migrations.
  --sqlite-library PATH sets bun:sqlite's custom SQLite library before opening
  the database, which is useful on macOS builds that disable extension loading.

Safety:
  drop wipes the connected database so migrations can be replayed from scratch.
    PostgreSQL: DROP SCHEMA public CASCADE; CREATE SCHEMA public;
    MySQL/MariaDB: drops every table and view in the current database.
    SQLite: deletes the database file (and -wal/-shm sidecars).
  drop is disabled when NODE_ENV=production.
`;

export function parseCliConfig(argv = Bun.argv.slice(2)): CliConfig {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      dir: {
        type: "string",
        short: "d",
      },
      table: {
        type: "string",
        short: "t",
      },
      url: {
        type: "string",
        short: "u",
      },
      help: {
        type: "boolean",
        short: "h",
      },
      yes: {
        type: "boolean",
        short: "y",
      },
      "sqlite-extension": {
        type: "string",
        multiple: true,
      },
      "sqlite-library": {
        type: "string",
      },
    },
  });

  const [command, ...titleParts] = positionals;
  const sqliteExtensionFlags = values["sqlite-extension"];

  return {
    command,
    directory: values.dir ?? Bun.env.RATCHET_DIR ?? DEFAULT_DIRECTORY,
    table: values.table ?? Bun.env.RATCHET_TABLE ?? DEFAULT_TABLE,
    url: values.url ?? Bun.env.RATCHET_DATABASE_URL,
    title: titleParts.join(" ") || undefined,
    help: values.help ?? false,
    yes: values.yes ?? false,
    sqliteExtensions:
      sqliteExtensionFlags !== undefined
        ? sqliteExtensionFlags
        : splitEnvList(Bun.env.RATCHET_SQLITE_EXTENSIONS),
    sqliteLibrary: values["sqlite-library"] ?? Bun.env.RATCHET_SQLITE_LIBRARY,
  };
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const config = parseCliConfig(argv);

  if (config.help) {
    console.log(HELP);
    return 0;
  }

  switch (config.command) {
    case "init": {
      const result = await initMigrationDirectory(config.directory, config.table);
      console.log(`created ${result.path}`);
      return 0;
    }

    case "create": {
      const result = await createMigrationFile(config.directory, config.title);
      console.log(`created ${result.path}`);
      return 0;
    }

    case "up": {
      const sql = openMigratorConnection(config);
      try {
        const result = await migrate(sql, config.directory, { table: config.table });
        if (result.applied.length === 0) {
          console.log("up to date");
          return 0;
        }

        console.log(`applied ${result.applied.length} migration(s)`);
        for (const name of result.applied) {
          console.log(`  ${name}`);
        }
        return 0;
      } finally {
        await closeMigratorConnection(sql);
      }
    }

    case "status": {
      const sql = openMigratorConnection(config);
      try {
        const status = await getMigrationStatus(sql, config.directory, { table: config.table });
        printStatus(status);
        return status.tableOk && status.changed.length === 0 && status.missing.length === 0 ? 0 : 1;
      } finally {
        await closeMigratorConnection(sql);
      }
    }

    case "drop": {
      assertDropAllowed();
      const sql = openSql(config.url);
      const adapter = getAdapter(sql);
      const identifier = databaseIdentifier(sql, config.url);
      let closed = false;

      try {
        if (!confirmDrop(config, identifier)) {
          console.error("drop cancelled");
          return 1;
        }

        if (adapter === "sqlite") {
          await sql.close();
          closed = true;
          await dropSqliteFile(identifier);
        } else if (adapter === "mysql" || adapter === "mariadb") {
          await dropMysqlObjects(sql);
        } else {
          await dropPostgresPublicSchema(sql);
        }

        console.log(`dropped ${identifier}`);
        return 0;
      } finally {
        if (!closed) {
          await sql.close();
        }
      }
    }

    case undefined:
      console.error(HELP);
      return 1;

    default:
      console.error(`unknown command: ${config.command}`);
      console.error(HELP);
      return 1;
  }
}

function openSql(url?: string): SQL {
  return url ? new SQL(url) : new SQL();
}

function openMigratorConnection(config: CliConfig): RatchetConnection {
  if (!shouldUseSQLiteDatabase(config)) {
    return openSql(config.url);
  }

  const filename = sqliteFilenameForConfig(config);

  if (config.sqliteLibrary !== undefined) {
    Database.setCustomSQLite(config.sqliteLibrary);
  }

  const db = new Database(filename);
  try {
    for (const extension of config.sqliteExtensions) {
      db.loadExtension(extension);
    }
  } catch (error) {
    db.close();
    throw error;
  }

  return db;
}

async function closeMigratorConnection(sql: RatchetConnection): Promise<void> {
  await sql.close();
}

function shouldUseSQLiteDatabase(config: CliConfig): boolean {
  return config.sqliteExtensions.length > 0 || config.sqliteLibrary !== undefined;
}

function sqliteFilenameForConfig(config: CliConfig): string {
  const filename = extractSqlitePath(config.url ?? Bun.env.DATABASE_URL);

  if (filename !== undefined) {
    return filename;
  }

  throw new Error(
    "SQLite extension loading requires a SQLite database URL from --url, RATCHET_DATABASE_URL, or DATABASE_URL. Use :memory:, sqlite://..., sqlite:..., file://..., or file:....",
  );
}

function splitEnvList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function assertDropAllowed(): void {
  if ((Bun.env.NODE_ENV ?? "").toLowerCase() !== "production") {
    return;
  }

  throw new Error(
    "ratchet drop is disabled when NODE_ENV=production; use it only with a disposable development database.",
  );
}

type SqlOptionsShape = {
  adapter?: string;
  filename?: string;
  database?: string;
};

function getAdapter(sql: SQL): string {
  const opts = sql.options as SqlOptionsShape;
  return opts.adapter ?? "postgres";
}

function databaseIdentifier(sql: SQL, url: string | undefined): string {
  const opts = sql.options as SqlOptionsShape;

  if (opts.adapter === "sqlite") {
    if (typeof opts.filename === "string") {
      return opts.filename;
    }
    return extractSqlitePath(url) ?? ":memory:";
  }

  if (opts.database) {
    return opts.database;
  }

  return extractDatabaseFromUrl(url) ?? url ?? "(unknown)";
}

function extractSqlitePath(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  if (url === ":memory:") {
    return url;
  }

  for (const prefix of ["sqlite://", "sqlite:", "file://", "file:"]) {
    if (url.startsWith(prefix)) {
      const filename = stripUrlSuffix(url.slice(prefix.length));
      return filename === "" ? undefined : decodeURI(filename);
    }
  }

  return undefined;
}

function stripUrlSuffix(value: string): string {
  const marker = value.search(/[?#]/);
  return marker === -1 ? value : value.slice(0, marker);
}

function extractDatabaseFromUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (!path || path === "/") {
      return undefined;
    }
    return path.startsWith("/") ? path.slice(1) : path;
  } catch {
    return undefined;
  }
}

async function dropSqliteFile(filename: string): Promise<void> {
  if (filename === ":memory:" || filename === "") {
    return;
  }

  await Promise.all([
    rm(filename, { force: true }),
    rm(`${filename}-journal`, { force: true }),
    rm(`${filename}-wal`, { force: true }),
    rm(`${filename}-shm`, { force: true }),
  ]);
}

async function dropPostgresPublicSchema(sql: SQL): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await tx`DROP SCHEMA IF EXISTS public CASCADE`;
      await tx`CREATE SCHEMA public`;
    });
  } catch (cause) {
    const error = new Error(
      "could not drop and recreate the public schema; check that the connected user owns the database, or run drop against a disposable database.",
    );
    error.cause = cause;
    throw error;
  }

  // Best-effort grants; some managed PostgreSQL providers restrict these.
  for (const grant of [
    sql`GRANT ALL ON SCHEMA public TO public`,
    sql`GRANT ALL ON SCHEMA public TO CURRENT_USER`,
  ]) {
    try {
      await grant;
    } catch {
      // ignore — grants are best-effort
    }
  }
}

async function dropMysqlObjects(sql: SQL): Promise<void> {
  type Row = { table_name: string; table_type: string };

  let rows: Row[];
  try {
    rows = await sql<Row[]>`
      SELECT table_name AS table_name, table_type AS table_type
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
    `;
  } catch (cause) {
    const error = new Error(
      "could not list tables to drop; check --url points at a database the connected user can read.",
    );
    error.cause = cause;
    throw error;
  }

  if (rows.length === 0) {
    return;
  }

  try {
    await sql`SET FOREIGN_KEY_CHECKS = 0`;
    for (const row of rows) {
      if (row.table_type === "VIEW") {
        await sql`DROP VIEW IF EXISTS ${sql(row.table_name)}`;
      } else {
        await sql`DROP TABLE IF EXISTS ${sql(row.table_name)}`;
      }
    }
  } catch (cause) {
    const error = new Error(
      "could not drop every object in the current database; check that the connected user has DROP privileges.",
    );
    error.cause = cause;
    throw error;
  } finally {
    try {
      await sql`SET FOREIGN_KEY_CHECKS = 1`;
    } catch {
      // ignore — connection may already be in a bad state
    }
  }
}

function confirmDrop(config: CliConfig, identifier: string): boolean {
  if (config.yes) {
    return true;
  }

  console.log(`This will wipe all schema and data from ${identifier}.`);
  console.log("Migrations will need to be replayed from scratch afterwards.");

  const answer = prompt(`Type "drop" to confirm: `);
  return answer === "drop";
}

function printStatus(status: Awaited<ReturnType<typeof getMigrationStatus>>): void {
  console.log(`directory: ${status.directory}`);
  console.log(`table: ${status.table}`);

  if (!status.tableOk) {
    console.log("table: missing or unreadable");
    if (status.tableError) {
      console.log(status.tableError);
    }
  }

  console.log(`applied: ${status.applied.length}`);
  console.log(`pending: ${status.pending.length}`);
  console.log(`changed: ${status.changed.length}`);
  console.log(`missing: ${status.missing.length}`);

  for (const file of status.pending) {
    console.log(`  pending ${file.name}`);
  }

  for (const change of status.changed) {
    console.log(`  changed ${change.name}`);
  }

  for (const record of status.missing) {
    console.log(`  missing ${record.name}`);
  }
}

if (import.meta.main) {
  try {
    const code = await main();
    process.exit(code);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

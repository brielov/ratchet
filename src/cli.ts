#!/usr/bin/env bun

import { SQL } from "bun";
import { parseArgs } from "node:util";
import {
  createMigrationFile,
  DEFAULT_DIRECTORY,
  DEFAULT_TABLE,
  getMigrationStatus,
  initMigrationDirectory,
  migrate,
  normalizeTable,
} from "./migrator.ts";

type CliConfig = {
  command?: string;
  directory: string;
  table: string;
  url?: string;
  title?: string;
  help: boolean;
  yes: boolean;
};

type MigrationRecordName = {
  name: string;
};

const HELP = `ratchet

Usage:
  ratchet init [--dir migrations] [--table ratchet_migrations]
  ratchet create [name] [--dir migrations]
  ratchet up [--dir migrations] [--table ratchet_migrations] [--url DATABASE_URL]
  ratchet status [--dir migrations] [--table ratchet_migrations] [--url DATABASE_URL]
  ratchet clear [--table ratchet_migrations] [--url DATABASE_URL] [--yes]

Environment:
  RATCHET_DIR
  RATCHET_TABLE
  RATCHET_DATABASE_URL

Safety:
  clear only deletes Ratchet migration history; it does not drop schema or data.
  clear is disabled when NODE_ENV=production.
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
    },
  });

  const [command, ...titleParts] = positionals;

  return {
    command,
    directory: values.dir ?? Bun.env.RATCHET_DIR ?? DEFAULT_DIRECTORY,
    table: values.table ?? Bun.env.RATCHET_TABLE ?? DEFAULT_TABLE,
    url: values.url ?? Bun.env.RATCHET_DATABASE_URL,
    title: titleParts.join(" ") || undefined,
    help: values.help ?? false,
    yes: values.yes ?? false,
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
      const sql = openSql(config.url);
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
        await sql.close();
      }
    }

    case "status": {
      const sql = openSql(config.url);
      try {
        const status = await getMigrationStatus(sql, config.directory, { table: config.table });
        printStatus(status);
        return status.tableOk && status.changed.length === 0 && status.missing.length === 0 ? 0 : 1;
      } finally {
        await sql.close();
      }
    }

    case "clear": {
      assertClearAllowed();
      const table = normalizeTable(config.table);
      const sql = openSql(config.url);
      try {
        const records = await readMigrationRecordNames(sql, table);
        if (records.length === 0) {
          console.log(`no migration records found in ${table}`);
          return 0;
        }

        if (!confirmClear(config, records.length)) {
          console.error("clear cancelled");
          return 1;
        }

        await deleteMigrationRecords(sql, table);
        console.log(`cleared ${records.length} migration record(s) from ${table}`);
        console.log("database schema and data were not changed");
        return 0;
      } finally {
        await sql.close();
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

function assertClearAllowed(): void {
  if ((Bun.env.NODE_ENV ?? "").toLowerCase() !== "production") {
    return;
  }

  throw new Error(
    "ratchet clear is disabled when NODE_ENV=production; use it only with a disposable development database.",
  );
}

async function readMigrationRecordNames(sql: SQL, table: string): Promise<MigrationRecordName[]> {
  try {
    return await sql<MigrationRecordName[]>`
      SELECT name
      FROM ${sql(table)}
      ORDER BY name
    `;
  } catch (cause) {
    const error = new Error(
      `could not read migration table "${table}"; check --table and --url, or run \`ratchet up\` before clearing migration history.`,
    );
    error.cause = cause;
    throw error;
  }
}

async function deleteMigrationRecords(sql: SQL, table: string): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM ${tx(table)}`;
    });
  } catch (cause) {
    const error = new Error(
      `could not clear migration table "${table}"; check that the database user can delete from this table.`,
    );
    error.cause = cause;
    throw error;
  }
}

function confirmClear(config: CliConfig, recordCount: number): boolean {
  if (config.yes) {
    return true;
  }

  console.log(`This will clear ${recordCount} migration record(s) from ${config.table}.`);
  console.log("It only clears Ratchet migration history; it does not drop schema or data.");
  console.log("Running `ratchet up` afterwards may replay migrations against the existing schema.");

  const tableAnswer = prompt(`Type "${config.table}" to confirm the migration table: `);
  if (tableAnswer !== config.table) {
    return false;
  }

  const clearAnswer = prompt(`Type "clear" to clear ${recordCount} migration record(s): `);
  return clearAnswer === "clear";
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

#!/usr/bin/env bun

import { SQL } from "bun";
import { parseArgs } from "node:util";
import {
  createMigrationFile,
  DEFAULT_DIRECTORY,
  DEFAULT_TABLE,
  getMigrationStatus,
  migrate,
  MigrationError,
  type MigrationStatus,
} from "./migrator.ts";

type CliConfig = {
  command?: string;
  directory: string;
  table: string;
  url?: string;
  title?: string;
  help: boolean;
};

const HELP = `ratchet

Usage:
  ratchet create <name> [--dir migrations]
  ratchet up [--dir migrations] [--table ratchet_migrations] [--url DATABASE_URL]
  ratchet status [--dir migrations] [--table ratchet_migrations] [--url DATABASE_URL]

Environment:
  RATCHET_DIR
  RATCHET_TABLE
  RATCHET_DATABASE_URL

Without --url or RATCHET_DATABASE_URL, Bun.SQL reads DATABASE_URL and its
other supported environment variables.
`;

const REMOVED_COMMANDS: Record<string, string> = {
  init: "ratchet init was removed; the metadata table is now created automatically. Use `ratchet create <name>` to add a migration.",
  drop: "ratchet drop was removed; drop and recreate development databases with your database's own tooling.",
};

export function parseCliConfig(argv = Bun.argv.slice(2)): CliConfig {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      dir: { type: "string", short: "d" },
      table: { type: "string", short: "t" },
      url: { type: "string", short: "u" },
      help: { type: "boolean", short: "h" },
    },
  });

  const [command, ...titleParts] = positionals;

  return {
    command,
    // `||` so empty values (e.g. `RATCHET_DIR=` in a .env file) count as unset.
    directory: values.dir || Bun.env.RATCHET_DIR || DEFAULT_DIRECTORY,
    table: values.table || Bun.env.RATCHET_TABLE || DEFAULT_TABLE,
    url: values.url || Bun.env.RATCHET_DATABASE_URL || undefined,
    title: titleParts.join(" ") || undefined,
    help: values.help ?? false,
  };
}

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const config = parseCliConfig(argv);

  if (config.help) {
    console.log(HELP);
    return 0;
  }

  switch (config.command) {
    case "create": {
      if (config.title === undefined) {
        console.error(
          "ratchet create needs a migration name, for example `ratchet create add_users`.",
        );
        return 1;
      }
      const result = await createMigrationFile(config.directory, config.title);
      console.log(`created ${result.path}`);
      return 0;
    }

    case "up": {
      const sql = config.url ? new SQL(config.url) : new SQL();
      try {
        const result = await migrate(sql, config.directory, { table: config.table });
        if (result.applied.length === 0) {
          console.log("up to date");
          return 0;
        }

        console.log(`applied ${result.applied.length} migration(s)`);
        printNames(result.applied);
        return 0;
      } catch (error) {
        if (error instanceof MigrationError && error.applied.length > 0) {
          console.error(`applied ${error.applied.length} migration(s) before the failure`);
          printNames(error.applied, console.error);
        }
        throw error;
      } finally {
        await sql.close();
      }
    }

    case "status": {
      const sql = config.url ? new SQL(config.url) : new SQL();
      try {
        const status = await getMigrationStatus(sql, config.directory, { table: config.table });
        printStatus(config, status);
        const clean =
          status.changed.length === 0 &&
          status.missing.length === 0 &&
          status.outOfOrder.length === 0;
        return clean ? 0 : 1;
      } finally {
        await sql.close();
      }
    }

    case undefined:
      console.error(HELP);
      return 1;

    default: {
      const removed = REMOVED_COMMANDS[config.command];
      console.error(removed ?? `unknown command: ${config.command}\n\n${HELP}`);
      return 1;
    }
  }
}

function printNames(names: string[], print = console.log): void {
  for (const name of names) {
    print(`  ${name}`);
  }
}

function printStatus(config: CliConfig, status: MigrationStatus): void {
  console.log(`directory: ${config.directory}`);
  console.log(`table: ${config.table}`);
  console.log(`applied: ${status.records.length}`);
  console.log(`pending: ${status.pending.length}`);

  for (const file of status.pending) {
    console.log(`  pending ${file.name}`);
  }

  for (const change of status.changed) {
    console.log(`  changed ${change.name}`);
  }

  for (const record of status.missing) {
    console.log(`  missing ${record.name}`);
  }

  for (const file of status.outOfOrder) {
    console.log(`  out of order ${file.name}`);
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

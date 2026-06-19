import { SQL } from "bun";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { main, parseCliConfig } from "./cli.ts";
import {
  createMigrationFile,
  getMigrationStatus,
  initMigrationDirectory,
  migrate,
  slugifyMigrationName,
} from "./migrator.ts";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("init writes the metadata migration", async () => {
  const directory = await tempDirectory();
  const result = await initMigrationDirectory(directory);

  expect(basename(result.path)).toBe("0000_ratchet.sql");
  expect(await Bun.file(result.path).text()).toContain(
    "CREATE TABLE IF NOT EXISTS ratchet_migrations",
  );
});

test("init rejects mixed-case metadata table names", async () => {
  const directory = await tempDirectory();

  await expectRejectsWith(initMigrationDirectory(directory, "Foo"), [
    "simple unquoted SQL identifier",
    "lowercase letters",
  ]);
});

test("init explains when the migration directory is already initialized", async () => {
  const directory = await tempDirectory();
  await initMigrationDirectory(directory);

  await expectRejectsWith(initMigrationDirectory(directory), [
    "already initialized",
    "ratchet create <name>",
  ]);
});

test("create writes the next numbered migration", async () => {
  const directory = await tempDirectory();
  await initMigrationDirectory(directory);

  const named = await createMigrationFile(directory, "Add Users");
  const generated = await createMigrationFile(directory);

  expect(named.name).toBe("0001_add_users.sql");
  expect(generated.name).toMatch(/^0002_[a-z]+_[a-z]+_[a-z]+\.sql$/);
});

test("create avoids repeated random migration names", async () => {
  const directory = await tempDirectory();
  await initMigrationDirectory(directory);
  await Bun.write(join(directory, "0001_able_building_anchor.sql"), "");

  const generated = await withRandomValues([0, 0, 0, 0.1, 0, 0], () =>
    createMigrationFile(directory),
  );

  expect(generated.name).toBe("0002_brave_building_anchor.sql");
});

test("migrate applies pending sql files and skips them on rerun", async () => {
  const directory = await tempDirectory();
  await initMigrationDirectory(directory);
  await Bun.write(
    join(directory, "0001_create_widgets.sql"),
    "CREATE TABLE widgets (name TEXT NOT NULL); INSERT INTO widgets (name) VALUES ('Ada');",
  );

  const sql = new SQL(":memory:");
  try {
    const first = await migrate(sql, directory);
    const second = await migrate(sql, directory);
    const rows = await sql<{ name: string }[]>`SELECT name FROM widgets`;

    expect(first.applied).toEqual(["0000_ratchet.sql", "0001_create_widgets.sql"]);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["0000_ratchet.sql", "0001_create_widgets.sql"]);
    expect(rows).toEqual([{ name: "Ada" }]);
  } finally {
    await sql.close();
  }
});

test("migrate records blank sql files as no-op migrations", async () => {
  const directory = await tempDirectory();
  await initMigrationDirectory(directory);
  const blank = await createMigrationFile(directory, "empty");

  const sql = new SQL(":memory:");
  try {
    const result = await migrate(sql, directory);

    expect(result.applied).toEqual(["0000_ratchet.sql", blank.name]);
  } finally {
    await sql.close();
  }
});

test("migrate fails when an applied file changes", async () => {
  const directory = await tempDirectory();
  await initMigrationDirectory(directory);
  const migration = join(directory, "0001_create_widgets.sql");
  await Bun.write(migration, "CREATE TABLE widgets (name TEXT NOT NULL);");

  const sql = new SQL(":memory:");
  try {
    await migrate(sql, directory);
    await Bun.write(migration, "CREATE TABLE widgets (name TEXT NOT NULL, id INTEGER);");

    await expectRejectsWith(migrate(sql, directory), [
      "migration checksum mismatch",
      "Applied migration files are immutable",
      "create a new migration",
    ]);
  } finally {
    await sql.close();
  }
});

test("migrate fails when an applied migration file is missing", async () => {
  const directory = await tempDirectory();
  await initMigrationDirectory(directory);
  const migration = await createMigrationFile(directory, "empty");

  const sql = new SQL(":memory:");
  try {
    await migrate(sql, directory);
    await rm(migration.path);
    await Bun.write(
      join(directory, "0002_create_widgets.sql"),
      "CREATE TABLE widgets (name TEXT NOT NULL);",
    );

    await expectRejectsWith(migrate(sql, directory), [
      "applied migration file missing",
      "Restore the missing file(s)",
      "recreate it",
    ]);
    expect(await tableExists(sql, "widgets")).toBe(false);
  } finally {
    await sql.close();
  }
});

test("migrate rejects pending files that sort before applied migrations", async () => {
  const directory = await tempDirectory();
  await initMigrationDirectory(directory);
  await Bun.write(
    join(directory, "0002_create_later_widgets.sql"),
    "CREATE TABLE later_widgets (name TEXT NOT NULL);",
  );

  const sql = new SQL(":memory:");
  try {
    await migrate(sql, directory);
    await Bun.write(
      join(directory, "0001_create_earlier_widgets.sql"),
      "CREATE TABLE earlier_widgets (name TEXT NOT NULL);",
    );

    await expectRejectsWith(migrate(sql, directory), [
      "pending migration sorts before applied",
      "lexicographic order",
      "rename the pending file(s)",
    ]);
    expect(await tableExists(sql, "earlier_widgets")).toBe(false);
  } finally {
    await sql.close();
  }
});

test("migrate fails with an init hint when the metadata migration is missing", async () => {
  const directory = await tempDirectory();
  await Bun.write(join(directory, "0001_do_work.sql"), "SELECT 1;");

  const sql = new SQL(":memory:");
  try {
    await expectRejectsWith(migrate(sql, directory), [
      "ratchet init",
      "0000_ratchet.sql",
      "--dir, --table, and --url",
    ]);
  } finally {
    await sql.close();
  }
});

test("migrate explains how to create or select a missing migration directory", async () => {
  const directory = join(await tempDirectory(), "missing");

  const sql = new SQL(":memory:");
  try {
    await expectRejectsWith(migrate(sql, directory), [
      "migration directory not found",
      "ratchet init --dir",
      "contains your *.sql migrations",
    ]);
  } finally {
    await sql.close();
  }
});

test("migrate rejects a --table that does not match the bootstrap migration", async () => {
  const directory = await tempDirectory();
  await initMigrationDirectory(directory, "first_table");

  const sql = new SQL(":memory:");
  try {
    await expectRejectsWith(migrate(sql, directory, { table: "second_table" }), [
      "bootstrap migration 0000_ratchet.sql",
      'creates table "first_table"',
      'configured table is "second_table"',
      "Pass --table first_table",
    ]);
  } finally {
    await sql.close();
  }
});

test("public package surface re-exports RatchetError and getMigrationStatus", async () => {
  const surface = await import("./index.ts");

  expect(typeof surface.migrate).toBe("function");
  expect(typeof surface.getMigrationStatus).toBe("function");
  expect(typeof surface.RatchetError).toBe("function");
  expect(new surface.RatchetError("x")).toBeInstanceOf(Error);
});

test("status is read-only when the table is missing", async () => {
  const directory = await tempDirectory();
  await initMigrationDirectory(directory);

  const sql = new SQL(":memory:");
  try {
    const status = await getMigrationStatus(sql, directory);

    expect(status.tableOk).toBe(false);
    expect(status.pending.map((file) => file.name)).toEqual(["0000_ratchet.sql"]);
  } finally {
    await sql.close();
  }
});

test("cli status fails when an applied migration file is missing", async () => {
  const directory = await tempDirectory();
  const migrationsDirectory = join(directory, "migrations");
  const databaseUrl = `sqlite://${join(directory, "app.db")}`;
  await initMigrationDirectory(migrationsDirectory);
  const migration = await createMigrationFile(migrationsDirectory, "empty");

  const sql = new SQL(databaseUrl);
  try {
    await migrate(sql, migrationsDirectory);
  } finally {
    await sql.close();
  }

  await rm(migration.path);

  const code = await withSilentConsole(() =>
    main(["status", "--dir", migrationsDirectory, "--url", databaseUrl]),
  );

  expect(code).toBe(1);
});

test("cli clear with --yes skips confirmation and preserves schema", async () => {
  const directory = await tempDirectory();
  const migrationsDirectory = join(directory, "migrations");
  const databaseUrl = `sqlite://${join(directory, "app.db")}`;
  await initMigrationDirectory(migrationsDirectory);
  await Bun.write(
    join(migrationsDirectory, "0001_create_widgets.sql"),
    "CREATE TABLE widgets (name TEXT NOT NULL); INSERT INTO widgets (name) VALUES ('Ada');",
  );

  const sql = new SQL(databaseUrl);
  try {
    await migrate(sql, migrationsDirectory);
  } finally {
    await sql.close();
  }

  const code = await withSilentConsole(() =>
    main(["clear", "--dir", migrationsDirectory, "--url", databaseUrl, "--yes"]),
  );

  const checkSql = new SQL(databaseUrl);
  try {
    expect(code).toBe(0);
    expect(await migrationNames(checkSql)).toEqual([]);
    expect(await tableExists(checkSql, "widgets")).toBe(true);
    expect(await checkSql<{ name: string }[]>`SELECT name FROM widgets`).toEqual([{ name: "Ada" }]);
  } finally {
    await checkSql.close();
  }
});

test("cli clear accepts typed confirmations", async () => {
  const directory = await tempDirectory();
  const migrationsDirectory = join(directory, "migrations");
  const databaseUrl = `sqlite://${join(directory, "app.db")}`;
  await initMigrationDirectory(migrationsDirectory);

  const sql = new SQL(databaseUrl);
  try {
    await migrate(sql, migrationsDirectory);
  } finally {
    await sql.close();
  }

  const code = await withPrompt(["ratchet_migrations", "clear"], () =>
    withSilentConsole(() => main(["clear", "--url", databaseUrl])),
  );

  const checkSql = new SQL(databaseUrl);
  try {
    expect(code).toBe(0);
    expect(await migrationNames(checkSql)).toEqual([]);
  } finally {
    await checkSql.close();
  }
});

test("cli clear cancels when confirmation does not match", async () => {
  const directory = await tempDirectory();
  const migrationsDirectory = join(directory, "migrations");
  const databaseUrl = `sqlite://${join(directory, "app.db")}`;
  await initMigrationDirectory(migrationsDirectory);

  const sql = new SQL(databaseUrl);
  try {
    await migrate(sql, migrationsDirectory);
  } finally {
    await sql.close();
  }

  const code = await withPrompt(["wrong_table"], () =>
    withSilentConsole(() => main(["clear", "--url", databaseUrl])),
  );

  const checkSql = new SQL(databaseUrl);
  try {
    expect(code).toBe(1);
    expect(await migrationNames(checkSql)).toEqual(["0000_ratchet.sql"]);
  } finally {
    await checkSql.close();
  }
});

test("cli clear is disabled in production", async () => {
  const oldNodeEnv = Bun.env.NODE_ENV;

  try {
    Bun.env.NODE_ENV = "production";

    await expectRejectsWith(main(["clear", "--url", "sqlite://ignored.db", "--yes"]), [
      "disabled",
      "NODE_ENV=production",
      "development database",
    ]);
  } finally {
    restoreEnv("NODE_ENV", oldNodeEnv);
  }
});

test("cli flags override Bun.env defaults", () => {
  const oldDirectory = Bun.env.RATCHET_DIR;
  const oldTable = Bun.env.RATCHET_TABLE;
  const oldUrl = Bun.env.RATCHET_DATABASE_URL;

  try {
    Bun.env.RATCHET_DIR = "env_migrations";
    Bun.env.RATCHET_TABLE = "env_table";
    Bun.env.RATCHET_DATABASE_URL = "sqlite://env.db";

    const config = parseCliConfig([
      "up",
      "--dir",
      "flag_migrations",
      "--table",
      "flag_table",
      "--url",
      "sqlite://flag.db",
    ]);

    expect(config.directory).toBe("flag_migrations");
    expect(config.table).toBe("flag_table");
    expect(config.url).toBe("sqlite://flag.db");
  } finally {
    restoreEnv("RATCHET_DIR", oldDirectory);
    restoreEnv("RATCHET_TABLE", oldTable);
    restoreEnv("RATCHET_DATABASE_URL", oldUrl);
  }
});

test("cli unknown command exits non-zero and prints help", async () => {
  const errors: string[] = [];
  const oldError = console.error;
  console.error = (message: unknown) => {
    errors.push(typeof message === "string" ? message : String(message));
  };

  try {
    const code = await main(["wat"]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("unknown command: wat");
    expect(errors.join("\n")).toContain("Usage:");
  } finally {
    console.error = oldError;
  }
});

test("slugifies migration names", () => {
  expect(slugifyMigrationName("Add OAuth Users!")).toBe("add_oauth_users");
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ratchet-"));
  tempDirectories.push(directory);
  return directory;
}

async function withSilentConsole<T>(callback: () => Promise<T>): Promise<T> {
  const oldLog = console.log;
  const oldError = console.error;

  try {
    console.log = () => {};
    console.error = () => {};
    return await callback();
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
}

async function withPrompt<T>(
  answers: Array<string | null>,
  callback: () => Promise<T>,
): Promise<T> {
  const oldPrompt = globalThis.prompt;
  let index = 0;
  const replacement: typeof prompt = () => answers[index++] ?? null;

  try {
    Object.defineProperty(globalThis, "prompt", {
      configurable: true,
      value: replacement,
    });
    return await callback();
  } finally {
    Object.defineProperty(globalThis, "prompt", {
      configurable: true,
      value: oldPrompt,
    });
  }
}

async function withRandomValues<T>(values: number[], callback: () => Promise<T>): Promise<T> {
  const oldRandom = Math.random;
  let index = 0;

  try {
    Math.random = () => values[index++] ?? 0;
    return await callback();
  } finally {
    Math.random = oldRandom;
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete Bun.env[name];
    return;
  }

  Bun.env[name] = value;
}

async function tableExists(sql: SQL, name: string): Promise<boolean> {
  const rows = await sql<{ name: string }[]>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ${name}
  `;
  return rows.length > 0;
}

async function migrationNames(sql: SQL): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    SELECT name
    FROM ratchet_migrations
    ORDER BY name
  `;
  return rows.map((row) => row.name);
}

async function expectRejectsWith(
  promise: Promise<unknown>,
  expected: string | string[],
): Promise<void> {
  const messages = Array.isArray(expected) ? expected : [expected];

  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const expectedMessage of messages) {
      expect(message).toContain(expectedMessage);
    }
    return;
  }

  throw new Error(`expected promise to reject with ${messages.join(", ")}`);
}

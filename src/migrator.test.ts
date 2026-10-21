import { SQL } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMigrationFile,
  getMigrationStatus,
  migrate,
  MigrationError,
  normalizeTable,
  RatchetError,
  slugifyMigrationName,
} from "./migrator.ts";

// SQLite always runs. The others run when a URL to a disposable database is
// provided; every table in it is dropped before each test.
//   RATCHET_TEST_POSTGRES_URL=postgres://postgres:ratchet@127.0.0.1:54329/ratchet
//   RATCHET_TEST_MYSQL_URL=mysql://root:ratchet@127.0.0.1:53306/ratchet?sslmode=require
//   RATCHET_TEST_MARIADB_URL=mysql://root:ratchet@127.0.0.1:53307/ratchet

type Target = {
  name: string;
  dialect: "sqlite" | "postgres" | "mysql";
  url: () => string;
  reset: () => Promise<void>;
  sleep: string;
};

const tempDirectories: string[] = [];
let sqliteUrl = "";

const targets: Target[] = [
  {
    name: "sqlite",
    dialect: "sqlite",
    url: () => sqliteUrl,
    reset: async () => {
      sqliteUrl = `sqlite://${join(await tempDirectory(), "app.db")}`;
    },
    sleep:
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 300000) SELECT COUNT(*) FROM n;",
  },
];

const postgresUrl = Bun.env.RATCHET_TEST_POSTGRES_URL;
if (postgresUrl) {
  targets.push({
    name: "postgres",
    dialect: "postgres",
    url: () => postgresUrl,
    reset: () =>
      withSql(postgresUrl, (sql) =>
        sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;").simple(),
      ),
    sleep: "SELECT pg_sleep(0.2);",
  });
}

for (const [name, url] of [
  ["mysql", Bun.env.RATCHET_TEST_MYSQL_URL],
  ["mariadb", Bun.env.RATCHET_TEST_MARIADB_URL],
] as const) {
  if (!url) {
    continue;
  }

  targets.push({
    name,
    dialect: "mysql",
    url: () => url,
    reset: () =>
      withSql(url, async (sql) => {
        const reserved = await sql.reserve();
        try {
          const tables = await reserved<{ name: string }[]>`
            SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()
          `;
          await reserved`SET FOREIGN_KEY_CHECKS = 0`;
          for (const table of tables) {
            await reserved`DROP TABLE ${reserved(table.name)}`;
          }
          await reserved`SET FOREIGN_KEY_CHECKS = 1`;
        } finally {
          reserved.release();
        }
      }),
    sleep: "SELECT SLEEP(0.2);",
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

for (const target of targets) {
  describe(target.name, () => {
    let sql: SQL;
    let directory: string;

    beforeEach(async () => {
      await target.reset();
      sql = new SQL(target.url());
      directory = await tempDirectory();
    });

    afterEach(async () => {
      await sql.close();
    });

    test("applies pending migrations in version order and skips them on rerun", async () => {
      await writeMigrations(directory, {
        "10_second.sql": "INSERT INTO widgets (id) VALUES (2);",
        "9_first.sql":
          "CREATE TABLE widgets (id INT PRIMARY KEY);\nINSERT INTO widgets (id) VALUES (1);",
      });

      const first = await migrate(sql, directory);
      expect(first.applied).toEqual(["9_first.sql", "10_second.sql"]);
      expect(first.alreadyApplied).toEqual([]);

      const second = await migrate(sql, directory);
      expect(second.applied).toEqual([]);
      expect(second.alreadyApplied).toEqual(["9_first.sql", "10_second.sql"]);

      expect(await ids(sql, "widgets")).toEqual([1, 2]);
      expect(await recordNames(sql)).toEqual(["10_second.sql", "9_first.sql"]);
    });

    test("creates the metadata table under a custom name", async () => {
      await writeMigrations(directory, { "0001_init.sql": "CREATE TABLE widgets (id INT);" });

      const result = await migrate(sql, directory, { table: "schema_history" });

      expect(result.applied).toEqual(["0001_init.sql"]);
      expect(await recordNames(sql, "schema_history")).toEqual(["0001_init.sql"]);
    });

    test("records blank and comment-only files as no-op migrations", async () => {
      await writeMigrations(directory, {
        "0001_blank.sql": "",
        "0002_whitespace.sql": "  \n\n",
        "0003_comments.sql": "-- nothing to do yet\n/* still nothing */\n",
      });

      const result = await migrate(sql, directory);

      expect(result.applied).toEqual([
        "0001_blank.sql",
        "0002_whitespace.sql",
        "0003_comments.sql",
      ]);
    });

    test("rolls back a failing migration, keeps earlier ones, and reports which file failed", async () => {
      await writeMigrations(directory, {
        "0001_table.sql": "CREATE TABLE widgets (id INT PRIMARY KEY);",
        // The failure is in a later statement and only detectable at runtime.
        "0002_dupe.sql":
          "INSERT INTO widgets (id) VALUES (10);\nINSERT INTO widgets (id) VALUES (10);\nINSERT INTO widgets (id) VALUES (11);",
        "0003_never.sql": "INSERT INTO widgets (id) VALUES (30);",
      });

      const error = await migrate(sql, directory).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MigrationError);
      const failure = error as MigrationError;
      expect(failure.migration).toBe("0002_dupe.sql");
      expect(failure.applied).toEqual(["0001_table.sql"]);
      expect(failure.message).toContain("0002_dupe.sql");
      expect(failure.cause).toBeInstanceOf(SQL.SQLError);
      expect(await ids(sql, "widgets")).toEqual([]);
      expect(await recordNames(sql)).toEqual(["0001_table.sql"]);

      // The failed file was never recorded, so it can be fixed and retried.
      await Bun.write(join(directory, "0002_dupe.sql"), "INSERT INTO widgets (id) VALUES (10);");
      const retry = await migrate(sql, directory);
      expect(retry.applied).toEqual(["0002_dupe.sql", "0003_never.sql"]);
      expect(await ids(sql, "widgets")).toEqual([10, 30]);
    });

    test("rejects a changed applied migration before running anything", async () => {
      await writeMigrations(directory, { "0001_table.sql": "CREATE TABLE widgets (id INT);" });
      await migrate(sql, directory);

      await writeMigrations(directory, {
        "0001_table.sql": "CREATE TABLE widgets (id INT, name TEXT);",
        "0002_insert.sql": "INSERT INTO widgets (id) VALUES (1);",
      });

      await expectRatchetError(migrate(sql, directory), ["checksum mismatch", "0001_table.sql"]);
      expect(await ids(sql, "widgets")).toEqual([]);
    });

    test("treats CRLF line endings and a BOM as the same migration", async () => {
      await writeMigrations(directory, {
        "0001_table.sql": "CREATE TABLE widgets (id INT);\nINSERT INTO widgets (id) VALUES (1);\n",
      });
      await migrate(sql, directory);

      await writeMigrations(directory, {
        "0001_table.sql":
          "﻿CREATE TABLE widgets (id INT);\r\nINSERT INTO widgets (id) VALUES (1);\r\n",
      });

      const result = await migrate(sql, directory);
      expect(result.alreadyApplied).toEqual(["0001_table.sql"]);
    });

    test("accepts checksums recorded by ratchet 0.3 over raw file bytes", async () => {
      const raw = "CREATE TABLE widgets (id INT);\r\n";
      await writeMigrations(directory, {
        "0000_ratchet.sql": `CREATE TABLE IF NOT EXISTS ratchet_migrations (
  name VARCHAR(255) PRIMARY KEY,
  checksum VARCHAR(64) NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`,
        "0001_table.sql": raw,
      });

      // Simulate a database migrated by 0.3: its bootstrap file created the
      // table and checksums were taken over the bytes on disk.
      await sql.unsafe(await Bun.file(join(directory, "0000_ratchet.sql")).text());
      await sql.unsafe("CREATE TABLE widgets (id INT)");
      for (const name of ["0000_ratchet.sql", "0001_table.sql"]) {
        const checksum = new Bun.CryptoHasher("sha256")
          .update(await Bun.file(join(directory, name)).text())
          .digest("hex");
        await sql`INSERT INTO ratchet_migrations (name, checksum) VALUES (${name}, ${checksum})`;
      }

      await writeMigrations(directory, {
        "0002_insert.sql": "INSERT INTO widgets (id) VALUES (1);",
      });
      const result = await migrate(sql, directory);

      expect(result.alreadyApplied).toEqual(["0000_ratchet.sql", "0001_table.sql"]);
      expect(result.applied).toEqual(["0002_insert.sql"]);
    });

    test("runs a legacy 0000_ratchet.sql bootstrap file on a fresh database", async () => {
      await writeMigrations(directory, {
        "0000_ratchet.sql":
          "CREATE TABLE IF NOT EXISTS ratchet_migrations (\n  name VARCHAR(255) PRIMARY KEY,\n  checksum VARCHAR(64) NOT NULL,\n  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n",
        "0001_table.sql": "CREATE TABLE widgets (id INT);",
      });

      const result = await migrate(sql, directory);
      expect(result.applied).toEqual(["0000_ratchet.sql", "0001_table.sql"]);
    });

    test("rejects an applied migration whose file is missing", async () => {
      await writeMigrations(directory, {
        "0001_table.sql": "CREATE TABLE widgets (id INT);",
        "0002_insert.sql": "INSERT INTO widgets (id) VALUES (1);",
      });
      await migrate(sql, directory);
      await rm(join(directory, "0001_table.sql"));

      await expectRatchetError(migrate(sql, directory), ["file missing", "0001_table.sql"]);
    });

    test("rejects a pending migration that sorts before an applied one", async () => {
      await writeMigrations(directory, { "0002_table.sql": "CREATE TABLE widgets (id INT);" });
      await migrate(sql, directory);
      await writeMigrations(directory, { "0001_late.sql": "CREATE TABLE late (id INT);" });

      await expectRatchetError(migrate(sql, directory), [
        "sorts before applied migration 0002_table.sql",
        "0001_late.sql",
      ]);
    });

    test("serializes concurrent migrators so each file runs exactly once", async () => {
      const files: Record<string, string> = {
        "0001_table.sql": `CREATE TABLE hits (name VARCHAR(50) NOT NULL);\n${target.sleep}`,
      };
      for (let index = 2; index <= 8; index += 1) {
        const name = `000${index}_hit.sql`;
        files[name] = `INSERT INTO hits (name) VALUES ('${name}');`;
      }
      await writeMigrations(directory, files);

      const others = [new SQL(target.url()), new SQL(target.url()), new SQL(target.url())];
      try {
        const results = await Promise.all(
          [sql, ...others].map((connection) => migrate(connection, directory)),
        );

        const applied = results.flatMap((result) => result.applied).sort();
        expect(applied).toEqual(Object.keys(files).sort());
        for (const result of results) {
          expect([...result.applied, ...result.alreadyApplied].sort()).toEqual(
            Object.keys(files).sort(),
          );
        }

        const hits = await sql<{ count: number }[]>`SELECT COUNT(*) AS count FROM hits`;
        expect(Number(hits[0]?.count)).toBe(7);
      } finally {
        await Promise.all(others.map((connection) => connection.close()));
      }
    });

    test("status is read-only and reports every problem migrate would refuse", async () => {
      await writeMigrations(directory, {
        "0002_table.sql": "CREATE TABLE widgets (id INT);",
        "0003_changed.sql": "SELECT 1;",
        "0004_gone.sql": "SELECT 1;",
      });

      const fresh = await getMigrationStatus(sql, directory);
      expect(fresh.records).toEqual([]);
      expect(fresh.pending.map((file) => file.name)).toEqual([
        "0002_table.sql",
        "0003_changed.sql",
        "0004_gone.sql",
      ]);
      // Bun's expect().rejects never executes a lazy SQL query, so await it directly.
      const read = await sql`SELECT name FROM ratchet_migrations`.then(
        () => "read",
        () => "missing",
      );
      expect(read).toBe("missing");

      await migrate(sql, directory);
      await writeMigrations(directory, {
        "0001_late.sql": "SELECT 1;",
        "0003_changed.sql": "SELECT 2;",
        "0005_next.sql": "SELECT 1;",
      });
      await rm(join(directory, "0004_gone.sql"));

      const status = await getMigrationStatus(sql, directory);
      expect(status.records.map((record) => record.name)).toEqual([
        "0002_table.sql",
        "0003_changed.sql",
        "0004_gone.sql",
      ]);
      expect(status.pending.map((file) => file.name)).toEqual(["0001_late.sql", "0005_next.sql"]);
      expect(status.outOfOrder.map((file) => file.name)).toEqual(["0001_late.sql"]);
      expect(status.changed.map((change) => change.name)).toEqual(["0003_changed.sql"]);
      expect(status.missing.map((record) => record.name)).toEqual(["0004_gone.sql"]);
      expect(Object.keys(status.pending[0]!).sort()).toEqual(["checksum", "name", "path"]);
      for (const record of status.records) {
        expect(Object.keys(record).sort()).toEqual(["appliedAt", "checksum", "name"]);
        expect(record.appliedAt).toBeInstanceOf(Date);
        expect(Math.abs(record.appliedAt.getTime() - Date.now())).toBeLessThan(60 * 60 * 1000);
      }
    });

    if (target.dialect === "sqlite") {
      test("serializes migrators running in separate processes", async () => {
        const files: Record<string, string> = {
          "0001_table.sql": `CREATE TABLE hits (name VARCHAR(50) NOT NULL);\n${target.sleep}`,
        };
        for (let index = 2; index <= 8; index += 1) {
          const name = `000${index}_hit.sql`;
          files[name] = `INSERT INTO hits (name) VALUES ('${name}');`;
        }
        await writeMigrations(directory, files);

        const script = `
          import { SQL } from "bun";
          import { migrate } from ${JSON.stringify(join(import.meta.dir, "migrator.ts"))};
          const sql = new SQL(${JSON.stringify(target.url())});
          const result = await migrate(sql, ${JSON.stringify(directory)});
          await sql.close();
          console.log(JSON.stringify(result.applied));
        `;
        const children = Array.from({ length: 4 }, () =>
          Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }),
        );
        const outputs = await Promise.all(
          children.map(async (child) => ({
            code: await child.exited,
            stdout: await new Response(child.stdout).text(),
            stderr: await new Response(child.stderr).text(),
          })),
        );

        for (const output of outputs) {
          expect(output.stderr).toBe("");
          expect(output.code).toBe(0);
        }
        const applied = outputs.flatMap((output) => JSON.parse(output.stdout) as string[]).sort();
        expect(applied).toEqual(Object.keys(files).sort());

        const hits = await sql<{ count: number }[]>`SELECT COUNT(*) AS count FROM hits`;
        expect(Number(hits[0]?.count)).toBe(7);
      });

      test("runs trigger bodies containing semicolons", async () => {
        await writeMigrations(directory, {
          "0001_trigger.sql": `CREATE TABLE widgets (id INT PRIMARY KEY);
CREATE TABLE audit (id INT);
CREATE TRIGGER widgets_audit AFTER INSERT ON widgets
BEGIN
  INSERT INTO audit (id) VALUES (new.id);
  INSERT INTO audit (id) VALUES (new.id + 100);
END;
INSERT INTO widgets (id) VALUES (1);`,
        });

        await migrate(sql, directory);
        expect(await ids(sql, "audit")).toEqual([1, 101]);
      });
    }

    if (target.dialect === "postgres") {
      test("passes dollar-quoted function bodies through untouched", async () => {
        await writeMigrations(directory, {
          "0001_function.sql": `CREATE TABLE widgets (id INT);
CREATE FUNCTION add_widget(n INT) RETURNS void AS $$
BEGIN
  INSERT INTO widgets (id) VALUES (n);
  INSERT INTO widgets (id) VALUES (n + 100);
END;
$$ LANGUAGE plpgsql;
SELECT add_widget(1);`,
        });

        await migrate(sql, directory);
        expect(await ids(sql, "widgets")).toEqual([1, 101]);
      });
    }

    if (target.dialect === "mysql") {
      test("runs compound trigger bodies without DELIMITER", async () => {
        await writeMigrations(directory, {
          "0001_trigger.sql": `CREATE TABLE widgets (id INT PRIMARY KEY);
CREATE TABLE audit (id INT);
CREATE TRIGGER widgets_audit AFTER INSERT ON widgets FOR EACH ROW
BEGIN
  INSERT INTO audit (id) VALUES (NEW.id);
  INSERT INTO audit (id) VALUES (NEW.id + 100);
END;
INSERT INTO widgets (id) VALUES (1);`,
        });

        await migrate(sql, directory);
        expect(await ids(sql, "audit")).toEqual([1, 101]);
      });

      test("mentions implicit DDL commits when a MySQL migration fails", async () => {
        await writeMigrations(directory, {
          "0001_bad.sql": "CREATE TABLE widgets (id INT);\nSELECT * FROM nope;",
        });

        await expectRatchetError(migrate(sql, directory), ["0001_bad.sql", "implicitly"]);
      });
    }
  });
}

describe("migration files", () => {
  test("rejects .sql files without a version prefix", async () => {
    const directory = await tempDirectory();
    await writeMigrations(directory, { "0001_ok.sql": "", "seed.sql": "" });

    await withSql("sqlite://:memory:", (sql) =>
      expectRatchetError(migrate(sql, directory), ["invalid migration file name: seed.sql"]),
    );
  });

  test("rejects duplicate versions", async () => {
    const directory = await tempDirectory();
    await writeMigrations(directory, {
      "0001_a.sql": "",
      "0002_b.sql": "",
      "002_c.sql": "",
      "0003_d.sql": "",
    });

    await withSql("sqlite://:memory:", (sql) =>
      expectRatchetError(migrate(sql, directory), [
        "duplicate migration version: 0002_b.sql, 002_c.sql",
      ]),
    );
  });

  test("ignores non-sql files and subdirectories", async () => {
    const directory = await tempDirectory();
    await writeMigrations(directory, {
      "0001_a.sql": "",
      "README.md": "",
      "nested/0002_b.sql": "",
    });

    const result = await withSql("sqlite://:memory:", (sql) => migrate(sql, directory));
    expect(result.applied).toEqual(["0001_a.sql"]);
  });

  test("explains a missing migration directory", async () => {
    const directory = join(await tempDirectory(), "missing");

    await withSql("sqlite://:memory:", (sql) =>
      expectRatchetError(migrate(sql, directory), [
        "migration directory not found",
        "ratchet create <name>",
      ]),
    );
  });

  test("rejects invalid metadata table names", () => {
    expect(() => normalizeTable("Foo")).toThrow(RatchetError);
    expect(() => normalizeTable("public.migrations")).toThrow(RatchetError);
    expect(normalizeTable("schema_history")).toBe("schema_history");
  });
});

describe("createMigrationFile", () => {
  test("numbers after the highest existing version", async () => {
    const directory = join(await tempDirectory(), "migrations");

    const first = await createMigrationFile(directory, "Add Users");
    await writeMigrations(directory, { "0041_manual.sql": "" });
    const next = await createMigrationFile(directory, "add posts");

    expect(first.name).toBe("0001_add_users.sql");
    expect(next.name).toBe("0042_add_posts.sql");
    expect(await Bun.file(next.path).text()).toBe("");
  });

  test("rejects names with nothing usable in them", async () => {
    const directory = await tempDirectory();

    await expectRatchetError(createMigrationFile(directory, "!!!"), ["invalid migration name"]);
  });

  test("slugifies names", () => {
    expect(slugifyMigrationName("  Add users' emails!  ")).toBe("add_users_emails");
  });
});

async function writeMigrations(directory: string, files: Record<string, string>): Promise<void> {
  await Promise.all(
    Object.entries(files).map(([name, contents]) => Bun.write(join(directory, name), contents)),
  );
}

async function ids(sql: SQL, table: string): Promise<number[]> {
  const rows = await sql<{ id: number }[]>`SELECT id FROM ${sql(table)} ORDER BY id`;
  return rows.map((row) => Number(row.id));
}

async function recordNames(sql: SQL, table = "ratchet_migrations"): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM ${sql(table)}`;
  return rows.map((row) => row.name).sort();
}

async function withSql<T>(url: string, fn: (sql: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(url);
  try {
    return await fn(sql);
  } finally {
    await sql.close();
  }
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ratchet-"));
  tempDirectories.push(directory);
  return directory;
}

async function expectRatchetError(promise: Promise<unknown>, fragments: string[]): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(RatchetError);
  for (const fragment of fragments) {
    expect((error as Error).message).toContain(fragment);
  }
}

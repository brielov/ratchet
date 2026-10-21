import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliConfig } from "./cli.ts";

const CLI = join(import.meta.dir, "cli.ts");
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("flags override environment variables, which override defaults", () => {
  const saved = { ...Bun.env };
  try {
    Bun.env.RATCHET_DIR = "";
    delete Bun.env.RATCHET_TABLE;
    delete Bun.env.RATCHET_DATABASE_URL;
    expect(parseCliConfig(["up"])).toMatchObject({
      command: "up",
      directory: "migrations",
      table: "ratchet_migrations",
      url: undefined,
    });

    Bun.env.RATCHET_DIR = "env-dir";
    Bun.env.RATCHET_TABLE = "env_table";
    Bun.env.RATCHET_DATABASE_URL = "sqlite://env.db";
    expect(parseCliConfig(["up"])).toMatchObject({
      directory: "env-dir",
      table: "env_table",
      url: "sqlite://env.db",
    });

    expect(
      parseCliConfig([
        "create",
        "add",
        "users",
        "-d",
        "flag-dir",
        "-t",
        "flag_table",
        "-u",
        "sqlite://flag.db",
      ]),
    ).toMatchObject({
      command: "create",
      title: "add users",
      directory: "flag-dir",
      table: "flag_table",
      url: "sqlite://flag.db",
    });
  } finally {
    for (const key of ["RATCHET_DIR", "RATCHET_TABLE", "RATCHET_DATABASE_URL"]) {
      if (saved[key] === undefined) {
        delete Bun.env[key];
      } else {
        Bun.env[key] = saved[key];
      }
    }
  }
});

test("create, up, and status work end to end", async () => {
  const root = await tempDirectory();
  const dir = join(root, "migrations");
  const url = `sqlite://${join(root, "app.db")}`;

  const created = await ratchet(["create", "Add", "Widgets", "--dir", dir]);
  expect(created).toMatchObject({
    code: 0,
    stdout: `created ${join(dir, "0001_add_widgets.sql")}\n`,
  });
  await Bun.write(join(dir, "0001_add_widgets.sql"), "CREATE TABLE widgets (id INT);");

  const pending = await ratchet(["status", "--dir", dir, "--url", url]);
  expect(pending.code).toBe(0);
  expect(pending.stdout).toContain("pending 0001_add_widgets.sql");

  const up = await ratchet(["up", "--dir", dir, "--url", url]);
  expect(up).toMatchObject({ code: 0, stdout: "applied 1 migration(s)\n  0001_add_widgets.sql\n" });

  const again = await ratchet(["up", "--dir", dir, "--url", url]);
  expect(again).toMatchObject({ code: 0, stdout: "up to date\n" });

  await Bun.write(join(dir, "0001_add_widgets.sql"), "CREATE TABLE widgets (id INT, name TEXT);");
  const changed = await ratchet(["status", "--dir", dir, "--url", url]);
  expect(changed.code).toBe(1);
  expect(changed.stdout).toContain("changed 0001_add_widgets.sql");

  const refused = await ratchet(["up", "--dir", dir, "--url", url]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("checksum mismatch");
});

test("up reports what was applied before a failing migration", async () => {
  const root = await tempDirectory();
  const dir = join(root, "migrations");
  const url = `sqlite://${join(root, "app.db")}`;
  await Bun.write(join(dir, "0001_ok.sql"), "CREATE TABLE widgets (id INT);");
  await Bun.write(join(dir, "0002_bad.sql"), "SELECT * FROM nope;");

  const result = await ratchet(["up", "--dir", dir, "--url", url]);

  expect(result.code).toBe(1);
  expect(result.stderr).toBe(
    "applied 1 migration(s) before the failure\n  0001_ok.sql\nmigration 0002_bad.sql failed: no such table: nope\n",
  );
});

test("create requires a name", async () => {
  const result = await ratchet(["create", "--dir", await tempDirectory()]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("needs a migration name");
});

test("removed commands explain what replaced them", async () => {
  const init = await ratchet(["init"]);
  expect(init.code).toBe(1);
  expect(init.stderr).toContain("created automatically");

  const drop = await ratchet(["drop"]);
  expect(drop.code).toBe(1);
  expect(drop.stderr).toContain("ratchet drop was removed");
});

test("unknown commands and bad flags exit non-zero", async () => {
  const unknown = await ratchet(["frobnicate"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("unknown command: frobnicate");

  const badFlag = await ratchet(["up", "--nope"]);
  expect(badFlag.code).toBe(1);
});

async function ratchet(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, RATCHET_DIR: "", RATCHET_TABLE: "", RATCHET_DATABASE_URL: "" },
  });

  return {
    code: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ratchet-cli-"));
  tempDirectories.push(directory);
  return directory;
}

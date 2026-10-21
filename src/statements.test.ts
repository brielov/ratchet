import { expect, test } from "bun:test";
import { containsSql, splitSqliteStatements } from "./statements.ts";

test("splits plain statements and drops blank ones", () => {
  expect(splitSqliteStatements("CREATE TABLE a (id INT);\n;;\nINSERT INTO a VALUES (1);")).toEqual([
    "CREATE TABLE a (id INT);",
    "INSERT INTO a VALUES (1);",
  ]);
});

test("keeps a final statement without a semicolon", () => {
  expect(splitSqliteStatements("SELECT 1;\nSELECT 2\n\n")).toEqual(["SELECT 1;", "SELECT 2"]);
});

test("ignores semicolons inside strings, identifiers, and comments", () => {
  const sql = [
    "INSERT INTO a VALUES ('x;y', 'it''s; fine');",
    'CREATE TABLE "semi;colon" (`b;` INT, [c;] INT);',
    "-- a comment; with a semicolon",
    "/* block; comment */ SELECT 1;",
  ].join("\n");

  expect(splitSqliteStatements(sql)).toEqual([
    "INSERT INTO a VALUES ('x;y', 'it''s; fine');",
    'CREATE TABLE "semi;colon" (`b;` INT, [c;] INT);',
    "SELECT 1;",
  ]);
});

test("keeps CREATE TRIGGER bodies together", () => {
  const trigger = `CREATE TEMP TRIGGER IF NOT EXISTS audit AFTER INSERT ON a
BEGIN
  INSERT INTO log VALUES (new.id);
  UPDATE counts SET n = CASE WHEN n IS NULL THEN 1 ELSE n + 1 END;
END;`;

  expect(splitSqliteStatements(`CREATE TABLE a (id INT);\n${trigger}\nSELECT 1;`)).toEqual([
    "CREATE TABLE a (id INT);",
    trigger,
    "SELECT 1;",
  ]);
});

test("keywords are only recognized as whole words", () => {
  expect(splitSqliteStatements("CREATE TABLE triggers (ended INT);SELECT 1;")).toEqual([
    "CREATE TABLE triggers (ended INT);",
    "SELECT 1;",
  ]);
});

test("passes unterminated input through for SQLite to reject", () => {
  expect(splitSqliteStatements("SELECT 1; SELECT 'oops; SELECT 2;")).toEqual([
    "SELECT 1;",
    "SELECT 'oops; SELECT 2;",
  ]);
  expect(splitSqliteStatements("SELECT 1; /* never closed; SELECT 2;")).toEqual([
    "SELECT 1;",
    "/* never closed; SELECT 2;",
  ]);
});

test("containsSql ignores whitespace, comments, and bare semicolons", () => {
  expect(containsSql("")).toBe(false);
  expect(containsSql("  \n\t")).toBe(false);
  expect(containsSql("-- nothing here\n/* or here */ ;\n-- end")).toBe(false);
  expect(containsSql("-- comment\nSELECT 1")).toBe(true);
});

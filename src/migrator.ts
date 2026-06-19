import { Glob, type SQL } from "bun";
import { basename, join } from "node:path";
import { mkdir, stat } from "node:fs/promises";

export const DEFAULT_DIRECTORY = "migrations";
export const DEFAULT_TABLE = "ratchet_migrations";
export const INIT_MIGRATION_NAME = "0000_ratchet.sql";

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;
const MIGRATION_NUMBER_PATTERN = /^(\d+)_.*\.sql$/;
const MIGRATION_FILE_PATTERN = /^\d+_(.+)\.sql$/;
const BOOTSTRAP_TABLE_PATTERN = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)/i;

const ADJECTIVES = [
  "able",
  "brave",
  "calm",
  "clean",
  "direct",
  "fresh",
  "plain",
  "quick",
  "solid",
  "steady",
] as const;

const VERBS = [
  "building",
  "checking",
  "drafting",
  "growing",
  "moving",
  "planning",
  "shaping",
  "sorting",
  "testing",
  "working",
] as const;

const NOUNS = [
  "anchor",
  "atlas",
  "bridge",
  "candle",
  "compass",
  "harbor",
  "index",
  "kernel",
  "ledger",
  "signal",
] as const;

export type MigrateOptions = {
  table?: string;
};

export type MigrationFile = {
  name: string;
  path: string;
  checksum: string;
  empty: boolean;
};

export type MigrationRecord = {
  name: string;
  checksum: string;
  applied_at?: Date | string;
};

export type ChangedMigration = {
  name: string;
  expected: string;
  actual: string;
};

export type MigrateResult = {
  directory: string;
  table: string;
  applied: string[];
  skipped: string[];
};

export type MigrationStatus = {
  directory: string;
  table: string;
  tableOk: boolean;
  tableError?: string;
  files: MigrationFile[];
  applied: MigrationRecord[];
  pending: MigrationFile[];
  changed: ChangedMigration[];
  missing: MigrationRecord[];
};

export type InitMigrationResult = {
  directory: string;
  path: string;
  table: string;
};

export type CreateMigrationResult = {
  directory: string;
  path: string;
  name: string;
};

export class RatchetError extends Error {
  override name = "RatchetError";
}

export async function migrate(
  sql: SQL,
  directory: string,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const table = normalizeTable(options.table);
  const files = await readMigrationFiles(directory);

  await assertBootstrapTableMatches(files, table);

  let records: MigrationRecord[];

  try {
    records = await readMigrationRecords(sql, table);
  } catch (error) {
    if (files[0]?.name !== INIT_MIGRATION_NAME) {
      throw tableReadError(table, directory, error);
    }

    return applyPendingMigrations(sql, table, directory, files, []);
  }

  return applyPendingMigrations(sql, table, directory, files, records);
}

export async function getMigrationStatus(
  sql: SQL,
  directory: string,
  options: MigrateOptions = {},
): Promise<MigrationStatus> {
  const table = normalizeTable(options.table);
  const files = await readMigrationFiles(directory);

  try {
    const records = await readMigrationRecords(sql, table);
    return buildStatus(directory, table, files, records, true);
  } catch (error) {
    return buildStatus(directory, table, files, [], false, String(error));
  }
}

export async function initMigrationDirectory(
  directory = DEFAULT_DIRECTORY,
  table = DEFAULT_TABLE,
): Promise<InitMigrationResult> {
  const normalizedTable = normalizeTable(table);
  await mkdir(directory, { recursive: true });

  const path = join(directory, INIT_MIGRATION_NAME);
  if (await Bun.file(path).exists()) {
    throw initMigrationExistsError(path, directory);
  }

  await Bun.write(path, buildInitSql(normalizedTable));

  return {
    directory,
    path,
    table: normalizedTable,
  };
}

export async function createMigrationFile(
  directory = DEFAULT_DIRECTORY,
  title?: string,
): Promise<CreateMigrationResult> {
  await mkdir(directory, { recursive: true });

  const files = await readMigrationFileNames(directory);
  const nextNumber = nextMigrationNumber(files);
  const slug = title === undefined ? uniqueRandomMigrationName(files) : slugifyMigrationName(title);
  const name = `${String(nextNumber).padStart(4, "0")}_${slug}.sql`;
  const path = join(directory, name);

  if (await Bun.file(path).exists()) {
    throw createMigrationExistsError(path);
  }

  await Bun.write(path, "");

  return {
    directory,
    path,
    name,
  };
}

export function buildInitSql(table = DEFAULT_TABLE): string {
  const normalizedTable = normalizeTable(table);

  return `CREATE TABLE IF NOT EXISTS ${normalizedTable} (
  name VARCHAR(255) PRIMARY KEY,
  checksum VARCHAR(64) NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;
}

export function slugifyMigrationName(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return slug || randomMigrationName();
}

export function normalizeTable(table = DEFAULT_TABLE): string {
  if (!IDENTIFIER_PATTERN.test(table)) {
    throw new RatchetError(
      `invalid migration table "${table}"; use a simple unquoted SQL identifier like "${DEFAULT_TABLE}". Table names must start with a lowercase letter or underscore and contain only lowercase letters, numbers, and underscores.`,
    );
  }

  return table;
}

async function applyPendingMigrations(
  sql: SQL,
  table: string,
  directory: string,
  files: MigrationFile[],
  records: MigrationRecord[],
): Promise<MigrateResult> {
  const filesByName = new Map(files.map((file) => [file.name, file]));
  const appliedByName = new Map(records.map((record) => [record.name, record]));
  const latestAppliedName = latestMigrationRecordName(records);
  const skipped: string[] = [];
  const pending: MigrationFile[] = [];
  const changed: ChangedMigration[] = [];
  const outOfOrder: MigrationFile[] = [];
  const missing = records.filter((record) => !filesByName.has(record.name));

  if (missing.length > 0) {
    throw missingMigrationFileError(directory, missing);
  }

  for (const file of files) {
    const record = appliedByName.get(file.name);

    if (!record) {
      pending.push(file);
      if (latestAppliedName !== undefined && file.name.localeCompare(latestAppliedName) < 0) {
        outOfOrder.push(file);
      }
      continue;
    }

    if (record.checksum !== file.checksum) {
      changed.push({
        name: file.name,
        expected: record.checksum,
        actual: file.checksum,
      });
      continue;
    }

    skipped.push(file.name);
  }

  if (changed.length > 0) {
    throw checksumError(changed);
  }

  if (outOfOrder.length > 0 && latestAppliedName !== undefined) {
    throw outOfOrderMigrationError(outOfOrder, latestAppliedName);
  }

  if (pending.length > 0) {
    await sql.begin(async (tx) => {
      for (const file of pending) {
        if (!file.empty) {
          await tx.file(file.path);
        }
        await tx`
          INSERT INTO ${tx(table)} (name, checksum)
          VALUES (${file.name}, ${file.checksum})
        `;
      }
    });
  }

  return {
    directory,
    table,
    applied: pending.map((file) => file.name),
    skipped,
  };
}

function buildStatus(
  directory: string,
  table: string,
  files: MigrationFile[],
  records: MigrationRecord[],
  tableOk: boolean,
  tableError?: string,
): MigrationStatus {
  const filesByName = new Map(files.map((file) => [file.name, file]));
  const recordsByName = new Map(records.map((record) => [record.name, record]));
  const pending: MigrationFile[] = [];
  const changed: ChangedMigration[] = [];
  const missing: MigrationRecord[] = [];

  for (const file of files) {
    const record = recordsByName.get(file.name);

    if (!record) {
      pending.push(file);
      continue;
    }

    if (record.checksum !== file.checksum) {
      changed.push({
        name: file.name,
        expected: record.checksum,
        actual: file.checksum,
      });
    }
  }

  for (const record of records) {
    if (!filesByName.has(record.name)) {
      missing.push(record);
    }
  }

  return {
    directory,
    table,
    tableOk,
    tableError,
    files,
    applied: records,
    pending,
    changed,
    missing,
  };
}

async function readMigrationRecords(sql: SQL, table: string): Promise<MigrationRecord[]> {
  return await sql<MigrationRecord[]>`
    SELECT name, checksum, applied_at
    FROM ${sql(table)}
    ORDER BY name
  `;
}

async function readMigrationFiles(directory: string): Promise<MigrationFile[]> {
  await assertDirectory(directory);

  const names = await readMigrationFileNames(directory);
  const files = await Promise.all(
    names.map(async (name) => {
      const path = join(directory, name);
      const contents = await Bun.file(path).text();

      return {
        name,
        path,
        checksum: sha256(contents),
        empty: contents.trim().length === 0,
      };
    }),
  );

  return files.sort(compareMigrationNames);
}

async function readMigrationFileNames(directory: string): Promise<string[]> {
  await assertDirectory(directory);

  const glob = new Glob("*.sql");
  const names: string[] = [];

  for await (const path of glob.scan({ cwd: directory, onlyFiles: true })) {
    names.push(basename(path));
  }

  return names.sort((left, right) => left.localeCompare(right));
}

async function assertDirectory(directory: string): Promise<void> {
  let info;

  try {
    info = await stat(directory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new RatchetError(
        `migration directory not found: ${directory}; run \`ratchet init --dir ${directory}\` or pass the directory that contains your *.sql migrations with --dir.`,
      );
    }

    throw error;
  }

  if (!info.isDirectory()) {
    throw new RatchetError(
      `${directory} is not a directory; pass the directory that contains your *.sql migrations with --dir, or remove this path and run \`ratchet init --dir ${directory}\`.`,
    );
  }
}

async function assertBootstrapTableMatches(
  files: MigrationFile[],
  table: string,
): Promise<void> {
  const bootstrap = files[0];
  if (bootstrap?.name !== INIT_MIGRATION_NAME) {
    return;
  }

  const contents = await Bun.file(bootstrap.path).text();
  const match = BOOTSTRAP_TABLE_PATTERN.exec(contents);
  if (!match) {
    return;
  }

  const bootstrapTable = match[1];
  if (bootstrapTable === table) {
    return;
  }

  throw new RatchetError(
    `bootstrap migration ${bootstrap.name} creates table "${bootstrapTable}", but the configured table is "${table}". Pass --table ${bootstrapTable} (or set RATCHET_TABLE), or recreate the migration directory with the desired table.`,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sha256(input: string): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex");
}

function checksumError(changed: ChangedMigration[]): RatchetError {
  const names = changed.map((change) => change.name).join(", ");
  return new RatchetError(
    `migration checksum mismatch: ${names}. Applied migration files are immutable; restore the file contents that were originally applied, or create a new migration for the new change.`,
  );
}

function missingMigrationFileError(directory: string, missing: MigrationRecord[]): RatchetError {
  const names = missing.map((record) => record.name).join(", ");
  return new RatchetError(
    `applied migration file missing: ${names}. Restore the missing file(s) to ${directory} from version control before running migrations. If this database is disposable, recreate it and run migrations from scratch.`,
  );
}

function outOfOrderMigrationError(
  outOfOrder: MigrationFile[],
  latestAppliedName: string,
): RatchetError {
  const names = outOfOrder.map((file) => file.name).join(", ");
  return new RatchetError(
    `pending migration sorts before applied migration ${latestAppliedName}: ${names}. Forward-only migrations must run in lexicographic order; rename the pending file(s) with a prefix after ${latestAppliedName}, or rebuild this database before applying them.`,
  );
}

function tableReadError(table: string, directory: string, cause: unknown): RatchetError {
  const error = new RatchetError(
    `could not read migration table "${table}". Ratchet also did not find ${INIT_MIGRATION_NAME} as the first migration in ${directory}, so it cannot bootstrap the metadata table. Run \`ratchet init --dir ${directory} --table ${table}\`, or check --dir, --table, and --url if this database was already initialized.`,
  );
  error.cause = cause;
  return error;
}

function initMigrationExistsError(path: string, directory: string): RatchetError {
  return new RatchetError(
    `${path} already exists; this migration directory is already initialized. Use \`ratchet create <name> --dir ${directory}\` to add another migration.`,
  );
}

function createMigrationExistsError(path: string): RatchetError {
  return new RatchetError(
    `${path} already exists; choose a different migration name or remove the existing file before retrying.`,
  );
}

function nextMigrationNumber(names: string[]): number {
  let highest = 0;

  for (const name of names) {
    const match = MIGRATION_NUMBER_PATTERN.exec(name);
    if (!match) {
      continue;
    }

    highest = Math.max(highest, Number(match[1]));
  }

  return highest + 1;
}

function uniqueRandomMigrationName(names: string[]): string {
  const used = new Set(names.map(migrationNameSlug).filter(isDefined));
  const attempts = ADJECTIVES.length * VERBS.length * NOUNS.length;

  for (let index = 0; index < attempts; index += 1) {
    const name = randomMigrationName();
    if (!used.has(name)) {
      return name;
    }
  }

  for (const adjective of ADJECTIVES) {
    for (const verb of VERBS) {
      for (const noun of NOUNS) {
        const name = `${adjective}_${verb}_${noun}`;
        if (!used.has(name)) {
          return name;
        }
      }
    }
  }

  for (let index = names.length + 1; ; index += 1) {
    const name = `migration_${index}`;
    if (!used.has(name)) {
      return name;
    }
  }
}

function migrationNameSlug(name: string): string | undefined {
  return MIGRATION_FILE_PATTERN.exec(name)?.[1];
}

function randomMigrationName(): string {
  const adjective = pick(ADJECTIVES);
  const verb = pick(VERBS);
  const noun = pick(NOUNS);
  return `${adjective}_${verb}_${noun}`;
}

function pick<const T>(items: readonly T[]): T {
  // Caller passes a non-empty `as const` tuple, so the index is always in range.
  return items[Math.floor(Math.random() * items.length)]!;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function latestMigrationRecordName(records: MigrationRecord[]): string | undefined {
  let latest: string | undefined;

  for (const record of records) {
    if (latest === undefined || record.name.localeCompare(latest) > 0) {
      latest = record.name;
    }
  }

  return latest;
}

function compareMigrationNames(left: MigrationFile, right: MigrationFile): number {
  return left.name.localeCompare(right.name);
}

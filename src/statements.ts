// Bun's SQLite adapter silently skips runtime errors raised by any statement
// after the first one in a multi-statement string, so SQLite migrations are
// split and executed one statement at a time. The splitter is a port of
// SQLite's own sqlite3_complete() state machine (src/complete.c), which knows
// that semicolons inside CREATE TRIGGER ... BEGIN ... END do not end the
// statement.

const SEMI = 0;
const WS = 1;
const OTHER = 2;
const EXPLAIN = 3;
const CREATE = 4;
const TEMP = 5;
const TRIGGER = 6;
const END = 7;

type Token =
  | typeof SEMI
  | typeof WS
  | typeof OTHER
  | typeof EXPLAIN
  | typeof CREATE
  | typeof TEMP
  | typeof TRIGGER
  | typeof END;

// States: 0 INVALID, 1 START, 2 NORMAL, 3 EXPLAIN, 4 CREATE, 5 TRIGGER,
// 6 SEMI (inside trigger), 7 END (inside trigger). A statement is complete
// when a semicolon moves the machine to START.
const TRANSITIONS: readonly (readonly number[])[] = [
  /*             SEMI WS OTHER EXPLAIN CREATE TEMP TRIGGER END */
  /* INVALID */ [1, 0, 2, 3, 4, 2, 2, 2],
  /* START   */ [1, 1, 2, 3, 4, 2, 2, 2],
  /* NORMAL  */ [1, 2, 2, 2, 2, 2, 2, 2],
  /* EXPLAIN */ [1, 3, 3, 2, 4, 2, 2, 2],
  /* CREATE  */ [1, 4, 2, 2, 2, 4, 5, 2],
  /* TRIGGER */ [6, 5, 5, 5, 5, 5, 5, 5],
  /* SEMI    */ [6, 6, 5, 5, 5, 5, 5, 7],
  /* END     */ [1, 7, 5, 5, 5, 5, 5, 5],
];

const START = 1;
const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f"]);
const ID_CHAR = /[A-Za-z0-9_$\u0080-￿]/;

const KEYWORDS: ReadonlyMap<string, Token> = new Map([
  ["create", CREATE],
  ["temp", TEMP],
  ["temporary", TEMP],
  ["trigger", TRIGGER],
  ["end", END],
  ["explain", EXPLAIN],
]);

/**
 * Splits a SQLite script into individual statements. Comments and blank
 * statements between statements are dropped; comments inside a statement are
 * kept. Unterminated strings or comments end the scan and are passed through
 * so SQLite reports the syntax error itself.
 */
export function splitSqliteStatements(sql: string): string[] {
  const statements: string[] = [];
  let state = 0;
  let start = -1;
  let index = 0;

  while (index < sql.length) {
    const tokenStart = index;
    const [token, end] = scanToken(sql, index);

    if (token !== WS && token !== SEMI && start === -1) {
      start = tokenStart;
    }

    state = TRANSITIONS[state]![token]!;

    if (token === SEMI && state === START) {
      if (start !== -1) {
        statements.push(sql.slice(start, end));
      }
      start = -1;
    }

    index = end;
  }

  if (start !== -1) {
    const rest = sql.slice(start).trimEnd();
    if (rest.length > 0) {
      statements.push(rest);
    }
  }

  return statements;
}

/** True when the script contains anything other than whitespace and comments. */
export function containsSql(sql: string): boolean {
  let index = 0;

  while (index < sql.length) {
    const [token, end] = scanToken(sql, index);
    if (token !== WS && token !== SEMI) {
      return true;
    }
    index = end;
  }

  return false;
}

function scanToken(sql: string, index: number): [Token, number] {
  const char = sql[index]!;
  const next = sql[index + 1];

  if (char === ";") {
    return [SEMI, index + 1];
  }

  if (WHITESPACE.has(char)) {
    return [WS, index + 1];
  }

  if (char === "-" && next === "-") {
    const newline = sql.indexOf("\n", index + 2);
    return [WS, newline === -1 ? sql.length : newline + 1];
  }

  if (char === "/" && next === "*") {
    const close = sql.indexOf("*/", index + 2);
    return close === -1 ? [OTHER, sql.length] : [WS, close + 2];
  }

  if (char === "'" || char === '"' || char === "`" || char === "[") {
    const close = sql.indexOf(char === "[" ? "]" : char, index + 1);
    return [OTHER, close === -1 ? sql.length : close + 1];
  }

  if (ID_CHAR.test(char)) {
    let end = index + 1;
    while (end < sql.length && ID_CHAR.test(sql[end]!)) {
      end += 1;
    }
    const keyword = KEYWORDS.get(sql.slice(index, end).toLowerCase());
    return [keyword ?? OTHER, end];
  }

  return [OTHER, index + 1];
}

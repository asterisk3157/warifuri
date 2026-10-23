// The ledger's tables, as SQL for node:sqlite.
// The meta table holds schema_version, so later versions can migrate an existing file.
// Add a new entry to MIGRATIONS for each change; never edit an entry that has shipped.

export const SCHEMA_VERSION = 1;

const ENUM_STATE = "('ready','running','needs_human_input','deferred','done','discarded')";
const ENUM_MODE = "('ai_worker','human_with_ai','human')";
const ENUM_SECRECY = "('open','withhold')";

// MIGRATIONS[n] takes the database from version n to version n + 1.
export const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS goals (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    outcome         TEXT,
    due             TEXT,
    due_provisional INTEGER NOT NULL DEFAULT 0 CHECK (due_provisional IN (0, 1)),
    state           TEXT NOT NULL CHECK (state IN ${ENUM_STATE}),
    mode            TEXT NOT NULL CHECK (mode IN ${ENUM_MODE}),
    human_led       INTEGER NOT NULL DEFAULT 0 CHECK (human_led IN (0, 1)),
    area            TEXT,
    secrecy         TEXT NOT NULL DEFAULT 'open' CHECK (secrecy IN ${ENUM_SECRECY}),
    waiting_on      TEXT,
    waiting_for     TEXT,
    result          TEXT,
    reason          TEXT,
    defer_until     TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    closed_at       TEXT
  );

  CREATE TABLE IF NOT EXISTS places (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    area       TEXT,
    secrecy    TEXT NOT NULL DEFAULT 'open' CHECK (secrecy IN ${ENUM_SECRECY}),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS place_paths (
    place_id TEXT NOT NULL REFERENCES places(id),
    machine  TEXT NOT NULL,
    path     TEXT NOT NULL,
    PRIMARY KEY (place_id, machine)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    done_when       TEXT,
    goal_id         TEXT REFERENCES goals(id),
    state           TEXT NOT NULL CHECK (state IN ${ENUM_STATE}),
    mode            TEXT NOT NULL CHECK (mode IN ${ENUM_MODE}),
    estimate_min    INTEGER CHECK (estimate_min IS NULL OR estimate_min >= 0),
    due             TEXT,
    due_provisional INTEGER NOT NULL DEFAULT 0 CHECK (due_provisional IN (0, 1)),
    place_id        TEXT REFERENCES places(id),
    waiting_on      TEXT,
    waiting_for     TEXT,
    result          TEXT,
    reason          TEXT,
    defer_until     TEXT,
    secrecy         TEXT CHECK (secrecy IS NULL OR secrecy IN ${ENUM_SECRECY}),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    closed_at       TEXT
  );
  CREATE INDEX IF NOT EXISTS tasks_goal ON tasks(goal_id);
  CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state);

  CREATE TABLE IF NOT EXISTS blocks (
    before_id  TEXT NOT NULL REFERENCES tasks(id),
    after_id   TEXT NOT NULL REFERENCES tasks(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (before_id, after_id),
    CHECK (before_id <> after_id)
  );
  CREATE INDEX IF NOT EXISTS blocks_after ON blocks(after_id);

  CREATE TABLE IF NOT EXISTS habits (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    rule         TEXT NOT NULL,
    duration_min INTEGER NOT NULL CHECK (duration_min > 0),
    goal_id      TEXT REFERENCES goals(id),
    active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS autonomy (
    kind             TEXT PRIMARY KEY,
    level            TEXT NOT NULL CHECK (level IN ('ask','act_then_tell')),
    approvals_in_row INTEGER NOT NULL DEFAULT 0 CHECK (approvals_in_row >= 0),
    revokes          INTEGER NOT NULL DEFAULT 0 CHECK (revokes >= 0),
    updated_at       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS records (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL,
    actor     TEXT NOT NULL CHECK (length(actor) > 0),
    entity    TEXT NOT NULL CHECK (entity IN ('goal','task','habit','place','block','autonomy')),
    entity_id TEXT NOT NULL,
    action    TEXT NOT NULL,
    changes   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS records_entity ON records(entity_id);

  -- Records are append-only.
  CREATE TRIGGER IF NOT EXISTS records_no_update BEFORE UPDATE ON records
    BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS records_no_delete BEFORE DELETE ON records
    BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
  `,
];

// Brings the database up to SCHEMA_VERSION. Refuses a file written by a newer version.
export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  let version = row ? Number(row.value) : 0;
  if (version > SCHEMA_VERSION) {
    throw new Error(`ledger schema_version ${version} is newer than this warifuri (${SCHEMA_VERSION})`);
  }
  while (version < SCHEMA_VERSION) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(String(version));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return version;
}

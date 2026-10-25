// The ledger's tables, as SQL for node:sqlite.
// The meta table holds schema_version, so later versions can migrate an existing file.
// Add a new entry to MIGRATIONS for each change; never edit an entry that has shipped.

export const SCHEMA_VERSION = 8;

const ENUM_STATE = "('ready','running','waiting','deferred','done','discarded')";
const ENUM_MODE = "('ai_worker','human_with_ai','human')";
const ENUM_LOAD = "('heavy','normal','light')";

// review (goals, tasks): a JSON array of problems found when the row was imported from a
// snapshot that broke the rules, or NULL. Cleared by the next write that passes the rules.

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
    profile         TEXT,
    waiting_on      TEXT,
    waiting_for     TEXT,
    result          TEXT,
    reason          TEXT,
    defer_until     TEXT,
    review          TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    closed_at       TEXT
  );

  CREATE TABLE IF NOT EXISTS places (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    profile    TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- One directory per place and device. The device need not have a row in devices: a place
  -- may be registered (or imported) before that device gets its key.
  CREATE TABLE IF NOT EXISTS place_paths (
    place_id TEXT NOT NULL REFERENCES places(id),
    device   TEXT NOT NULL,
    path     TEXT NOT NULL,
    PRIMARY KEY (place_id, device)
  );
  CREATE INDEX IF NOT EXISTS place_paths_device ON place_paths(device);

  CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    body            TEXT,
    done_when       TEXT,
    goal_id         TEXT REFERENCES goals(id),
    state           TEXT NOT NULL CHECK (state IN ${ENUM_STATE}),
    mode            TEXT NOT NULL CHECK (mode IN ${ENUM_MODE}),
    load            TEXT CHECK (load IS NULL OR load IN ${ENUM_LOAD}),
    estimate_min    INTEGER CHECK (estimate_min IS NULL OR estimate_min >= 0),
    due             TEXT,
    due_provisional INTEGER NOT NULL DEFAULT 0 CHECK (due_provisional IN (0, 1)),
    place_id        TEXT REFERENCES places(id),
    waiting_on      TEXT,
    waiting_for     TEXT,
    result          TEXT,
    reason          TEXT,
    defer_until     TEXT,
    next            TEXT,
    delegated       INTEGER NOT NULL DEFAULT 0 CHECK (delegated IN (0, 1)),
    review          TEXT,
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

  -- One row per device (a machine that uses the ledger, whatever harness runs on it).
  -- key_hash is the sha256 of its machine key, or NULL while it has none; revoked_at is set
  -- when its key is revoked, and cleared when a new key is issued.
  CREATE TABLE IF NOT EXISTS devices (
    name       TEXT PRIMARY KEY,
    key_hash   TEXT UNIQUE,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );

  -- OAuth (warifuri is its own authorization server; GitHub only checks who the person is).
  -- No secret is stored in plain: ids that work as credentials (the pending id kept in the
  -- browser's cookie, the GitHub state, the consent form's CSRF token, codes and tokens) are
  -- kept as sha256 hashes. Clients are public (PKCE, no client secret); metadata is the
  -- registration as JSON.
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id  TEXT PRIMARY KEY,
    metadata   TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- An authorization request waiting for the GitHub login and the consent page (10 minutes).
  CREATE TABLE IF NOT EXISTS oauth_pending (
    id_hash           TEXT PRIMARY KEY,
    client_id         TEXT NOT NULL REFERENCES oauth_clients(client_id),
    redirect_uri      TEXT NOT NULL,
    code_challenge    TEXT NOT NULL,
    scopes            TEXT NOT NULL,
    state             TEXT,
    github_state_hash TEXT,
    github_login      TEXT,
    csrf_hash         TEXT,
    created_at        TEXT NOT NULL,
    expires_at        TEXT NOT NULL
  );

  -- Single-use authorization codes (10 minutes). family names the tokens issued from the code,
  -- so that a second use of the code can revoke them.
  CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash      TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id),
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    device         TEXT NOT NULL REFERENCES devices(name),
    scopes         TEXT NOT NULL,
    family         TEXT,
    created_at     TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    used_at        TEXT
  );

  -- Access and refresh tokens. A family is one grant: the tokens from one code and every
  -- refresh after it.
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    hash       TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('access','refresh')),
    client_id  TEXT NOT NULL REFERENCES oauth_clients(client_id),
    device     TEXT NOT NULL REFERENCES devices(name),
    family     TEXT NOT NULL,
    scopes     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens(family);
  CREATE INDEX IF NOT EXISTS oauth_tokens_client ON oauth_tokens(client_id);

  -- 着手: which task a device is working on, in which place, since when. A task is held in
  -- one place at most, and a device holds at most one task per place (NULL: no place).
  CREATE TABLE IF NOT EXISTS holds (
    task_id  TEXT PRIMARY KEY REFERENCES tasks(id),
    device   TEXT NOT NULL REFERENCES devices(name),
    place_id TEXT REFERENCES places(id),
    since    TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS holds_device_place ON holds(device, ifnull(place_id, ''));

  CREATE TABLE IF NOT EXISTS records (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL,
    actor     TEXT NOT NULL CHECK (length(actor) > 0),
    device    TEXT,
    entity    TEXT NOT NULL CHECK (entity IN ('goal','task','habit','place','block','autonomy','import','device','oauth')),
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
  `
  -- Small values the server keeps for itself, one per key. github_id: the numeric GitHub id
  -- of the person allowed to log in, pinned at the first login that matched the login name.
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  -- Records may also name 'knowledge': a note written to a profile's knowledge or inbox. The
  -- CHECK cannot be changed in place, so the table is rebuilt with its rows and ids; its
  -- triggers move with the old table and are dropped with it, then made again.
  ALTER TABLE records RENAME TO records_v2;
  CREATE TABLE records (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL,
    actor     TEXT NOT NULL CHECK (length(actor) > 0),
    device    TEXT,
    entity    TEXT NOT NULL CHECK (entity IN ('goal','task','habit','place','block','autonomy','import','device','oauth','knowledge')),
    entity_id TEXT NOT NULL,
    action    TEXT NOT NULL,
    changes   TEXT NOT NULL
  );
  INSERT INTO records (id, at, actor, device, entity, entity_id, action, changes)
    SELECT id, at, actor, device, entity, entity_id, action, changes FROM records_v2;
  DROP TABLE records_v2;
  CREATE INDEX IF NOT EXISTS records_entity ON records(entity_id);
  CREATE TRIGGER IF NOT EXISTS records_no_update BEFORE UPDATE ON records
    BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS records_no_delete BEFORE DELETE ON records
    BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
  `,
  `
  -- 予定: time given to a task, a habit, or a fixed appointment (原則3: the task is the
  -- source, the booking may be moved or removed). Times are UTC ISO strings ending in Z, so
  -- they compare as text. A booking of a task or habit names it; a fixed one has only a title.
  CREATE TABLE IF NOT EXISTS bookings (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('task','habit','fixed')),
    task_id    TEXT REFERENCES tasks(id),
    habit_id   TEXT REFERENCES habits(id),
    starts_at  TEXT NOT NULL,
    ends_at    TEXT NOT NULL,
    note       TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (ends_at > starts_at)
  );
  CREATE INDEX IF NOT EXISTS bookings_starts ON bookings(starts_at);
  CREATE INDEX IF NOT EXISTS bookings_task ON bookings(task_id);

  -- When the device last called the server with its key or a login token (kept at most once
  -- a minute, so it is not written on every call).
  ALTER TABLE devices ADD COLUMN last_seen_at TEXT;

  -- Records may also name 'booking'. The table is rebuilt as in version 3.
  ALTER TABLE records RENAME TO records_v3;
  CREATE TABLE records (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL,
    actor     TEXT NOT NULL CHECK (length(actor) > 0),
    device    TEXT,
    entity    TEXT NOT NULL CHECK (entity IN ('goal','task','habit','place','block','autonomy','import','device','oauth','knowledge','booking')),
    entity_id TEXT NOT NULL,
    action    TEXT NOT NULL,
    changes   TEXT NOT NULL
  );
  INSERT INTO records (id, at, actor, device, entity, entity_id, action, changes)
    SELECT id, at, actor, device, entity, entity_id, action, changes FROM records_v3;
  DROP TABLE records_v3;
  CREATE INDEX IF NOT EXISTS records_entity ON records(entity_id);
  CREATE TRIGGER IF NOT EXISTS records_no_update BEFORE UPDATE ON records
    BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS records_no_delete BEFORE DELETE ON records
    BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
  `,
  `
  -- Records may also name 'settings': a change of the person's settings kept in the settings
  -- table (such as the profile the Web screens show). The table is rebuilt as in version 3.
  ALTER TABLE records RENAME TO records_v4;
  CREATE TABLE records (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL,
    actor     TEXT NOT NULL CHECK (length(actor) > 0),
    device    TEXT,
    entity    TEXT NOT NULL CHECK (entity IN ('goal','task','habit','place','block','autonomy','import','device','oauth','knowledge','booking','settings')),
    entity_id TEXT NOT NULL,
    action    TEXT NOT NULL,
    changes   TEXT NOT NULL
  );
  INSERT INTO records (id, at, actor, device, entity, entity_id, action, changes)
    SELECT id, at, actor, device, entity, entity_id, action, changes FROM records_v4;
  DROP TABLE records_v4;
  CREATE INDEX IF NOT EXISTS records_entity ON records(entity_id);
  CREATE TRIGGER IF NOT EXISTS records_no_update BEFORE UPDATE ON records
    BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS records_no_delete BEFORE DELETE ON records
    BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
  `,
  `
  -- Where a booking came from or was copied to: source names the outside calendar (such as
  -- google-calendar), external_id the event there. A pair names one booking, so importing the
  -- same event again finds it; external_id is never set without source (rules.mjs).
  ALTER TABLE bookings ADD COLUMN source TEXT;
  ALTER TABLE bookings ADD COLUMN external_id TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS bookings_external ON bookings(source, external_id) WHERE external_id IS NOT NULL;
  `,
  `
  -- 報告: what the secretary wrote for the person to read (the nightly check, the morning
  -- summary, the inbox tidy-up). Reports are only added, never changed; device is the writer's.
  CREATE TABLE IF NOT EXISTS reports (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('nightly','morning','inbox')),
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    device     TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reports_created ON reports(created_at);

  -- Records may also name 'report'. The table is rebuilt as in version 3.
  ALTER TABLE records RENAME TO records_v6;
  CREATE TABLE records (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL,
    actor     TEXT NOT NULL CHECK (length(actor) > 0),
    device    TEXT,
    entity    TEXT NOT NULL CHECK (entity IN ('goal','task','habit','place','block','autonomy','import','device','oauth','knowledge','booking','settings','report')),
    entity_id TEXT NOT NULL,
    action    TEXT NOT NULL,
    changes   TEXT NOT NULL
  );
  INSERT INTO records (id, at, actor, device, entity, entity_id, action, changes)
    SELECT id, at, actor, device, entity, entity_id, action, changes FROM records_v6;
  DROP TABLE records_v6;
  CREATE INDEX IF NOT EXISTS records_entity ON records(entity_id);
  CREATE TRIGGER IF NOT EXISTS records_no_update BEFORE UPDATE ON records
    BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS records_no_delete BEFORE DELETE ON records
    BEGIN SELECT RAISE(ABORT, 'records are append-only'); END;
  `,
  `
  -- 会話: a thread holds messages between the person and the secretary (one thread of kind
  -- 'secretary' for now). The Web screen, and later other ways in, show the same rows.
  -- runner says how a turn is answered: 'resume' runs claude -p --resume <session_id> for each
  -- turn; 'resident' (a long-running session, not built yet) would keep the same messages and
  -- session_id. seen_until: the last message given to the session, so the next turn knows
  -- what came after it.
  CREATE TABLE IF NOT EXISTS threads (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('secretary')),
    title      TEXT NOT NULL,
    runner     TEXT NOT NULL DEFAULT 'resume' CHECK (runner IN ('resume','resident')),
    session_id TEXT,
    seen_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS threads_kind ON threads(kind);

  -- A message: from the person (user), the secretary, or warifuri itself (system). A proposal
  -- is a secretary's message with kind 'proposal': the autonomy kind it falls under, a title,
  -- the goal or task it is about, and its state (open, then approved, changed or refused, with
  -- the person's words in answer). done_at is set when the secretary has carried it out.
  CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    thread_id     TEXT NOT NULL REFERENCES threads(id),
    role          TEXT NOT NULL CHECK (role IN ('user','secretary','system')),
    kind          TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','proposal')),
    body          TEXT NOT NULL,
    title         TEXT,
    autonomy_kind TEXT,
    about         TEXT,
    state         TEXT CHECK (state IS NULL OR state IN ('open','approved','changed','refused')),
    answer        TEXT,
    answered_at   TEXT,
    done_at       TEXT,
    done_note     TEXT,
    actor         TEXT NOT NULL,
    device        TEXT,
    created_at    TEXT NOT NULL,
    CHECK ((kind = 'proposal') = (state IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);
  CREATE INDEX IF NOT EXISTS messages_state ON messages(state) WHERE state IS NOT NULL;

  -- Records may also name 'thread' and 'message'. The table is rebuilt as in version 3.
  ALTER TABLE records RENAME TO records_v7;
  CREATE TABLE records (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL,
    actor     TEXT NOT NULL CHECK (length(actor) > 0),
    device    TEXT,
    entity    TEXT NOT NULL CHECK (entity IN ('goal','task','habit','place','block','autonomy','import','device','oauth','knowledge','booking','settings','report','thread','message')),
    entity_id TEXT NOT NULL,
    action    TEXT NOT NULL,
    changes   TEXT NOT NULL
  );
  INSERT INTO records (id, at, actor, device, entity, entity_id, action, changes)
    SELECT id, at, actor, device, entity, entity_id, action, changes FROM records_v7;
  DROP TABLE records_v7;
  CREATE INDEX IF NOT EXISTS records_entity ON records(entity_id);
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

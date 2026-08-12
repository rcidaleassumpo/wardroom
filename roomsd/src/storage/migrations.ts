import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import releaseContract from "../../release-contract.json" with { type: "json" };

export const SUPPORTED_SCHEMA_VERSION = releaseContract.storeSchemaVersion;
export type SchemaPolicy = "migrate" | "require-current";

export class RoomsSchemaVersionError extends Error {
  readonly code = "roomsSchemaVersionMismatch";
  readonly permanent = true;

  constructor(readonly storeVersion: number, readonly supportedVersion: number, readonly actor: string) {
    super(storeVersion > supportedVersion
      ? `unsupported Rooms schema version ${storeVersion}; ${actor} supports schema ${supportedVersion}`
      : `${actor} requires Rooms schema ${supportedVersion}, but the store is at schema ${storeVersion}; refusing to migrate shared state outside the Rooms daemon or an explicit setup/upgrade`);
    this.name = "RoomsSchemaVersionError";
  }
}

export function schemaVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version);
}

export function storeSchemaVersion(path: string): number {
  if (!existsSync(path)) throw new Error(`Rooms canonical store is missing: ${path}; run \`rooms setup\``);
  const db = new DatabaseSync(path, { readOnly: true });
  try { return schemaVersion(db); }
  finally { db.close(); }
}

export function requireCurrentSchema(db: DatabaseSync, actor = "Rooms CLI"): void {
  const current = schemaVersion(db);
  if (current !== SUPPORTED_SCHEMA_VERSION) throw new RoomsSchemaVersionError(current, SUPPORTED_SCHEMA_VERSION, actor);
}

type MigrationStep = { version: number; apply: (db: DatabaseSync, originalVersion: number) => void };

type StoredMessage = {
  cursor: number | bigint;
  channel_id: string | null;
  payload: string;
};

function optionalReplyEventId(value: unknown, context: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 512) {
    throw new Error(`cannot migrate Rooms reply metadata: invalid reply event id on ${context}`);
  }
  return value;
}

function backfillReplyMetadata(db: DatabaseSync): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='changes'").get()) return;
  const query = db.prepare("SELECT cursor, channel_id, payload FROM changes WHERE kind='message.sent' ORDER BY cursor");
  query.setReadBigInts(true);
  const rows = query.all() as unknown as StoredMessage[];
  const messages = rows.map((row) => {
    const payload: unknown = JSON.parse(row.payload);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`cannot migrate Rooms reply metadata: message at cursor ${row.cursor} has an invalid payload`);
    }
    const event = payload as Record<string, unknown>;
    if (typeof event.id !== "string" || !event.id.trim()) {
      throw new Error(`cannot migrate Rooms reply metadata: message at cursor ${row.cursor} has no event id`);
    }
    return { ...row, event, id: event.id };
  });
  const byId = new Map<string, typeof messages[number]>();
  for (const message of messages) {
    if (byId.has(message.id)) throw new Error(`cannot migrate Rooms reply metadata: duplicate event id ${message.id}`);
    byId.set(message.id, message);
  }

  const resolved = new Map<string, { threadRootEventId: string | null }>();
  const update = db.prepare("UPDATE changes SET payload=? WHERE cursor=?");
  for (const message of messages) {
    const correlation = message.event.correlation;
    const legacyReply = correlation && typeof correlation === "object" && !Array.isArray(correlation)
      ? optionalReplyEventId((correlation as Record<string, unknown>).replyToEventId, `event ${message.id} correlation`)
      : null;
    const canonicalReply = message.event.replyToEventId === undefined || message.event.replyToEventId === null
      ? legacyReply
      : optionalReplyEventId(message.event.replyToEventId, `event ${message.id}`);
    let threadRootEventId: string | null = null;
    if (canonicalReply !== null) {
      const parent = byId.get(canonicalReply);
      if (!parent) {
        throw new Error(`cannot migrate Rooms reply metadata: event ${message.id} references missing parent ${canonicalReply}`);
      }
      if (parent.channel_id !== message.channel_id) {
        throw new Error(`cannot migrate Rooms reply metadata: event ${message.id} references cross-channel parent ${canonicalReply}`);
      }
      const parentMetadata = resolved.get(parent.id);
      if (!parentMetadata) {
        throw new Error(`cannot migrate Rooms reply metadata: parent ${canonicalReply} does not precede child ${message.id}`);
      }
      threadRootEventId = parentMetadata.threadRootEventId ?? parent.id;
    }

    const migrated: Record<string, unknown> = {
      ...message.event,
      replyToEventId: canonicalReply,
      threadRootEventId,
    };
    if (canonicalReply !== null) {
      migrated.correlation = {
        ...(correlation && typeof correlation === "object" && !Array.isArray(correlation) ? correlation as Record<string, unknown> : {}),
        replyToEventId: canonicalReply,
      };
    }
    update.run(JSON.stringify(migrated), message.cursor);
    resolved.set(message.id, { threadRootEventId });
  }
}

const steps: readonly MigrationStep[] = [{ version: 1, apply: (db) => db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, registered_at TEXT NOT NULL, ended_at TEXT, display_name TEXT, role TEXT CHECK (role IS NULL OR role IN ('operator','planner','worker','reviewer')));
  CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, registered_at TEXT NOT NULL, owner_operator_session_id TEXT REFERENCES sessions(id), lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active','closed')), closed_at TEXT);
  CREATE TABLE IF NOT EXISTS memberships (channel_id TEXT NOT NULL REFERENCES channels(id), session_id TEXT NOT NULL REFERENCES sessions(id), joined_at TEXT NOT NULL, left_at TEXT, session_ended_at TEXT, role TEXT, PRIMARY KEY(channel_id, session_id, joined_at));
  CREATE TABLE IF NOT EXISTS changes (cursor INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, channel_id TEXT REFERENCES channels(id), payload TEXT NOT NULL, occurred_at TEXT NOT NULL, source_ordinal INTEGER);
  CREATE TABLE IF NOT EXISTS import_batches (source_digest TEXT PRIMARY KEY, source_version INTEGER NOT NULL, started_at TEXT NOT NULL, committed_at TEXT);
  CREATE INDEX IF NOT EXISTS changes_channel_cursor ON changes(channel_id, cursor);`)}, { version: 2, apply: (db) => db.exec(`CREATE TABLE IF NOT EXISTS channel_blueprints (channel_id TEXT PRIMARY KEY, blueprint_json TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('suspending','suspended','resuming','active')), idempotency_key TEXT, owner_id TEXT, lease_until TEXT, generation INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS blueprint_member_outcomes (channel_id TEXT NOT NULL, prior_session_id TEXT NOT NULL, outcome TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(channel_id, prior_session_id), FOREIGN KEY(channel_id) REFERENCES channel_blueprints(channel_id));
  CREATE TABLE IF NOT EXISTS queued_deliveries (channel_id TEXT NOT NULL, delivery_id TEXT NOT NULL, cursor INTEGER NOT NULL, payload TEXT NOT NULL, acknowledged_at TEXT, PRIMARY KEY(channel_id, delivery_id));
  CREATE INDEX IF NOT EXISTS queued_deliveries_cursor ON queued_deliveries(channel_id, cursor);
  CREATE TABLE IF NOT EXISTS delivery_acknowledgements (channel_id TEXT NOT NULL, prior_session_id TEXT NOT NULL, delivery_id TEXT NOT NULL, acknowledged_at TEXT NOT NULL, PRIMARY KEY(channel_id, prior_session_id, delivery_id));
  CREATE TABLE IF NOT EXISTS resumed_members (channel_id TEXT NOT NULL, prior_session_id TEXT NOT NULL, session_id TEXT NOT NULL, runtime_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT, provider_json TEXT, PRIMARY KEY(channel_id, prior_session_id));
  CREATE TABLE IF NOT EXISTS resume_results (channel_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(channel_id, idempotency_key));`)}, { version: 3, apply: (db) => db.exec(`ALTER TABLE channel_blueprints ADD COLUMN fence_epoch INTEGER NOT NULL DEFAULT 0;`)}, { version: 4, apply: (db) => db.exec(`ALTER TABLE channel_blueprints ADD COLUMN resume_key TEXT;`)}, { version: 5, apply: (db) => db.exec(`ALTER TABLE channel_blueprints ADD COLUMN suspend_key_known INTEGER NOT NULL DEFAULT 1 CHECK (suspend_key_known IN (0,1)); UPDATE channel_blueprints SET resume_key=COALESCE(resume_key,idempotency_key), idempotency_key=NULL, suspend_key_known=0 WHERE state IN ('resuming','active');`)}, { version: 6, apply: (db, originalVersion) => { if (originalVersion === 4) db.exec(`UPDATE channel_blueprints SET suspend_key_known=0 WHERE state='suspended' AND resume_key IS NULL;`); } }, { version: 7, apply: (db) => db.exec(`ALTER TABLE channel_blueprints ADD COLUMN resume_owner_id TEXT; ALTER TABLE channel_blueprints ADD COLUMN resume_lease_until TEXT;
  CREATE TABLE resume_launches (channel_id TEXT NOT NULL, prior_session_id TEXT NOT NULL, session_id TEXT NOT NULL, runtime_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT, provider_json TEXT, PRIMARY KEY(channel_id, prior_session_id, generation));
  UPDATE channel_blueprints SET resume_owner_id='legacy-unknown', resume_lease_until='1970-01-01T00:00:00.000Z' WHERE state='resuming';`) }, { version: 8, apply: (db) => db.exec(`ALTER TABLE channel_blueprints ADD COLUMN resume_epoch INTEGER NOT NULL DEFAULT 0; ALTER TABLE channel_blueprints ADD COLUMN resume_recovery_known INTEGER NOT NULL DEFAULT 1 CHECK (resume_recovery_known IN (0,1)); ALTER TABLE resume_launches ADD COLUMN provider_phase TEXT NOT NULL DEFAULT 'launched' CHECK (provider_phase IN ('launched','provider_resuming','provider_resumed'));
  UPDATE channel_blueprints SET resume_recovery_known=0 WHERE state='resuming';`) }, { version: 9, apply: (db) => db.exec(`CREATE TABLE runtime_ownership (prior_session_id TEXT NOT NULL, generation INTEGER NOT NULL, runtime_id TEXT NOT NULL, pid INTEGER NOT NULL, start_identity TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(prior_session_id, generation), UNIQUE(runtime_id));`) }, { version: 10, apply: (db) => db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, registered_at TEXT NOT NULL, ended_at TEXT, display_name TEXT, role TEXT); ALTER TABLE sessions ADD COLUMN external_id TEXT;
  CREATE INDEX IF NOT EXISTS sessions_external_id ON sessions(external_id);`) }, { version: 11, apply: (db) => db.exec(`
  CREATE TABLE runtimes (
    runtime_id TEXT PRIMARY KEY,
    home_authority_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    protocol_version INTEGER NOT NULL CHECK (protocol_version > 0),
    transport_kind TEXT NOT NULL CHECK (transport_kind IN ('localPty','structured')),
    state TEXT NOT NULL CHECK (state IN ('creating','running','recovering','crashed','exited','terminating','terminated')),
    machine_id TEXT NOT NULL,
    reconnect_secret_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT,
    exit_reason TEXT,
    UNIQUE(home_authority_id, session_id, generation)
  );
  CREATE INDEX runtimes_session_state ON runtimes(session_id, state);
  CREATE INDEX runtimes_machine_state ON runtimes(machine_id, state);

  CREATE TABLE runtime_bindings (
    binding_id TEXT PRIMARY KEY,
    runtime_id TEXT NOT NULL REFERENCES runtimes(runtime_id),
    home_authority_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    channel_id TEXT REFERENCES channels(id),
    adapter_kind TEXT NOT NULL,
    handle_ref TEXT NOT NULL,
    launch_policy_ref TEXT,
    bound_at TEXT NOT NULL,
    unbound_at TEXT,
    UNIQUE(home_authority_id, session_id, generation),
    UNIQUE(runtime_id),
    FOREIGN KEY(runtime_id) REFERENCES runtimes(runtime_id)
  );

  CREATE TABLE runtime_attachments (
    attachment_id TEXT PRIMARY KEY,
    runtime_id TEXT NOT NULL REFERENCES runtimes(runtime_id),
    home_authority_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    viewer_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('observe','controller')),
    lease_expires_at TEXT,
    output_cursor INTEGER NOT NULL DEFAULT 0 CHECK (output_cursor >= 0),
    attached_at TEXT NOT NULL,
    detached_at TEXT,
    last_seen_at TEXT,
    UNIQUE(runtime_id, generation, viewer_id),
    FOREIGN KEY(runtime_id) REFERENCES runtimes(runtime_id)
  );
  CREATE UNIQUE INDEX runtime_controller_lease ON runtime_attachments(runtime_id, generation)
    WHERE mode='controller' AND detached_at IS NULL;
  CREATE INDEX runtime_attachment_observers ON runtime_attachments(runtime_id, generation, detached_at);

  CREATE TABLE runtime_capability_replay (
    runtime_id TEXT NOT NULL REFERENCES runtimes(runtime_id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    capability_id TEXT NOT NULL,
    nonce_hash TEXT NOT NULL,
    action TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    PRIMARY KEY(runtime_id, generation, capability_id),
    UNIQUE(runtime_id, generation, nonce_hash)
  );

  CREATE TABLE runtime_events (
    runtime_id TEXT NOT NULL REFERENCES runtimes(runtime_id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    event_seq INTEGER NOT NULL CHECK (event_seq > 0),
    event_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    output_cursor INTEGER CHECK (output_cursor IS NULL OR output_cursor >= 0),
    message_id TEXT,
    outcome TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    occurred_at TEXT NOT NULL,
    PRIMARY KEY(runtime_id, generation, event_seq)
  );
  CREATE INDEX runtime_events_cursor ON runtime_events(runtime_id, generation, event_seq);

  CREATE TABLE runtime_quotas (
    machine_id TEXT PRIMARY KEY,
    max_active_runtimes INTEGER NOT NULL CHECK (max_active_runtimes > 0),
    max_observers_per_runtime INTEGER NOT NULL CHECK (max_observers_per_runtime > 0),
    updated_at TEXT NOT NULL
  );`) }, { version: 12, apply: (db) => db.exec(`ALTER TABLE runtimes ADD COLUMN provider_thread_id TEXT;`) }, { version: 13, apply: (db) => db.exec(`ALTER TABLE sessions ADD COLUMN provider_thread_id TEXT;`) }, { version: 14, apply: (db) => db.exec(`CREATE TABLE federation_channel_admissions (
    channel_id TEXT NOT NULL REFERENCES channels(id),
    peer_authority_id TEXT NOT NULL,
    granted_by_session_id TEXT NOT NULL REFERENCES sessions(id),
    granted_at TEXT NOT NULL,
    revoked_by_session_id TEXT REFERENCES sessions(id),
    revoked_at TEXT,
    PRIMARY KEY(channel_id, peer_authority_id)
  );
  CREATE INDEX federation_channel_admissions_peer_active
    ON federation_channel_admissions(peer_authority_id, channel_id)
    WHERE revoked_at IS NULL;`) }, { version: 15, apply: (db) => {
      // Deployed role-handoff-schema15 builds already stamped version 15 with
      // this exact label migration; the guard keeps both histories converging.
      // Blueprint-only legacy stores carry no channels table at all; there is
      // nothing to upgrade in them.
      if (columnMissing(db, "channels", "label")) db.exec(`ALTER TABLE channels ADD COLUMN label TEXT;`);
    } }, { version: 16, apply: (db) => {
      if (columnMissing(db, "sessions", "delivery_mode")) db.exec(`ALTER TABLE sessions ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'runtime' CHECK (delivery_mode IN ('runtime','log'));`);
    } }, { version: 17, apply: (db) => {
      if (columnMissing(db, "channels", "broadcast_policy")) db.exec(`ALTER TABLE channels ADD COLUMN broadcast_policy TEXT NOT NULL DEFAULT 'all' CHECK (broadcast_policy IN ('all','privileged'));`);
    } }, { version: 18, apply: (db) => db.exec(`CREATE TABLE IF NOT EXISTS provider_usage_samples (
      sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      runtime_id TEXT NOT NULL REFERENCES runtimes(runtime_id),
      generation INTEGER NOT NULL CHECK (generation > 0),
      adapter_kind TEXT NOT NULL,
      provider_thread_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('available','unavailable','unsupported','privacy')),
      reason TEXT NOT NULL,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      counter_reset INTEGER NOT NULL DEFAULT 0 CHECK (counter_reset IN (0,1)),
      sampled_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS provider_usage_samples_session_time ON provider_usage_samples(session_id, sampled_at);
    CREATE INDEX IF NOT EXISTS provider_usage_samples_channel_time ON provider_usage_samples(channel_id, sampled_at);
    CREATE INDEX IF NOT EXISTS provider_usage_samples_runtime_time ON provider_usage_samples(runtime_id, generation, sampled_at);`) },
  { version: 19, apply: (db) => db.exec(`CREATE TABLE IF NOT EXISTS agent_rotations (
      rotation_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id),
      old_session_id TEXT NOT NULL REFERENCES sessions(id),
      replacement_session_id TEXT REFERENCES sessions(id),
      actor_session_id TEXT NOT NULL REFERENCES sessions(id),
      nonce TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('prepared','acknowledged','committed','cleanup_pending','cancelled','rolled_back')),
      reason TEXT,
      old_runtime_id TEXT NOT NULL REFERENCES runtimes(runtime_id),
      old_generation INTEGER NOT NULL,
      replacement_runtime_id TEXT REFERENCES runtimes(runtime_id),
      replacement_generation INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_rotations_channel_time ON agent_rotations(channel_id, created_at);`) },
  { version: 20, apply: backfillReplyMetadata },
  { version: 21, apply: (db) => db.exec(`
  CREATE TABLE IF NOT EXISTS message_threads (
    thread_root_event_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    state TEXT NOT NULL CHECK (state IN ('open','resolved')),
    resolved_at TEXT,
    resolved_by_session_id TEXT REFERENCES sessions(id),
    reopened_at TEXT,
    reopened_by_session_id TEXT REFERENCES sessions(id),
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS message_threads_channel_state ON message_threads(channel_id, state);
`) }];
function columnMissing(db: DatabaseSync, table: string, column: string): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return false;
  return !db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(column);
}
export function migrate(db: DatabaseSync): void {
  const current = schemaVersion(db);
  if (current > SUPPORTED_SCHEMA_VERSION) throw new RoomsSchemaVersionError(current, SUPPORTED_SCHEMA_VERSION, "this Rooms build");
  if (current === SUPPORTED_SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const step of steps) if (step.version > current) { step.apply(db, current); db.exec(`PRAGMA user_version=${step.version}`); }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

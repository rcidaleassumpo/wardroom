// SPDX-License-Identifier: Apache-2.0
import type { RoomsApplication } from "../domain/application.js";
import type { RoomsRepository } from "../storage/repository.js";
import {
  scanProviderFinalReply,
  type ProviderReplyScanState,
} from "./provider-final-reply.js";

type JobRow = Readonly<{
  source_event_id: string;
  source_cursor: number;
  source_body: string;
  channel_id: string;
  source_sender_session_id: string;
  provider_session_id: string;
  runtime_id: string;
  generation: number;
  adapter_kind: string;
  provider_thread_id: string | null;
  scan_state_json: string;
  created_at: string;
  runtime_provider_thread_id: string | null;
  runtime_ended_at: string | null;
}>;

const POLL_INTERVAL_MS = 500;
const JOB_BATCH_SIZE = 8;
const INPUT_OBSERVATION_TIMEOUT_MS = 30_000;

/**
 * Promote one provider final answer into one canonical direct reply.
 *
 * The durable job exists because provider completion happens after delivery
 * returns. The bridge reads a small batch in order, never fans out database
 * gets, and resumes pending work after the Rooms daemon restarts.
 */
export class ProviderReplyBridge {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly database: RoomsRepository,
    private readonly application: RoomsApplication,
    private readonly homeDirectory?: string,
  ) {}

  start(): void {
    this.schedule(0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  enqueue(input: Readonly<{
    sourceEventId: string;
    sourceCursor: string;
    sourceBody: string;
    channelId: string;
    sourceSenderSessionId: string;
    providerSessionId: string;
    runtimeId: string;
    generation: number;
    adapterKind: string;
    providerThreadId: string | null;
    scanState: ProviderReplyScanState;
  }>): void {
    const changedAt = new Date().toISOString();
    this.database.db.prepare(`INSERT OR IGNORE INTO provider_reply_jobs(
      source_event_id, source_cursor, source_body, channel_id, source_sender_session_id,
      provider_session_id, runtime_id, generation, adapter_kind,
      provider_thread_id, scan_state_json, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(
        input.sourceEventId,
        Number(input.sourceCursor),
        input.sourceBody,
        input.channelId,
        input.sourceSenderSessionId,
        input.providerSessionId,
        input.runtimeId,
        input.generation,
        input.adapterKind,
        input.providerThreadId,
        JSON.stringify(input.scanState),
        changedAt,
        changedAt,
      );
    this.schedule(POLL_INTERVAL_MS);
  }

  /** Synchronous and exported for focused acceptance tests. */
  tick(): void {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = this.pendingJobs();
      for (const job of jobs) this.process(job);
      if (this.hasPendingJobs()) this.schedule(POLL_INTERVAL_MS);
    } catch {
      // A closing daemon can race one unref'ed tick with database shutdown.
      // The durable rows remain for the next daemon start.
    } finally {
      this.running = false;
    }
  }

  private process(job: JobRow): void {
    if (job.runtime_ended_at !== null) {
      this.finish(job.source_event_id, "failed", null, "runtime-ended-before-provider-reply");
      return;
    }
    if (this.database.currentChannel(job.channel_id)?.lifecycleState !== "active") {
      this.finish(job.source_event_id, "skipped", null, "channel-not-active");
      return;
    }
    if (this.hasCanonicalReply(job)) {
      this.finish(job.source_event_id, "skipped", null, "provider-already-replied");
      return;
    }

    const providerThreadId = job.runtime_provider_thread_id ?? job.provider_thread_id;
    const currentState = parseState(job.scan_state_json);
    const observed = scanProviderFinalReply({
      adapterKind: job.adapter_kind,
      providerThreadId,
      state: currentState,
      expectedInput: job.source_body,
      homeDirectory: this.homeDirectory,
    });
    this.database.db.prepare(`UPDATE provider_reply_jobs
      SET provider_thread_id=?, scan_state_json=?, updated_at=?
      WHERE source_event_id=? AND state='pending'`)
      .run(providerThreadId, JSON.stringify(observed.state), new Date().toISOString(), job.source_event_id);
    if (observed.status === "failed") {
      this.finish(job.source_event_id, "failed", null, observed.reason ?? "provider-turn-failed");
      return;
    }
    if (!observed.state.inputSeen && Date.now() - Date.parse(job.created_at) >= INPUT_OBSERVATION_TIMEOUT_MS) {
      this.finish(job.source_event_id, "failed", null, "provider-input-not-observed");
      return;
    }
    if (observed.status !== "complete" || observed.text === null) return;

    // The provider may have used Rooms while its transcript was being read.
    if (this.hasCanonicalReply(job)) {
      this.finish(job.source_event_id, "skipped", null, "provider-already-replied");
      return;
    }
    try {
      const receipt = this.application.commitMessage({
        channelId: job.channel_id,
        senderSessionId: job.provider_session_id,
        body: observed.text,
        target: {
          kind: "direct",
          sessionId: job.source_sender_session_id,
          sessionIds: [job.source_sender_session_id],
        },
        replyToEventId: job.source_event_id,
        correlation: {
          kind: "providerFinalReply",
          sourceEventId: job.source_event_id,
          deduplicationKey: `provider-final:${job.source_event_id}:${job.provider_session_id}`,
        },
        deliveryStatuses: { [job.source_sender_session_id]: "delivered" },
      });
      const event = receipt.event as { id: string };
      this.finish(job.source_event_id, "published", event.id, "provider-final-answer");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "provider-reply-publish-failed";
      this.finish(job.source_event_id, "failed", null, reason);
    }
  }

  private pendingJobs(): JobRow[] {
    return this.database.db.prepare(`SELECT
        j.source_event_id, j.source_cursor, j.source_body, j.channel_id,
        j.source_sender_session_id, j.provider_session_id,
        j.runtime_id, j.generation, j.adapter_kind, j.provider_thread_id,
        j.scan_state_json, j.created_at, r.provider_thread_id AS runtime_provider_thread_id,
        r.ended_at AS runtime_ended_at
      FROM provider_reply_jobs j
      JOIN runtimes r ON r.runtime_id=j.runtime_id AND r.generation=j.generation
      WHERE j.state='pending'
      ORDER BY j.created_at, j.source_cursor
      LIMIT ?`).all(JOB_BATCH_SIZE) as unknown as JobRow[];
  }

  private hasPendingJobs(): boolean {
    return Boolean(this.database.db.prepare("SELECT 1 FROM provider_reply_jobs WHERE state='pending' LIMIT 1").get());
  }

  private hasCanonicalReply(job: JobRow): boolean {
    return Boolean(this.database.db.prepare(`SELECT 1
      FROM changes
      WHERE kind='message.sent'
        AND channel_id=?
        AND cursor>?
        AND json_extract(payload, '$.senderSessionId')=?
        AND (
          json_extract(payload, '$.replyToEventId')=?
          OR (
            json_extract(payload, '$.target.kind')='direct'
            AND json_extract(payload, '$.target.sessionId')=?
          )
        )
      LIMIT 1`).get(
        job.channel_id,
        job.source_cursor,
        job.provider_session_id,
        job.source_event_id,
        job.source_sender_session_id,
      ));
  }

  private finish(sourceEventId: string, state: "published" | "skipped" | "failed", replyEventId: string | null, reason: string): void {
    this.database.db.prepare(`UPDATE provider_reply_jobs
      SET state=?, reply_event_id=?, outcome_reason=?, updated_at=?
      WHERE source_event_id=? AND state='pending'`)
      .run(state, replyEventId, reason, new Date().toISOString(), sourceEventId);
  }

  private schedule(delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delayMs);
    this.timer.unref();
  }
}

function parseState(value: string): ProviderReplyScanState {
  const parsed = JSON.parse(value) as Partial<ProviderReplyScanState>;
  return {
    offsets: parsed.offsets && typeof parsed.offsets === "object" ? parsed.offsets : {},
    inputSeen: parsed.inputSeen === true,
    candidateText: typeof parsed.candidateText === "string" ? parsed.candidateText : null,
    completed: parsed.completed === true,
    completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : null,
    failureReason: typeof parsed.failureReason === "string" ? parsed.failureReason : null,
  };
}

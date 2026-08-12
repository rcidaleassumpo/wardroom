import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

export type QueryOperationContext = Readonly<{
  operation: string;
  correlationId: string;
  trigger?: string;
}>;

export type QueryTelemetryEvent = Readonly<{
  kind: "query" | "exec";
  operation: string;
  correlationId: string;
  trigger: string | null;
  statement: string;
  statementHash: string;
  durationMs: number;
  rows: number | null;
  outcome: "ok" | "error";
  errorCode: string | null;
  inFlight: number;
  peakInFlight: number;
  occurredAt: string;
}>;

const contexts = new AsyncLocalStorage<QueryOperationContext>();
const events: QueryTelemetryEvent[] = [];
const statementMetadata = new Map<string, { statement: string; statementHash: string }>();
const securedLogFiles = new Set<string>();
let logWarningSent = false;
let totalStatements = 0;
let totalDurationMs = 0;
let inFlight = 0;
let peakInFlight = 0;

export function queryCorrelationId(): string { return randomUUID(); }

export function withQueryOperation<T>(context: Omit<QueryOperationContext, "correlationId"> & { correlationId?: string }, operation: () => T): T {
  const parent = contexts.getStore();
  return contexts.run({
    operation: context.operation,
    correlationId: context.correlationId ?? parent?.correlationId ?? queryCorrelationId(),
    trigger: context.trigger ?? parent?.trigger ?? parent?.operation,
  }, operation);
}

export function queryMetricsSnapshot(): Readonly<{
  totalStatements: number;
  totalDurationMs: number;
  peakInFlight: number;
  events: readonly QueryTelemetryEvent[];
}> {
  return { totalStatements, totalDurationMs, peakInFlight, events: [...events] };
}

export function resetQueryMetrics(): void {
  totalStatements = 0;
  totalDurationMs = 0;
  inFlight = 0;
  peakInFlight = 0;
  events.length = 0;
}

/**
 * Instruments every statement prepared through the canonical database handle.
 * Parameters and result values are never recorded. The SQL text is reduced to
 * its leading operation and table names; a hash keeps statements comparable.
 */
export function instrumentDatabase(database: DatabaseSync): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => instrumentStatement(target.prepare(sql), sql);
      if (property === "exec") return (sql: string) => observe("exec", sql, () => target.exec(sql));
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DatabaseSync;
}

function instrumentStatement<T extends object>(statement: T, sql: string): T {
  return new Proxy(statement, {
    get(target, property) {
      if (property === "get") return (...args: unknown[]) => observe("query", sql, () => (Reflect.get(target, property, target) as (...values: unknown[]) => unknown).apply(target, args));
      if (property === "all") return (...args: unknown[]) => observe("query", sql, () => (Reflect.get(target, property, target) as (...values: unknown[]) => unknown).apply(target, args));
      if (property === "run") return (...args: unknown[]) => observe("query", sql, () => (Reflect.get(target, property, target) as (...values: unknown[]) => unknown).apply(target, args));
      if (property === "iterate") return (...args: unknown[]) => {
        const iterator = (Reflect.get(target, property, target) as (...values: unknown[]) => Iterable<unknown>).apply(target, args);
        return observedIterator(sql, iterator);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}

function* observedIterator(sql: string, iterator: Iterable<unknown>): Iterable<unknown> {
  const values = observe("query", sql, () => [...iterator]);
  yield* values;
}

function observe<T>(kind: "query" | "exec", sql: string, operation: () => T): T {
  const context = contexts.getStore() ?? { operation: "unscoped", correlationId: "unscoped" };
  const started = process.hrtime.bigint();
  inFlight += 1;
  peakInFlight = Math.max(peakInFlight, inFlight);
  let outcome: QueryTelemetryEvent["outcome"] = "ok";
  let errorCode: string | null = null;
  let rows: number | null = null;
  try {
    const result = operation();
    rows = rowCount(result);
    return result;
  } catch (error) {
    outcome = "error";
    errorCode = String((error as { code?: unknown }).code ?? (error as { name?: unknown }).name ?? "queryError");
    throw error;
  } finally {
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    totalStatements += 1;
    totalDurationMs += durationMs;
    inFlight -= 1;
    const metadata = metadataFor(sql);
    const event: QueryTelemetryEvent = {
      kind,
      operation: context.operation,
      correlationId: context.correlationId,
      trigger: context.trigger ?? null,
      statement: metadata.statement,
      statementHash: metadata.statementHash,
      durationMs,
      rows,
      outcome,
      errorCode,
      inFlight: inFlight + 1,
      peakInFlight,
      occurredAt: new Date().toISOString(),
    };
    events.push(event);
    if (events.length > 2_000) events.splice(0, events.length - 2_000);
    const file = process.env.ROOMS_QUERY_LOG;
    if (file) {
      try {
        appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
        if (!securedLogFiles.has(file)) { chmodSync(file, 0o600); securedLogFiles.add(file); }
      } catch (error) {
        if (!logWarningSent) { logWarningSent = true; console.warn(`[rooms] query log unavailable: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
  }
}

function metadataFor(sql: string): { statement: string; statementHash: string } {
  const existing = statementMetadata.get(sql);
  if (existing) return existing;
  const metadata = { statement: statementShape(sql), statementHash: createHash("sha256").update(sql).digest("hex").slice(0, 16) };
  statementMetadata.set(sql, metadata);
  return metadata;
}

function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === "object" && "changes" in result) return Number((result as { changes?: unknown }).changes ?? 0);
  return result == null ? 0 : 1;
}

function statementShape(sql: string): string {
  const compact = sql.replace(/\s+/g, " ").trim();
  const verb = compact.match(/^(?:WITH\b[\s\S]*?\b)?(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|BEGIN|COMMIT|ROLLBACK)/i)?.[1]?.toUpperCase() ?? "SQL";
  const tables = [...compact.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+([a-z_][a-z0-9_]*)/gi)].map((match) => match[1]!.toLowerCase());
  return `${verb}${tables.length ? ` ${[...new Set(tables)].join(",")}` : ""}`;
}

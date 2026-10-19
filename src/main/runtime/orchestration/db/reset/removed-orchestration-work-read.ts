import type Database from '../../../../sqlite/sync-database'
import type { SqliteRow } from '../../../../sqlite/sqlite-statement'
import {
  isRemovedWorkKind,
  REMOVED_WORK_FIELDS,
  REMOVED_WORK_PAGE_SIZE,
  type RemovedWorkEntry,
  type RemovedWorkFieldType,
  type ResetRemovedWork,
  type RunRemovedWork
} from '../../../../../shared/orchestration-removed-work'
import { POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES } from '../federation/remote-attachment-liveness'
import { OrchestrationError } from '../../orchestration-error'
import { exposeUtcTimestamp } from '../utc-timestamp'

const WORKER_KINDS = "('worker', 'remote_worker', 'federated_worker')"
const LIVE_STATES = POTENTIALLY_LIVE_REMOTE_ATTACHMENT_STATES.map((state) => `'${state}'`).join(
  ', '
)
// "Orca was still supervising it when tracking stopped", not a verdict about the process now.
const ACTIVE_AT_REMOVAL_SQL = `CASE WHEN json_valid(record) THEN
  (kind IN ('worker', 'remote_worker') AND json_extract(record, '$.state') IN (${LIVE_STATES}))
  OR (kind = 'federated_worker' AND json_extract(record, '$.dispatchStatus') IN ('pending', 'dispatched'))
  ELSE 0 END`

const COUNTS_SQL = `
  COALESCE(SUM(kind = 'task'), 0) AS tasks,
  COALESCE(SUM(kind = 'dispatch'), 0) AS dispatches,
  COUNT(DISTINCT CASE WHEN kind IN ${WORKER_KINDS} THEN entity_id END) AS workers,
  COALESCE(SUM(kind = 'terminal'), 0) AS terminals,
  COUNT(DISTINCT CASE WHEN ${ACTIVE_AT_REMOVAL_SQL} THEN entity_id END) AS active`

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** Read inside the reset transaction, so the summary covers exactly that reset's removals. */
export function readRemovedWorkWatermark(db: Database.Database): number {
  return Number(
    db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM removed_orchestration_work').get()?.seq
  )
}

/** Never throws: the reset already committed, and its reply only loses this optional field. */
export function summarizeRemovedWorkSince(
  db: Database.Database,
  watermark: number | undefined
): ResetRemovedWork | undefined {
  if (watermark === undefined) {
    return undefined
  }
  try {
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT run_id) AS runs, ${COUNTS_SQL}
         FROM removed_orchestration_work WHERE seq > ?`
      )
      .get(watermark)
    return {
      runs: Number(row?.runs ?? 0),
      tasks: Number(row?.tasks ?? 0),
      dispatches: Number(row?.dispatches ?? 0),
      workers: Number(row?.workers ?? 0),
      possiblyRunning: Number(row?.active ?? 0)
    }
  } catch (error) {
    console.warn('[orchestration] Could not summarize removed work after reset', error)
    return undefined
  }
}

function decodeField(
  value: unknown,
  type: RemovedWorkFieldType
): string | number | string[] | null {
  if (type === 'int') {
    return typeof value === 'number' ? value : null
  }
  if (type === 'text' || typeof value !== 'string') {
    return text(value)
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : null
  } catch {
    return null
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(String(value))
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function decodeEntry(row: SqliteRow): RemovedWorkEntry {
  const kind = String(row.kind)
  const base = {
    seq: Number(row.seq),
    id: String(row.entity_id),
    removedAt: exposeUtcTimestamp(text(row.removed_at)) ?? ''
  }
  const record = parseRecord(row.record)
  if (!record || !isRemovedWorkKind(kind)) {
    return { ...base, kind, unreadable: true }
  }
  const fields = Object.fromEntries(
    Object.entries<RemovedWorkFieldType>(REMOVED_WORK_FIELDS[kind]).map(([key, type]) => {
      const value = decodeField(record[key], type)
      return [key, key === 'createdAt' ? exposeUtcTimestamp(text(value)) : value]
    })
  )
  const active = kind.endsWith('worker') ? { activeAtRemoval: row.active === 1 } : {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fields are built from REMOVED_WORK_FIELDS[kind], the same table the entry type is derived from.
  return { ...base, kind, ...active, ...fields } as RemovedWorkEntry
}

export function readRunRemovedWork(
  db: Database.Database,
  runId: string,
  options: { removed?: boolean | undefined; cursor?: string | undefined }
): RunRemovedWork | undefined {
  const row = db
    .prepare(
      `SELECT coverage.recorded_since,
         (SELECT created_at FROM runs WHERE id = ?) >= coverage.recorded_since AS complete,
         (SELECT MAX(removed_at) FROM removed_orchestration_work WHERE run_id = ?) AS last_removed_at,
         counts.tasks, counts.dispatches, counts.workers, counts.terminals, counts.active
       FROM removed_orchestration_work_coverage coverage,
         (SELECT ${COUNTS_SQL} FROM removed_orchestration_work WHERE run_id = ?) counts`
    )
    .get(runId, runId, runId)
  if (!row) {
    return undefined
  }
  const summary: RunRemovedWork = {
    coverage: row.complete === 1 ? 'complete' : 'partial',
    recordedSince: exposeUtcTimestamp(text(row.recorded_since)) ?? '',
    tasks: Number(row.tasks),
    dispatches: Number(row.dispatches),
    workers: Number(row.workers),
    terminals: Number(row.terminals),
    activeWorkersAtRemoval: Number(row.active),
    lastRemovedAt: exposeUtcTimestamp(text(row.last_removed_at))
  }
  if (!options.removed && options.cursor === undefined) {
    return summary
  }
  if (options.cursor !== undefined && !/^\d+$/.test(options.cursor)) {
    throw new OrchestrationError('cursor_invalid', 'The removed work cursor is invalid.')
  }
  const rows = db
    .prepare(
      `SELECT seq, kind, entity_id, record, removed_at, ${ACTIVE_AT_REMOVAL_SQL} AS active
       FROM removed_orchestration_work WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`
    )
    .all(runId, Number(options.cursor ?? 0), REMOVED_WORK_PAGE_SIZE + 1)
  const entries = rows.slice(0, REMOVED_WORK_PAGE_SIZE).map(decodeEntry)
  const hasMore = rows.length > REMOVED_WORK_PAGE_SIZE
  return {
    ...summary,
    entries,
    page: { hasMore, nextCursor: hasMore ? String(entries.at(-1)?.seq) : null }
  }
}

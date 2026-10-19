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
const LIVE_WORKER_ROW_SQL = `CASE WHEN json_valid(record) THEN
  (kind IN ('worker', 'remote_worker') AND json_extract(record, '$.state') IN (${LIVE_STATES}))
  OR (kind = 'federated_worker' AND json_extract(record, '$.dispatchStatus') IN ('pending', 'dispatched'))
  ELSE 0 END`
// A settled worker keeps its agent open until its terminal is released, so an unreleased Orca-owned
// terminal also means its owner may still be running.
const UNRELEASED_TERMINAL_ROW_SQL = `kind = 'terminal' AND CASE WHEN json_valid(record) THEN
  COALESCE(json_extract(record, '$.releaseState'), '') <> 'released'
  AND COALESCE(json_extract(record, '$.ownershipState'), '') NOT IN ('user_owned', 'released')
  ELSE 0 END`

/** Removed rows matching `scopeSql`, their distinct workers, and the workers that may still run. */
function removedWorkScopeSql(scopeSql: string): string {
  return `WITH scope AS (
      SELECT run_id, kind, entity_id, record FROM removed_orchestration_work WHERE ${scopeSql}
    ),
    workers AS (SELECT DISTINCT entity_id AS id FROM scope WHERE kind IN ${WORKER_KINDS}),
    active AS (
      SELECT entity_id AS id FROM scope WHERE ${LIVE_WORKER_ROW_SQL}
      UNION SELECT json_extract(record, '$.ownerDispatchId') FROM scope WHERE ${UNRELEASED_TERMINAL_ROW_SQL}
    )`
}

function readRemovedWorkCounts(db: Database.Database, scopeSql: string, param: string | number) {
  const row = db
    .prepare(
      `${removedWorkScopeSql(scopeSql)}
      SELECT json_group_array(DISTINCT run_id) AS run_ids,
        COALESCE(SUM(kind = 'task'), 0) AS tasks,
        COALESCE(SUM(kind = 'dispatch'), 0) AS dispatches,
        COALESCE(SUM(kind = 'terminal'), 0) AS terminals,
        (SELECT COUNT(*) FROM workers) AS workers,
        (SELECT COUNT(*) FROM active WHERE id IN (SELECT id FROM workers)) AS active
      FROM scope`
    )
    .get(param)
  const runIds: unknown = JSON.parse(String(row?.run_ids ?? '[]'))
  return {
    runIds: Array.isArray(runIds) ? runIds.filter((id) => typeof id === 'string') : [],
    tasks: Number(row?.tasks ?? 0),
    dispatches: Number(row?.dispatches ?? 0),
    terminals: Number(row?.terminals ?? 0),
    workers: Number(row?.workers ?? 0),
    active: Number(row?.active ?? 0)
  }
}

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
  watermark: number
): ResetRemovedWork | undefined {
  try {
    const counts = readRemovedWorkCounts(db, 'seq > ?', watermark)
    return {
      runs: counts.runIds.length,
      runIds: counts.runIds,
      tasks: counts.tasks,
      dispatches: counts.dispatches,
      workers: counts.workers,
      possiblyRunning: counts.active
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

function decodeEntry(row: SqliteRow, activeIds: ReadonlySet<string>): RemovedWorkEntry {
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
  const active = kind.endsWith('worker') ? { activeAtRemoval: activeIds.has(base.id) } : {}
  const entry: unknown = { ...base, kind, ...active, ...fields }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fields are built from REMOVED_WORK_FIELDS[kind], the same table the entry type is derived from.
  return entry as RemovedWorkEntry
}

/** Never throws for bookkeeping reasons: on a failed read run-show simply omits the field. */
export function readRunRemovedWork(
  db: Database.Database,
  runId: string,
  options: { removed?: boolean | undefined; cursor?: string | undefined }
): RunRemovedWork | undefined {
  if (options.cursor !== undefined && !/^\d+$/.test(options.cursor)) {
    throw new OrchestrationError('cursor_invalid', 'The removed work cursor is invalid.')
  }
  try {
    return readRunRemovedWorkPage(db, runId, options)
  } catch (error) {
    console.warn('[orchestration] Could not read removed work for run-show', error)
    return undefined
  }
}

function readRunRemovedWorkPage(
  db: Database.Database,
  runId: string,
  options: { removed?: boolean | undefined; cursor?: string | undefined }
): RunRemovedWork | undefined {
  // Strict: a Run created in the second recording started may predate the capture triggers.
  const coverage = db
    .prepare(
      `SELECT recorded_since,
         (SELECT created_at FROM runs WHERE id = ?) > recorded_since AS complete,
         (SELECT MAX(removed_at) FROM removed_orchestration_work WHERE run_id = ?) AS last_removed_at
       FROM removed_orchestration_work_coverage`
    )
    .get(runId, runId)
  if (!coverage) {
    return undefined
  }
  const counts = readRemovedWorkCounts(db, 'run_id = ?', runId)
  const summary: RunRemovedWork = {
    coverage: coverage.complete === 1 ? 'complete' : 'partial',
    recordedSince: exposeUtcTimestamp(text(coverage.recorded_since)) ?? '',
    tasks: counts.tasks,
    dispatches: counts.dispatches,
    workers: counts.workers,
    terminals: counts.terminals,
    activeWorkersAtRemoval: counts.active,
    lastRemovedAt: exposeUtcTimestamp(text(coverage.last_removed_at))
  }
  if (!options.removed && options.cursor === undefined) {
    return summary
  }
  const activeIds = new Set(
    db
      .prepare(
        `${removedWorkScopeSql('run_id = ?')}
        SELECT id FROM active WHERE id IN (SELECT id FROM workers)`
      )
      .all(runId)
      .map((row) => String(row.id))
  )
  // A federated worker also has a local worker row; list it once, as the counts do.
  const rows = db
    .prepare(
      `SELECT seq, kind, entity_id, record, removed_at FROM removed_orchestration_work removed
       WHERE run_id = ? AND seq > ?
         AND NOT (kind = 'worker' AND EXISTS (
           SELECT 1 FROM removed_orchestration_work federated
           WHERE federated.entity_id = removed.entity_id AND federated.kind = 'federated_worker'
             AND federated.run_id = removed.run_id))
       ORDER BY seq LIMIT ?`
    )
    .all(runId, Number(options.cursor ?? 0), REMOVED_WORK_PAGE_SIZE + 1)
  const entries = rows.slice(0, REMOVED_WORK_PAGE_SIZE).map((row) => decodeEntry(row, activeIds))
  const hasMore = rows.length > REMOVED_WORK_PAGE_SIZE
  return {
    ...summary,
    entries,
    page: { hasMore, nextCursor: hasMore ? String(entries.at(-1)?.seq) : null }
  }
}

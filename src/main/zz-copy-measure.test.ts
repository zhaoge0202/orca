import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { it, vi } from 'vitest'
import Database from './sqlite/sync-database'
import * as Trace from './ai-vault-search/session-search-trace'
import { openSessionSearchDatabase } from './ai-vault-search/storage/session-search-schema'
import { ensureSessionSearchQuerySchema } from './ai-vault-search/storage/session-search-query-schema'
import {
  deleteSearchMessages,
  insertSearchMessage
} from './ai-vault-search/storage/session-search-message-rows'
import { SessionSearchCompactCopy } from './ai-vault-search/storage/session-search-compact-copy'
import {
  sessionSearchCopyingPath,
  swapInSessionSearchCopy
} from './ai-vault-search/storage/session-search-copy-files'

const ROOT = process.env.MEASURE_ROOT ?? join(homedir(), '.cache/orca-jobs/dbgrowth-copy')
const SCALE = Number(process.env.MEASURE_SCALE ?? 1)
const OUT = process.env.MEASURE_OUT ?? join(ROOT, 'copy.json')
const out: Record<string, unknown> = {}
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 1))
let seed = 1
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
const words = Array.from({ length: 20000 }, () => Math.floor(rand() * 2 ** 40).toString(36))
const pick = () => words[Math.floor(rand() ** 2 * 20000)]!
const text = () => Array.from({ length: 40 + Math.floor(rand() * 400) }, pick).join(' ')
const mb = (n: number) => Math.round(n / 2 ** 20)
const procWrite = () => {
  try {
    return Number(/^write_bytes: (\d+)/m.exec(readFileSync('/proc/self/io', 'utf8'))?.[1] ?? 0)
  } catch {
    return 0
  }
}
function rewrite(db: Database, s: number) {
  db.exec('BEGIN IMMEDIATE')
  deleteSearchMessages(db, s)
  for (let m = 0; m < 40; m++) {
    insertSearchMessage(db, s, {
      role: m % 4 === 0 ? 'user' : 'assistant',
      text: text(),
      timestamp: null,
      textTruncated: false
    } as never)
  }
  db.prepare('UPDATE files SET mtime_ms = mtime_ms + 1 WHERE session_row_id = ?').run(s)
  db.exec('COMMIT')
}

it('measures the compacting copy', { timeout: 6 * 3600_000 }, async () => {
  mkdirSync(ROOT, { recursive: true })
  const seedDir = join(ROOT, 'seed')
  const path = join(seedDir, 'session-search.sqlite')
  const sessions = Math.round(32000 / SCALE)
  if (!existsSync(join(seedDir, 'done'))) {
    rmSync(seedDir, { recursive: true, force: true })
    mkdirSync(seedDir, { recursive: true })
    const db = openSessionSearchDatabase(path)
    ensureSessionSearchQuerySchema(db)
    db.exec('BEGIN')
    for (let s = 1; s <= sessions; s++) {
      db.prepare(
        `INSERT INTO sessions(id, agent, session_id, file_path, title, resume_command) VALUES (?, 'claude', ?, ?, ?, 'r')`
      ).run(s, `s${s}`, `/t/${s}.jsonl`, `title ${s}`)
      db.prepare(
        `INSERT INTO files(path, byte_offset, mtime_ms, size_bytes, session_row_id, prefix_hash) VALUES (?, 1000, 1, 1000, ?, ?)`
      ).run(`/t/${s}.jsonl`, s, 'x'.repeat(64))
    }
    db.exec('COMMIT')
    for (let round = 0; round < 3; round++) {
      for (let s = 1; s <= sessions; s++) {
        rewrite(db, s)
      }
    }
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
    writeFileSync(join(seedDir, 'done'), '1')
  }
  out.seedMB = mb(statSync(path).size)
  save()

  const steps: number[] = []
  const real = Trace.traceSessionSearch
  vi.spyOn(Trace, 'traceSessionSearch').mockImplementation((name, run, attributes) => {
    const started = performance.now()
    try {
      return real(name, run, attributes)
    } finally {
      if (name === 'copy') {
        steps.push(performance.now() - started)
      }
    }
  })
  const db = openSessionSearchDatabase(path)
  ensureSessionSearchQuerySchema(db)
  let copied = false
  let peak = 0
  const copying = sessionSearchCopyingPath(path)
  const sizer = setInterval(() => {
    try {
      peak = Math.max(
        peak,
        statSync(copying).size +
          (existsSync(`${copying}-wal`) ? statSync(`${copying}-wal`).size : 0)
      )
    } catch {}
  }, 1000)
  // Light indexing that never pauses the copy: one session rewritten every 5 s.
  let writes = 0
  let rewriteMaxMs = 0
  const writer = setInterval(() => {
    const t = performance.now()
    rewrite(db, 1 + Math.floor(rand() * sessions))
    rewriteMaxMs = Math.max(rewriteMaxMs, performance.now() - t)
    writes++
  }, 5000)
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  const writeStart = procWrite()
  const started = performance.now()
  const copy = new SessionSearchCompactCopy(
    db,
    path,
    () => false,
    () => (copied = true),
    () => true
  )
  while (!copied) {
    await copy.run()
  }
  // Indexing keeps writing until the writer closes; the last step takes those writes in.
  await new Promise((resolve) => setTimeout(resolve, 12_000))
  const completeStart = performance.now()
  out.completed = await copy.complete()
  out.completeMs = Math.round(performance.now() - completeStart)
  out.copied = copied
  out.wallSec = Math.round((performance.now() - started) / 1000)
  clearInterval(writer)
  clearInterval(sizer)
  loop.disable()
  out.steps = steps.length
  out.workSec = Math.round(steps.reduce((a, b) => a + b, 0) / 1000)
  const sorted = steps.toSorted((a, b) => a - b)
  out.stepP50Ms = Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0)
  out.stepP99Ms = Math.round(sorted[Math.floor(sorted.length * 0.99)] ?? 0)
  out.stepMaxMs = Math.round(sorted.at(-1) ?? 0)
  out.lastStepMs = Math.round(steps.at(-1) ?? 0)
  out.eventLoopMaxMs = Math.round(loop.max / 1e6)
  out.writtenMB = mb(procWrite() - writeStart)
  out.peakCopyMB = mb(peak)
  out.concurrentRewrites = writes
  out.rewriteMaxMs = Math.round(rewriteMaxMs)
  out.slowSteps = steps.filter((ms) => ms > 250).length
  const expected = {
    messages: Number(db.prepare('SELECT COUNT(*) n FROM messages').get()!.n),
    hits: Number(
      db.prepare(`SELECT COUNT(*) n FROM messages_fts WHERE messages_fts MATCH ?`).get(words[5]!)!.n
    )
  }
  db.close()
  const swapStart = performance.now()
  out.swapped = await swapInSessionSearchCopy(path)
  out.swapMs = Math.round(performance.now() - swapStart)
  out.finalMB = mb(statSync(path).size)
  const check = new Database(path, { readonly: true })
  out.sameMessages =
    Number(check.prepare('SELECT COUNT(*) n FROM messages').get()!.n) === expected.messages
  out.sameHits =
    Number(
      check
        .prepare(`SELECT COUNT(*) n FROM messages_fts WHERE messages_fts MATCH ?`)
        .get(words[5]!)!.n
    ) === expected.hits
  check.close()
  save()
  console.log('MEASURE', JSON.stringify(out))
})

// When each host's link to Orca Cloud (its bots.list connectorStatus) was last read, and whether that
// read landed, so a surface that must not act on a kept status can wait for one read after it opened.
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'

type LinkRead = { at: number; ok: boolean }

const reads = new Map<ExecutionHostId, LinkRead>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The host's bots.list read landed (ok) or failed; a failed read leaves its kept status unproven. */
export function noteBotHostLinkRead(hostId: ExecutionHostId, ok: boolean, at = Date.now()): void {
  reads.set(hostId, { at, ok })
  listeners.forEach((listener) => listener())
}

/**
 * Whether the host's link to Orca Cloud has been read since this view opened, and that read and every
 * later one landed. `refresh` starts that read (bot-host-refresh.ts's, passed in to keep this module
 * free of the catalog).
 */
export function useBotHostLinkReadSinceOpen(
  hostId: ExecutionHostId,
  refresh: (hostId: ExecutionHostId) => Promise<void>
): boolean {
  const [openedAt] = useState(() => Date.now())
  const read = (): boolean => {
    const last = reads.get(hostId)
    return last !== undefined && last.ok && last.at >= openedAt
  }
  const fresh = useSyncExternalStore(subscribe, read, read)
  useEffect(() => {
    void refresh(hostId)
  }, [hostId, refresh])
  return fresh
}

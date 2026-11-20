// Measurement-only: main-process allocation churn (sampling profile incl. collected objects), heap
// committed vs used over time, and GC time. Enabled by FLEET_HEAP_CHURN=1; not part of the gate's verdict.

export const heapChurnEnabled = process.env.FLEET_HEAP_CHURN === '1'

/** `--js-flags` for one arm: FLEET_JS_FLAGS_OLD / FLEET_JS_FLAGS_NEW. */
export function jsFlagsFor(label) {
  const arm = label.startsWith('new') ? 'NEW' : label.startsWith('old') ? 'OLD' : null
  const flags = arm ? process.env[`FLEET_JS_FLAGS_${arm}`] : undefined
  return flags ? [`--js-flags=${flags}`] : []
}

function installHeapChurn() {
  if (globalThis.__fleetHeapChurn) {
    return 'already'
  }
  const inspector = process.getBuiltinModule('node:inspector')
  const v8 = process.getBuiltinModule('node:v8')
  const perfHooks = process.getBuiltinModule('node:perf_hooks')
  const session = new inspector.Session()
  session.connect()
  const post = (method, params) =>
    new Promise((resolve, reject) =>
      session.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result)))
    )
  const state = { samples: [], gcMs: 0, gcCount: 0, gcMaxMs: 0, gcMajorMs: 0, started: Date.now() }
  const observer = new perfHooks.PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      state.gcMs += entry.duration
      state.gcCount += 1
      state.gcMaxMs = Math.max(state.gcMaxMs, entry.duration)
      // NODE_PERFORMANCE_GC_MAJOR = 4
      if (entry.detail?.kind === 4) {
        state.gcMajorMs += entry.duration
      }
    }
  })
  observer.observe({ entryTypes: ['gc'] })
  const sample = () => {
    const h = v8.getHeapStatistics()
    const spaces = Object.fromEntries(
      v8
        .getHeapSpaceStatistics()
        .map((s) => [s.space_name, [s.space_size, s.space_used_size]])
    )
    state.samples.push({
      t: Date.now() - state.started,
      committed: h.total_heap_size,
      used: h.used_heap_size,
      external: h.external_memory,
      rss: process.memoryUsage.rss(),
      spaces
    })
  }
  sample()
  const timer = setInterval(sample, 2000)
  timer.unref?.()
  globalThis.__fleetHeapChurn = { state, post, timer, observer, session }
  const cpu = process.env.FLEET_CPU_PROFILE === '1'
  state.cpu = cpu
  const startCpu = cpu
    ? post('Profiler.enable')
        .then(() => post('Profiler.setSamplingInterval', { interval: 2000 }))
        .then(() => post('Profiler.start'))
    : Promise.resolve()
  return startCpu.then(() => post('HeapProfiler.enable')).then(() =>
    post('HeapProfiler.startSampling', {
      samplingInterval: 65536,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true
    }).then(() => 'installed')
  )
}

async function finishHeapChurn() {
  const churn = globalThis.__fleetHeapChurn
  if (!churn) {
    return null
  }
  const { state, post, timer, observer, session } = churn
  clearInterval(timer)
  const v8 = process.getBuiltinModule('node:v8')
  const last = v8.getHeapStatistics()
  const { profile } = await post('HeapProfiler.stopSampling')
  const cpuProfile = state.cpu ? (await post('Profiler.stop')).profile : null
  observer.disconnect()
  session.disconnect()
  delete globalThis.__fleetHeapChurn
  // Collected and live samples together = allocation churn by site.
  const bySite = new Map()
  const byFile = new Map()
  let total = 0
  const shortUrl = (url) => {
    const marker = url.lastIndexOf('/out/')
    const tail = marker >= 0 ? url.slice(marker + 1) : url.split('/').slice(-3).join('/')
    return tail || '(native)'
  }
  const walk = (node, stack) => {
    const frame = node.callFrame
    const here = `${frame.functionName || '(anon)'} ${shortUrl(frame.url)}:${frame.lineNumber + 1}`
    const path = [...stack, here].slice(-4)
    if (node.selfSize > 0) {
      total += node.selfSize
      const key = path.slice(-3).join(' < ')
      bySite.set(key, (bySite.get(key) ?? 0) + node.selfSize)
      const file = shortUrl(frame.url)
      byFile.set(file, (byFile.get(file) ?? 0) + node.selfSize)
    }
    for (const child of node.children ?? []) {
      walk(child, path)
    }
  }
  walk(profile.head, [])
  const mb = (bytes) => Math.round(bytes / 1048576)
  function summarizeCpu(cpuProfile, short) {
    const byId = new Map(cpuProfile.nodes.map((node) => [node.id, node]))
    const parent = new Map()
    for (const node of cpuProfile.nodes) {
      for (const child of node.children ?? []) {
        parent.set(child, node.id)
      }
    }
    const keyOf = (node) => {
      const f = node.callFrame
      return f.url ? `${f.functionName || '(anon)'} ${short(f.url)}:${f.lineNumber + 1}` : f.functionName || '(native)'
    }
    const self = new Map()
    const incl = new Map()
    const buckets = new Map()
    let t = cpuProfile.startTime
    let busy = 0
    for (let i = 0; i < cpuProfile.samples.length; i += 1) {
      const delta = (cpuProfile.timeDeltas[i] ?? 0) / 1000
      t += cpuProfile.timeDeltas[i] ?? 0
      const leaf = byId.get(cpuProfile.samples[i])
      const leafKey = keyOf(leaf)
      self.set(leafKey, (self.get(leafKey) ?? 0) + delta)
      if (leafKey === '(idle)' || leafKey === '(program)') {
        continue
      }
      busy += delta
      const bucket = Math.floor((t - cpuProfile.startTime) / 10_000_000)
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + delta)
      const seen = new Set()
      for (let id = leaf.id; id !== undefined; id = parent.get(id)) {
        const key = keyOf(byId.get(id))
        if (!seen.has(key)) {
          seen.add(key)
          incl.set(key, (incl.get(key) ?? 0) + delta)
        }
      }
    }
    const rank = (map, n) =>
      [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, ms]) => [Math.round(ms), key])
    return {
      busyMs: Math.round(busy),
      busyPer10s: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, ms]) => [b * 10, Math.round(ms)]),
      topSelf: rank(self, 40),
      topInclusive: rank(incl, 60)
    }
  }
  const top = (map, n) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key, bytes]) => [mb(bytes), key])
  const committed = state.samples.map((s) => s.committed).sort((a, b) => a - b)
  const used = state.samples.map((s) => s.used).sort((a, b) => a - b)
  const pct = (sorted, p) => mb(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))])
  const lastSample = state.samples.at(-1)
  return {
    seconds: Math.round((Date.now() - state.started) / 1000),
    sampledAllocMb: mb(total),
    committedMb: { p50: pct(committed, 0.5), p90: pct(committed, 0.9), max: pct(committed, 1), end: mb(last.total_heap_size) },
    usedMb: { p50: pct(used, 0.5), p90: pct(used, 0.9), max: pct(used, 1), end: mb(last.used_heap_size) },
    endSpacesMb: lastSample
      ? Object.fromEntries(Object.entries(lastSample.spaces).map(([k, [size, usedSize]]) => [k, [mb(size), mb(usedSize)]]))
      : null,
    rssMb: lastSample ? mb(lastSample.rss) : null,
    gc: { ms: Math.round(state.gcMs), majorMs: Math.round(state.gcMajorMs), count: state.gcCount, maxMs: Math.round(state.gcMaxMs) },
    timeline: state.samples
      .filter((_, i) => i % 5 === 0)
      .map((s) => [Math.round(s.t / 1000), mb(s.committed), mb(s.used)]),
    cpu: cpuProfile ? summarizeCpu(cpuProfile, shortUrl) : null,
    topFiles: top(byFile, 25),
    topSites: top(bySite, 40)
  }
}

export async function startHeapChurn(electronApp) {
  return heapChurnEnabled ? electronApp.evaluate(installHeapChurn) : null
}

export async function reportHeapChurn(electronApp, label) {
  if (!heapChurnEnabled) {
    return
  }
  const summary = await electronApp.evaluate(finishHeapChurn).catch((error) => ({ error: String(error) }))
  console.log(`HEAPCHURN ${label} ${JSON.stringify(summary)}`)
}

/** Measurement-only scenario: many chats stream large tool turns at once through the real native-chat path. */
export async function heavyChatBurst({ page, userDataDir, windowMs }) {
  const { default: fs } = await import('node:fs')
  const { default: path } = await import('node:path')
  const { createChatBurst, pointClaudeAtStub } = await import('./fleet-gate-launch-burst.mjs')
  const stubDir = path.join(path.dirname(userDataDir), 'heavy-stub')
  fs.mkdirSync(stubDir, { recursive: true })
  const script = path.join(import.meta.dirname, 'fleet-gate-heavy-claude-stub.cjs')
  const command = path.join(stubDir, 'claude')
  const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`
  fs.writeFileSync(
    command,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${quote(path.join(stubDir, 'launches.jsonl'))} "$@"\n`
  )
  fs.chmodSync(command, 0o755)
  await pointClaudeAtStub(page, command)
  const chats = Number(process.env.FLEET_HEAVY_CHATS ?? 100)
  const burst = await createChatBurst(page, chats, 0, 'heavy fleet turn')
  await new Promise((resolve) => setTimeout(resolve, windowMs))
  return {
    note: `${burst.sessionIds.length} of ${chats} heavy chats (${burst.refused.length} refused${burst.refused[0] ? `: ${burst.refused[0]}` : ''})`
  }
}

/** Measurement-only: grow the renderer heap, report it as the renderer does, then time renderer loop gaps. */
export async function rendererHeapReads({ page, windowMs }) {
  await page.evaluate(() => {
    globalThis.__fleetHog = []
    for (let i = 0; i < 250; i += 1) {
      globalThis.__fleetHog.push(`${i}`.padEnd(10_000_000, String.fromCharCode(97 + (i % 26))))
    }
  })
  // performance.memory is coarse and cached in renderers; read the real heap over CDP as the probe does.
  const cdp = await page.context().newCDPSession(page)
  const { usedSize, totalSize } = await cdp.send('Runtime.getHeapUsage')
  const { jsHeapSizeLimit } = await page.evaluate(() => ({ jsHeapSizeLimit: performance.memory.jsHeapSizeLimit }))
  await cdp.detach().catch(() => {})
  const grown = {
    usedHeapMB: Math.round(usedSize / 2 ** 20),
    totalHeapMB: Math.round(totalSize / 2 ** 20),
    heapLimitMB: Math.round(jsHeapSizeLimit / 2 ** 20),
    rendererSurface: 'main'
  }
  await page.evaluate((data) => {
    const ticks = { last: performance.now(), max: 0, over250: 0, over1000: 0, totalLateMs: 0 }
    globalThis.__fleetTicks = ticks
    globalThis.__fleetTicker = setInterval(() => {
      const now = performance.now()
      const late = now - ticks.last - 50
      ticks.last = now
      if (late > 0) {
        ticks.max = Math.max(ticks.max, late)
        ticks.totalLateMs += late
        if (late > 250) ticks.over250 += 1
        if (late > 1000) ticks.over1000 += 1
      }
    }, 50)
    window.api.crashReports.recordBreadcrumb({
      name: 'renderer_memory',
      data: { usedHeapMB: data.usedHeapMB, heapLimitMB: data.heapLimitMB, rendererSurface: 'main' }
    })
  }, grown)
  await new Promise((resolve) => setTimeout(resolve, windowMs))
  const ticks = await page.evaluate(() => {
    clearInterval(globalThis.__fleetTicker)
    globalThis.__fleetHog = null
    const t = globalThis.__fleetTicks
    return { maxGapMs: Math.round(t.max), over250: t.over250, over1000: t.over1000, lateMs: Math.round(t.totalLateMs) }
  })
  console.log(`RHEAP ${JSON.stringify({ grown, ticks })}`)
  return { note: `renderer ${grown.usedHeapMB}/${grown.heapLimitMB} MB; loop max gap ${ticks.maxGapMs} ms, >250ms ${ticks.over250}, >1s ${ticks.over1000}` }
}

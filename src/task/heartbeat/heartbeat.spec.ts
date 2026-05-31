/**
 * Heartbeat tests — Pump-driven trigger source.
 *
 * Heartbeat owns a private Pump; ticks are triggered via
 * `heartbeat.runNow()`. The pipeline:
 *   heartbeat.runNow()
 *     → pump.runNow() → onTick
 *     → active-hours pre-filter (skip → emit agent.work.skip directly)
 *     → producer.emit('agent.work.requested')
 *   → agent-work-listener → source-config-driven AgentWorkRunner.run()
 *
 * Post-AgentCenter-retirement + push-stub: heartbeat's source config
 * outputGate is an UNCONDITIONAL skip ('stubbed'). The AI still runs each
 * tick, but nothing is ever delivered to the inbox — heartbeat's trigger
 * chain isn't closed in the current Harness architecture. The old
 * notify_user-inspecting gate + HeartbeatDedup are gone. These tests
 * cover: the stub gate, active-hours pre-filter, enable/disable, and
 * lifecycle. The runner is driven by a mock GenerateRouter and a memory
 * InboxStore.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createEventLog, type EventLog } from '../../core/event-log.js'
import { createListenerRegistry, type ListenerRegistry } from '../../core/listener-registry.js'
import {
  createHeartbeat,
  isWithinActiveHours,
  type Heartbeat,
  type HeartbeatConfig,
} from './heartbeat.js'
import { SessionStore } from '../../core/session.js'
import { createMemoryInboxStore, type IInboxStore } from '../../core/inbox-store.js'
import { AgentWorkRunner } from '../../core/agent-work.js'
import { createAgentWorkListener, type AgentWorkListener } from '../../core/agent-work-listener.js'
import type { GenerateRouter } from '../../core/ai-provider-manager.js'
import type {
  AgentWorkSkipPayload,
} from '../../core/agent-event.js'

vi.mock('../../core/config.js', () => ({
  writeConfigSection: vi.fn(async () => ({})),
}))

function tempPath(ext: string): string {
  return join(tmpdir(), `heartbeat-test-${randomUUID()}.${ext}`)
}

function makeConfig(overrides: Partial<HeartbeatConfig> = {}): HeartbeatConfig {
  return {
    enabled: true,
    every: '30m',
    prompt: 'Check if anything needs attention.',
    activeHours: null,
    ...overrides,
  }
}

// ==================== Mock router ====================
//
// The runner drives router.resolve() → provider.generate(); the heartbeat
// AI runs each tick regardless of the (stubbed) delivery gate. We record
// invocations so tests can assert the AI was / wasn't called.

function createMockRouter() {
  let calls = 0
  const provider = {
    providerTag: 'vercel-ai' as const,
    async *generate() {
      calls++
      yield { type: 'done' as const, result: { text: 'heartbeat observed nothing notable', media: [], toolCalls: [] } }
    },
  }
  const router = { resolve: async () => ({ provider, profile: {} }) } as unknown as GenerateRouter
  return { router, callCount() { return calls } }
}

// ==================== Integration suite ====================

describe('heartbeat', () => {
  let eventLog: EventLog
  let listenerRegistry: ListenerRegistry
  let heartbeat: Heartbeat
  let mockRouter: ReturnType<typeof createMockRouter>
  let session: SessionStore
  let inboxStore: IInboxStore
  let agentWorkListener: AgentWorkListener

  beforeEach(async () => {
    eventLog = await createEventLog({ logPath: tempPath('jsonl') })
    listenerRegistry = createListenerRegistry(eventLog)
    await listenerRegistry.start()

    mockRouter = createMockRouter()
    session = new SessionStore(`test/heartbeat-${randomUUID()}`)
    inboxStore = createMemoryInboxStore()
    const runner = new AgentWorkRunner({
      router: mockRouter.router,
      inboxStore,
    })
    agentWorkListener = createAgentWorkListener({ runner, registry: listenerRegistry })
    await agentWorkListener.start()
  })

  afterEach(async () => {
    heartbeat?.stop()
    agentWorkListener.stop()
    await listenerRegistry.stop()
    await eventLog._resetForTest()
  })

  // ==================== Lifecycle ====================

  describe('lifecycle', () => {
    it('start() is idempotent', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await heartbeat.start()  // no error
    })

    it('start() respects config.enabled', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: false }),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      expect(heartbeat.isEnabled()).toBe(false)
    })
  })

  // ==================== Stubbed push ====================

  describe('stubbed push', () => {
    it('runs the AI but delivers nothing (output gate unconditionally skips)', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await heartbeat.runNow()

      // The skip is emitted with reason='stubbed' — the AI ran, but the
      // gate suppressed delivery.
      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.skip' })).toHaveLength(1)
      })

      const skip = eventLog.recent({ type: 'agent.work.skip' })[0].payload as AgentWorkSkipPayload
      expect(skip.source).toBe('heartbeat')
      expect(skip.reason).toBe('stubbed')

      // AI was invoked (heartbeat still observes each tick)…
      expect(mockRouter.callCount()).toBe(1)
      // …but nothing landed in the inbox, and no done event was emitted.
      const { entries } = await inboxStore.read()
      expect(entries).toHaveLength(0)
      expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(0)
    })

    it('every tick is stubbed — repeated runs never deliver', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      await heartbeat.runNow()
      await heartbeat.runNow()
      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.skip' })).toHaveLength(2)
      })

      const { entries } = await inboxStore.read()
      expect(entries).toHaveLength(0)
      expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(0)
    })
  })

  // ==================== Decoupling ====================

  describe('decoupling', () => {
    it('no longer subscribes to cron.fire (decoupled from cron-engine)', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()

      // Fire a cron.fire event with the legacy __heartbeat__ jobName.
      // Pre-refactor, this would have driven heartbeat. Post-refactor,
      // heartbeat is fully decoupled — no AI call should happen.
      await eventLog.append('cron.fire', {
        jobId: 'legacy-id',
        jobName: '__heartbeat__',
        payload: 'should be ignored',
      })
      await new Promise((r) => setTimeout(r, 50))

      expect(mockRouter.callCount()).toBe(0)
    })
  })

  // ==================== Active Hours ====================

  describe('active hours', () => {
    it('emits agent.work.skip with reason=outside-active-hours, without invoking AI', async () => {
      const fakeNow = new Date('2025-06-15T03:00:00').getTime() // 3 AM local

      heartbeat = createHeartbeat({
        config: makeConfig({
          activeHours: { start: '09:00', end: '22:00', timezone: 'local' },
        }),
        agentWorkListener, registry: listenerRegistry, session,
        now: () => fakeNow,
      })
      await heartbeat.start()
      await heartbeat.runNow()

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.skip' })).toHaveLength(1)
      })

      const skip = eventLog.recent({ type: 'agent.work.skip' })[0].payload as AgentWorkSkipPayload
      expect(skip.source).toBe('heartbeat')
      expect(skip.reason).toBe('outside-active-hours')
      // AI never invoked (pre-emit gate, no token cost)
      expect(mockRouter.callCount()).toBe(0)
      // No agent.work.requested emitted for heartbeat
      const reqs = eventLog.recent({ type: 'agent.work.requested' })
      expect(reqs.filter(e => (e.payload as { source: string }).source === 'heartbeat')).toHaveLength(0)
    })
  })

  // ==================== stop ====================

  describe('stop', () => {
    it('runNow is a no-op after stop()', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig(),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      heartbeat.stop()

      await heartbeat.runNow()
      await new Promise((r) => setTimeout(r, 50))

      expect(mockRouter.callCount()).toBe(0)
    })
  })

  // ==================== setEnabled ====================

  describe('setEnabled', () => {
    it('enables a previously disabled heartbeat', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: false }),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      expect(heartbeat.isEnabled()).toBe(false)

      await heartbeat.setEnabled(true)
      expect(heartbeat.isEnabled()).toBe(true)
    })

    it('disables an enabled heartbeat', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: true }),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      expect(heartbeat.isEnabled()).toBe(true)

      await heartbeat.setEnabled(false)
      expect(heartbeat.isEnabled()).toBe(false)
    })

    it('persists config via writeConfigSection', async () => {
      const { writeConfigSection } = await import('../../core/config.js')

      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: false }),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      await heartbeat.setEnabled(true)

      expect(writeConfigSection).toHaveBeenCalledWith(
        'heartbeat',
        expect.objectContaining({ enabled: true }),
      )
    })

    it('runNow ignores the enabled flag (always fires for manual trigger)', async () => {
      heartbeat = createHeartbeat({
        config: makeConfig({ enabled: false }),
        agentWorkListener, registry: listenerRegistry, session,
      })
      await heartbeat.start()
      // Even though enabled=false, manual runNow should still drive a tick
      // (which then hits the stub gate and skips).
      await heartbeat.runNow()

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.skip' })).toHaveLength(1)
      })
      expect(mockRouter.callCount()).toBe(1)
    })
  })
})

// ==================== Unit: isWithinActiveHours ====================

describe('isWithinActiveHours', () => {
  it('returns true when no active hours configured', () => {
    expect(isWithinActiveHours(null)).toBe(true)
  })

  it('returns true within normal range', () => {
    const ts = todayAt(15, 0).getTime()
    expect(isWithinActiveHours(
      { start: '09:00', end: '22:00', timezone: 'local' }, ts,
    )).toBe(true)
  })

  it('returns false outside normal range', () => {
    const ts = todayAt(3, 0).getTime()
    expect(isWithinActiveHours(
      { start: '09:00', end: '22:00', timezone: 'local' }, ts,
    )).toBe(false)
  })

  it('handles overnight range (22:00 → 06:00)', () => {
    expect(isWithinActiveHours(
      { start: '22:00', end: '06:00', timezone: 'local' },
      todayAt(23, 0).getTime(),
    )).toBe(true)
    expect(isWithinActiveHours(
      { start: '22:00', end: '06:00', timezone: 'local' },
      todayAt(3, 0).getTime(),
    )).toBe(true)
    expect(isWithinActiveHours(
      { start: '22:00', end: '06:00', timezone: 'local' },
      todayAt(12, 0).getTime(),
    )).toBe(false)
  })

  it('handles invalid format gracefully (returns true)', () => {
    expect(isWithinActiveHours(
      { start: 'invalid', end: '22:00', timezone: 'local' },
    )).toBe(true)
  })
})

// ==================== Helpers ====================

function todayAt(h: number, m: number): Date {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d
}

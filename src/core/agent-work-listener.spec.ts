/**
 * AgentWorkListener — comprehensive coverage of the canonical dispatch
 * point for `agent.work.requested` events.
 *
 * Covers: source registry, dispatch by source field, canonical event
 * emission with source + metadata, unknown-source drop behaviour,
 * per-source gate application, multi-source independence.
 *
 * Runs end-to-end through a real eventLog + registry + AgentWorkRunner.
 * Post-AgentCenter-retirement: the runner is driven by a mock
 * GenerateRouter (whose provider yields a scripted ProviderEvent stream)
 * and delivers to a memory InboxStore. The runner internals are covered
 * in agent-work.spec.ts; this file tests the listener in front of it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createEventLog, type EventLog } from './event-log.js'
import { createListenerRegistry, type ListenerRegistry } from './listener-registry.js'
import { createMemoryInboxStore, type IInboxStore } from './inbox-store.js'
import { SessionStore } from './session.js'
import { AgentWorkRunner } from './agent-work.js'
import { createAgentWorkListener, type AgentWorkListener } from './agent-work-listener.js'
import type { GenerateRouter } from './ai-provider-manager.js'
import type { ToolCallSummary } from '../ai-providers/types.js'
import type { AgentWorkDonePayload, AgentWorkSkipPayload, AgentWorkErrorPayload } from './agent-event.js'

// ==================== Helpers ====================

function tempPath(ext: string): string {
  return join(tmpdir(), `agent-work-listener-test-${randomUUID()}.${ext}`)
}

interface MockRouter {
  router: GenerateRouter
  setResult(result: { text?: string; toolCalls?: ToolCallSummary[] }): void
  setShouldThrow(err: Error | null): void
  callCount(): number
}

/** Mocks a GenerateRouter whose resolved provider yields a scripted
 *  ProviderEvent stream ending in a `done` event. Mirrors how the runner
 *  drives router.resolve() → provider.generate() in production. */
function createMockRouter(): MockRouter {
  let result: { text: string; toolCalls: ToolCallSummary[] } = { text: 'mock reply', toolCalls: [] }
  let shouldThrow: Error | null = null
  let calls = 0
  const provider = {
    providerTag: 'vercel-ai' as const,
    async *generate() {
      calls++
      if (shouldThrow) throw shouldThrow
      for (const tc of result.toolCalls) {
        yield { type: 'tool_use' as const, id: tc.id, name: tc.name, input: tc.input }
      }
      yield { type: 'done' as const, result: { text: result.text, media: [], toolCalls: result.toolCalls } }
    },
  }
  const router = { resolve: async () => ({ provider, profile: {} }) } as unknown as GenerateRouter
  return {
    router,
    setResult(next) { result = { text: 'mock reply', toolCalls: [], ...next } },
    setShouldThrow(err) { shouldThrow = err },
    callCount() { return calls },
  }
}

// ==================== Test suite ====================

describe('AgentWorkListener', () => {
  let eventLog: EventLog
  let registry: ListenerRegistry
  let mockRouter: MockRouter
  let store: IInboxStore
  let runner: AgentWorkRunner
  let listener: AgentWorkListener

  beforeEach(async () => {
    eventLog = await createEventLog({ logPath: tempPath('jsonl') })
    registry = createListenerRegistry(eventLog)
    await registry.start()
    mockRouter = createMockRouter()
    store = createMemoryInboxStore()
    runner = new AgentWorkRunner({
      router: mockRouter.router,
      inboxStore: store,
      logger: { warn: vi.fn(), error: vi.fn() },
    })
    listener = createAgentWorkListener({
      runner,
      registry,
      logger: { warn: vi.fn(), error: vi.fn() },
    })
    await listener.start()
  })

  afterEach(async () => {
    listener.stop()
    await registry.stop()
    await eventLog._resetForTest()
  })

  // ==================== Source registry ====================

  describe('source registry', () => {
    it('starts empty', () => {
      expect(listener.listSources()).toEqual([])
    })

    it('registers a source', () => {
      listener.registerSource({
        source: 'cron',
        session: new SessionStore('test/cron'),
        preamble: () => 'cron context',
      })
      expect(listener.listSources()).toEqual(['cron'])
    })

    it('registers multiple sources', () => {
      listener.registerSource({ source: 'cron', session: new SessionStore('test/cron'), preamble: () => 'a' })
      listener.registerSource({ source: 'heartbeat', session: new SessionStore('test/hb'), preamble: () => 'b' })
      listener.registerSource({ source: 'task', session: new SessionStore('test/task'), preamble: () => 'c' })
      expect([...listener.listSources()].sort()).toEqual(['cron', 'heartbeat', 'task'])
    })

    it('re-registering the same source overwrites', () => {
      const preamble1 = vi.fn(() => 'first')
      const preamble2 = vi.fn(() => 'second')
      listener.registerSource({ source: 'cron', session: new SessionStore('test/cron'), preamble: preamble1 })
      listener.registerSource({ source: 'cron', session: new SessionStore('test/cron'), preamble: preamble2 })
      expect(listener.listSources()).toEqual(['cron'])
    })
  })

  // ==================== Dispatch ====================

  describe('dispatch by source field', () => {
    it('routes to the matching source config', async () => {
      const preambleCron = vi.fn(() => 'cron preamble')
      const preambleHb = vi.fn(() => 'hb preamble')
      listener.registerSource({ source: 'cron', session: new SessionStore('test/cron'), preamble: preambleCron })
      listener.registerSource({ source: 'heartbeat', session: new SessionStore('test/hb'), preamble: preambleHb })

      await eventLog.append('agent.work.requested', {
        source: 'cron',
        prompt: 'do cron work',
      })
      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(1)
      })
      expect(preambleCron).toHaveBeenCalled()
      expect(preambleHb).not.toHaveBeenCalled()
    })

    it('emits agent.work.done with the source baked into payload', async () => {
      listener.registerSource({ source: 'task', session: new SessionStore('test/task'), preamble: () => 'task' })
      mockRouter.setResult({ text: 'task reply' })

      await eventLog.append('agent.work.requested', {
        source: 'task',
        prompt: 'task prompt',
      })
      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(1)
      })

      const done = eventLog.recent({ type: 'agent.work.done' })[0].payload as AgentWorkDonePayload
      expect(done.source).toBe('task')
      expect(done.reply).toBe('task reply')
      expect(done.delivered).toBe(true)
    })

    it('threads payload metadata through preamble', async () => {
      const preamble = vi.fn((meta?: Record<string, unknown>) => `job=${meta?.jobName ?? '?'}`)
      listener.registerSource({ source: 'cron', session: new SessionStore('test/cron'), preamble })

      await eventLog.append('agent.work.requested', {
        source: 'cron',
        prompt: 'p',
        metadata: { jobName: 'daily-report', jobId: 'abc' },
      })
      await vi.waitFor(() => {
        expect(preamble).toHaveBeenCalled()
      })
      expect(preamble.mock.calls[0][0]).toEqual({ jobName: 'daily-report', jobId: 'abc' })
    })

    it('passes metadata through to agent.work.done payload via default builder', async () => {
      listener.registerSource({ source: 'cron', session: new SessionStore('test/cron'), preamble: () => 'p' })

      await eventLog.append('agent.work.requested', {
        source: 'cron',
        prompt: 'p',
        metadata: { jobId: 'job-1', jobName: 'daily' },
      })
      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(1)
      })

      const done = eventLog.recent({ type: 'agent.work.done' })[0].payload as AgentWorkDonePayload
      expect(done.metadata).toEqual({ jobId: 'job-1', jobName: 'daily' })
    })

    it('per-source buildDoneMetadata overrides the default', async () => {
      listener.registerSource({
        source: 'cron',
        session: new SessionStore('test/cron'),
        preamble: () => 'p',
        buildDoneMetadata: () => ({ derived: 'custom' }),
      })

      await eventLog.append('agent.work.requested', {
        source: 'cron',
        prompt: 'p',
        metadata: { jobId: 'job-1' },
      })
      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(1)
      })

      const done = eventLog.recent({ type: 'agent.work.done' })[0].payload as AgentWorkDonePayload
      expect(done.metadata).toEqual({ derived: 'custom' })
    })
  })

  // ==================== Unknown source ====================

  describe('unknown source', () => {
    it('drops the event silently and logs a warning', async () => {
      const logger = { warn: vi.fn(), error: vi.fn() }
      // Re-create listener with our logger
      listener.stop()
      listener = createAgentWorkListener({ runner, registry, logger })
      await listener.start()

      // No source registered. Send an event.
      await eventLog.append('agent.work.requested', {
        source: 'cron',
        prompt: 'orphan',
      })

      // Wait briefly to ensure handler had a chance to run
      await new Promise((r) => setTimeout(r, 50))

      expect(logger.warn).toHaveBeenCalled()
      expect(logger.warn.mock.calls[0][0]).toContain('no source registered')
      // No done / skip / error emitted
      expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(0)
      expect(eventLog.recent({ type: 'agent.work.skip' })).toHaveLength(0)
      expect(eventLog.recent({ type: 'agent.work.error' })).toHaveLength(0)
    })
  })

  // ==================== Gate application ====================

  describe('outputGate from source config', () => {
    /** Generic tool-inspecting gate: deliver the args of a `push` tool
     *  call, else skip with reason=ack. This is the idiom the (deleted)
     *  notify_user gate used; the listener must thread it to the runner. */
    function pushToolGate(probe: { text: string; media: unknown[]; toolCalls: ReadonlyArray<ToolCallSummary> }) {
      const call = probe.toolCalls.find((c) => c.name === 'push')
      if (!call) return { kind: 'skip' as const, reason: 'ack', payload: {} }
      const text = ((call.input ?? {}) as { text?: string }).text ?? ''
      return { kind: 'deliver' as const, text, media: probe.media as never }
    }

    it('delivers the tool args when AI calls the push tool', async () => {
      listener.registerSource({
        source: 'heartbeat',
        session: new SessionStore('test/hb'),
        preamble: () => 'hb',
        outputGate: pushToolGate,
      })
      mockRouter.setResult({
        text: 'raw',
        toolCalls: [{ id: 't1', name: 'push', input: { text: 'BTC alert' } }],
      })

      await eventLog.append('agent.work.requested', {
        source: 'heartbeat',
        prompt: 'check market',
      })
      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(1)
      })

      const done = eventLog.recent({ type: 'agent.work.done' })[0].payload as AgentWorkDonePayload
      expect(done.source).toBe('heartbeat')
      expect(done.delivered).toBe(true)

      // What actually landed in the inbox is the gate's text
      const { entries } = await store.read()
      expect(entries[0].comments).toBe('BTC alert')
      expect(entries[0].workspaceId).toBe('automation:heartbeat')
    })

    it('skips when outputGate returns skip — emits agent.work.skip', async () => {
      listener.registerSource({
        source: 'heartbeat',
        session: new SessionStore('test/hb'),
        preamble: () => 'hb',
        outputGate: pushToolGate,
      })
      mockRouter.setResult({ text: 'no push intent', toolCalls: [] })

      await eventLog.append('agent.work.requested', {
        source: 'heartbeat',
        prompt: 'check market',
      })
      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.skip' })).toHaveLength(1)
      })

      const skip = eventLog.recent({ type: 'agent.work.skip' })[0].payload as AgentWorkSkipPayload
      expect(skip.source).toBe('heartbeat')
      expect(skip.reason).toBe('ack')
      expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(0)
    })

    it('onDelivered runs on successful delivery, not on skip', async () => {
      const onDelivered = vi.fn()
      listener.registerSource({
        source: 'heartbeat',
        session: new SessionStore('test/hb'),
        preamble: () => 'hb',
        outputGate: pushToolGate,
        onDelivered,
      })

      // Skip case — no push call
      mockRouter.setResult({ text: '', toolCalls: [] })
      await eventLog.append('agent.work.requested', { source: 'heartbeat', prompt: 'p1' })
      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.skip' })).toHaveLength(1)
      })
      expect(onDelivered).not.toHaveBeenCalled()

      // Deliver case
      mockRouter.setResult({
        text: 'r',
        toolCalls: [{ id: 't1', name: 'push', input: { text: 'real alert' } }],
      })
      await eventLog.append('agent.work.requested', { source: 'heartbeat', prompt: 'p2' })
      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(1)
      })
      expect(onDelivered).toHaveBeenCalledTimes(1)
      expect(onDelivered.mock.calls[0][0]).toBe('real alert')
    })
  })

  // ==================== Errors ====================

  describe('errors', () => {
    it('emits agent.work.error with source on AI failure', async () => {
      listener.registerSource({
        source: 'cron',
        session: new SessionStore('test/cron'),
        preamble: () => 'cron',
      })
      mockRouter.setShouldThrow(new Error('AI down'))

      await eventLog.append('agent.work.requested', { source: 'cron', prompt: 'p' })
      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.error' })).toHaveLength(1)
      })

      const err = eventLog.recent({ type: 'agent.work.error' })[0].payload as AgentWorkErrorPayload
      expect(err.source).toBe('cron')
      expect(err.error).toBe('AI down')
    })

    it('per-source buildErrorMetadata flows through to the error payload', async () => {
      listener.registerSource({
        source: 'cron',
        session: new SessionStore('test/cron'),
        preamble: () => 'cron',
        buildErrorMetadata: (_req, err) => ({ jobId: 'failed-job', errorClass: err.name }),
      })
      mockRouter.setShouldThrow(new Error('explode'))

      await eventLog.append('agent.work.requested', {
        source: 'cron',
        prompt: 'p',
        metadata: { jobId: 'job-99' },
      })
      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.error' })).toHaveLength(1)
      })

      const err = eventLog.recent({ type: 'agent.work.error' })[0].payload as AgentWorkErrorPayload
      expect(err.metadata).toEqual({ jobId: 'failed-job', errorClass: 'Error' })
    })
  })

  // ==================== Concurrent independent sources ====================

  describe('multi-source independence', () => {
    it('two sources can be active and both work', async () => {
      listener.registerSource({ source: 'cron', session: new SessionStore('test/cron'), preamble: () => 'a' })
      listener.registerSource({ source: 'task', session: new SessionStore('test/task'), preamble: () => 'b' })

      await eventLog.append('agent.work.requested', { source: 'cron', prompt: 'cron work' })
      await eventLog.append('agent.work.requested', { source: 'task', prompt: 'task work' })

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(2)
      })

      const done = eventLog.recent({ type: 'agent.work.done' }).map(e => (e.payload as AgentWorkDonePayload).source)
      expect(done.sort()).toEqual(['cron', 'task'])
    })
  })

  // ==================== Lifecycle ====================

  describe('lifecycle', () => {
    it('stop() removes the listener from the registry', async () => {
      listener.registerSource({ source: 'cron', session: new SessionStore('test/cron'), preamble: () => 'p' })
      listener.stop()

      await eventLog.append('agent.work.requested', { source: 'cron', prompt: 'after stop' })
      await new Promise((r) => setTimeout(r, 50))

      expect(mockRouter.callCount()).toBe(0)
      expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(0)
    })
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createEventLog, type EventLog } from '../../core/event-log.js'
import { createListenerRegistry, type ListenerRegistry } from '../../core/listener-registry.js'
import { createCronListener, type CronListener } from './listener.js'
import { SessionStore } from '../../core/session.js'
import type { CronFirePayload } from './engine.js'
import { createMemoryInboxStore, type IInboxStore } from '../../core/inbox-store.js'
import { AgentWorkRunner } from '../../core/agent-work.js'
import { createAgentWorkListener, type AgentWorkListener } from '../../core/agent-work-listener.js'
import type { GenerateRouter } from '../../core/ai-provider-manager.js'
import type { AgentWorkDonePayload, AgentWorkErrorPayload } from '../../core/agent-event.js'

function tempPath(ext: string): string {
  return join(tmpdir(), `cron-listener-test-${randomUUID()}.${ext}`)
}

// ==================== Mock router ====================
//
// Post-AgentCenter-retirement the runner drives GenerateRouter directly:
// router.resolve() → provider.generate(entries, prompt, opts), consuming
// the ProviderEvent stream up to the terminal `done` event. The mock
// records the prompt it was driven with and can be set to throw.

function createMockRouter(initialText = 'AI reply') {
  let response = initialText
  let shouldFail = false
  const calls: Array<{ prompt: string }> = []
  const provider = {
    providerTag: 'vercel-ai' as const,
    async *generate(_entries: unknown, prompt: string) {
      calls.push({ prompt })
      if (shouldFail) throw new Error('engine error')
      yield { type: 'done' as const, result: { text: response, media: [], toolCalls: [] } }
    },
  }
  const router = { resolve: async () => ({ provider, profile: {} }) } as unknown as GenerateRouter
  return {
    router,
    calls,
    setResponse(text: string) { response = text },
    setShouldFail(val: boolean) { shouldFail = val },
    callCount() { return calls.length },
  }
}

describe('cron listener', () => {
  let eventLog: EventLog
  let registry: ListenerRegistry
  let cronListener: CronListener
  let agentWorkListener: AgentWorkListener
  let mockRouter: ReturnType<typeof createMockRouter>
  let session: SessionStore
  let inboxStore: IInboxStore

  beforeEach(async () => {
    eventLog = await createEventLog({ logPath: tempPath('jsonl') })
    registry = createListenerRegistry(eventLog)
    await registry.start()
    mockRouter = createMockRouter()
    session = new SessionStore(`test/cron-${randomUUID()}`)
    inboxStore = createMemoryInboxStore()

    const runner = new AgentWorkRunner({
      router: mockRouter.router,
      inboxStore,
    })
    agentWorkListener = createAgentWorkListener({ runner, registry })
    await agentWorkListener.start()

    cronListener = createCronListener({
      agentWorkListener,
      registry,
      session,
    })
    await cronListener.start()
  })

  afterEach(async () => {
    cronListener.stop()
    agentWorkListener.stop()
    await registry.stop()
    await eventLog._resetForTest()
  })

  // ==================== Basic functionality ====================

  describe('event handling', () => {
    it('emits agent.work.requested on cron.fire', async () => {
      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Check the market',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.requested' })).toHaveLength(1)
      })

      const req = eventLog.recent({ type: 'agent.work.requested' })[0].payload as { source: string; prompt: string; metadata: { jobId: string; jobName: string } }
      expect(req.source).toBe('cron')
      expect(req.prompt).toBe('Check the market')
      expect(req.metadata).toEqual({ jobId: 'abc12345', jobName: 'test-job' })
    })

    it('downstream agent.work.done payload carries source=cron + reply', async () => {
      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Do something',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(1)
      })

      const done = eventLog.recent({ type: 'agent.work.done' })[0]
      const payload = done.payload as AgentWorkDonePayload
      expect(payload.source).toBe('cron')
      expect(payload.reply).toBe('AI reply')
      expect(payload.durationMs).toBeGreaterThanOrEqual(0)
      expect(payload.delivered).toBe(true)
      expect(payload.metadata).toMatchObject({ jobId: 'abc12345', jobName: 'test-job' })
      // causality: done is caused by the requested event, which is caused by fire
      expect(typeof done.causedBy).toBe('number')
    })

    it('drops internal __*__ job names without forwarding to agent-work', async () => {
      // Pump-driven services (heartbeat / snapshot) reserve the `__*__`
      // namespace. Migration 0004 prunes any such entries from the on-disk
      // cron store on upgrade, but a downgrade / manual edit / future
      // refactor could re-introduce one. The listener guard is the last
      // line of defense — orphan exists on disk but never reaches AI.
      await eventLog.append('cron.fire', {
        jobId: '18128a16',
        jobName: '__snapshot__',
        payload: '',
      } satisfies CronFirePayload)

      await new Promise((r) => setTimeout(r, 50))

      expect(eventLog.recent({ type: 'agent.work.requested' })).toHaveLength(0)
      expect(mockRouter.callCount()).toBe(0)
    })

    it('does not react to other event types', async () => {
      await eventLog.append('message.received' as never, { channel: 'web', to: 'x', prompt: 'p' })
      await new Promise((r) => setTimeout(r, 50))
      expect(mockRouter.callCount()).toBe(0)
    })
  })

  // ==================== Delivery ====================

  describe('delivery', () => {
    it('appends AI reply to the inbox under automation:cron', async () => {
      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Hello',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.done' })).toHaveLength(1)
      })

      const { entries } = await inboxStore.read()
      expect(entries).toHaveLength(1)
      expect(entries[0].comments).toBe('AI reply')
      expect(entries[0].workspaceId).toBe('automation:cron')
    })
  })

  // ==================== Error handling ====================

  describe('error handling', () => {
    it('emits agent.work.error on engine failure', async () => {
      mockRouter.setShouldFail(true)

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Will fail',
      } satisfies CronFirePayload)

      await vi.waitFor(() => {
        expect(eventLog.recent({ type: 'agent.work.error' })).toHaveLength(1)
      })

      const err = eventLog.recent({ type: 'agent.work.error' })[0].payload as AgentWorkErrorPayload
      expect(err.source).toBe('cron')
      expect(err.error).toBe('engine error')
      expect(err.metadata).toMatchObject({ jobId: 'abc12345', jobName: 'test-job' })
    })
  })

  // ==================== Lifecycle ====================

  describe('lifecycle', () => {
    it('stops emitting after registry.stop()', async () => {
      await registry.stop()

      await eventLog.append('cron.fire', {
        jobId: 'abc12345',
        jobName: 'test-job',
        payload: 'Should not fire',
      } satisfies CronFirePayload)

      await new Promise((r) => setTimeout(r, 50))

      expect(mockRouter.callCount()).toBe(0)
    })

    it('is idempotent on repeated start()', async () => {
      await cronListener.start()
      // No error
    })
  })
})

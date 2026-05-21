/**
 * Composition root for the Workspaces feature.
 *
 * Wraps the launcher's domain modules (registry, pool, creator, template-
 * registry, adapters, transcript-watcher, scrollback-store) into a single
 * `WorkspaceService` consumed by the HTTP routes and WS upgrade handler.
 *
 * Lifecycle: `createWorkspaceService()` at plugin start; `dispose()` at stop.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { shellAdapter } from './adapters/shell.js';
import { AdapterRegistry, type CliAdapter } from './cli-adapter.js';
import { loadConfig, type ServerConfig } from './config.js';
import { logger as launcherLogger } from './logger.js';
import { ScrollbackStore } from './scrollback-store.js';
import { SessionPool, type SessionFactoryContext } from './session-pool.js';
import { SessionRegistry } from './session-registry.js';
import { buildSpawnEnv } from './spawn-env.js';
import { TemplateRegistry } from './template-registry.js';
import { TranscriptWatcher } from './transcript-watcher.js';
import { WorkspaceCreator } from './workspace-creator.js';
import { WorkspaceRegistry, type WorkspaceMeta } from './workspace-registry.js';

export interface WorkspaceService {
  readonly config: ServerConfig;
  readonly registry: WorkspaceRegistry;
  readonly sessionRegistry: SessionRegistry;
  readonly scrollbackStore: ScrollbackStore;
  readonly templates: TemplateRegistry;
  readonly adapters: AdapterRegistry;
  readonly creator: WorkspaceCreator;
  readonly pool: SessionPool;
  readonly transcriptWatcher: TranscriptWatcher;
  resolveAdapter(meta: WorkspaceMeta, agentId?: string): CliAdapter;
  publicMeta(w: WorkspaceMeta): Promise<unknown>;
  isShuttingDown(): boolean;
  dispose(reason: string): Promise<void>;
}

export interface CreateWorkspaceServiceOptions {
  /** Backend's bound web port — used to derive the CORS allowlist. */
  readonly webPort: number;
  /** Backend's bound MCP port — injected as `OPENALICE_MCP_URL` into each
   *  PTY's env so workspace `mcp.json` templates' `${OPENALICE_MCP_URL:-...}`
   *  fallback bridge resolves to the live backend (not whatever was the
   *  default in template files). */
  readonly mcpPort: number;
}

export async function createWorkspaceService(opts: CreateWorkspaceServiceOptions): Promise<WorkspaceService> {
  const config = loadConfig({ webPort: opts.webPort });

  const registry = await WorkspaceRegistry.load(
    `${config.launcherRoot}/workspaces.json`,
    launcherLogger.child({ scope: 'registry' }),
  );

  const sessionRegistry = await SessionRegistry.load(
    join(config.launcherRoot, 'state'),
    launcherLogger.child({ scope: 'session-registry' }),
  );

  const scrollbackStore = new ScrollbackStore(
    join(config.launcherRoot, 'state'),
    launcherLogger.child({ scope: 'scrollback' }),
  );

  const templates = await TemplateRegistry.load(
    config.templatesDir,
    launcherLogger.child({ scope: 'templates' }),
  );
  if (config.legacyBootstrapScript) {
    launcherLogger.warn('config.legacy_bootstrap_script', {
      script: config.legacyBootstrapScript,
    });
    templates.registerSynthetic({
      name: 'legacy',
      description: 'legacy AQ_BOOTSTRAP_SCRIPT entry — migrate to a real template',
      bootstrapScript: config.legacyBootstrapScript,
      filesDir: '',
      defaultAgents: ['claude'],
    });
  }

  const adapters = new AdapterRegistry();
  adapters.register(claudeAdapter, { default: true });
  adapters.register(codexAdapter);
  adapters.register(shellAdapter);

  const creator = new WorkspaceCreator({
    workspacesRoot: `${config.launcherRoot}/workspaces`,
    templateRegistry: templates,
    adapterRegistry: adapters,
    bootstrapEnv: {
      templateDir: config.templateDir,
      launcherRepoRoot: config.launcherRepoRoot,
    },
    bootstrapTimeoutMs: config.bootstrapTimeoutMs,
    registry,
    logger: launcherLogger.child({ scope: 'creator' }),
  });

  const transcriptWatcher = new TranscriptWatcher(
    launcherLogger.child({ scope: 'transcript-watch' }),
    sessionRegistry,
  );

  const resolveAdapter = (wsMeta: WorkspaceMeta, agentId?: string): CliAdapter => {
    if (agentId) {
      const a = adapters.get(agentId);
      if (a) return a;
    }
    const fromWorkspace = wsMeta.agents[0];
    if (fromWorkspace) {
      const a = adapters.get(fromWorkspace);
      if (a) return a;
    }
    return adapters.resolve(null);
  };

  const pool = new SessionPool(
    (wsId, ctx) => {
      const ws = registry.get(wsId);
      if (!ws) throw new Error(`workspace not found: ${wsId}`);
      const adapter = resolveAdapter(ws, ctx.agentId);
      const baseEnv = buildSpawnEnv(process.env, {
        AQ_WS_ID: wsId,
        AQ_LAUNCHER_REPO_ROOT: config.launcherRepoRoot,
        // Tells workspace templates' `${OPENALICE_MCP_URL:-...}` substitution
        // where to find the backend's MCP endpoint at spawn time. Without
        // this, Claude Code / Codex inside the workspace would fall back to
        // the template-default port literal which may not match the actual
        // backend (guardian can pick a different port if the default is taken).
        OPENALICE_MCP_URL: `http://127.0.0.1:${opts.mcpPort}/mcp`,
      }, ws.dir);
      const spawnCtx = {
        ...(ctx.resume !== undefined ? { resume: ctx.resume } : {}),
        cwd: ws.dir,
        env: baseEnv,
      };
      // Adapter-contributed env (e.g. codex sets CODEX_HOME=<cwd>/.codex so
      // the CLI reads workspace-local config). Merged AFTER baseEnv so the
      // adapter wins on key collisions.
      const adapterEnv = adapter.composeEnv?.(spawnCtx) ?? {};
      const env = { ...baseEnv, ...adapterEnv };
      return {
        opts: {
          command: adapter.composeCommand(config.command, spawnCtx),
          cwd: ws.dir,
          env,
          initialCols: 80,
          initialRows: 24,
          logger: launcherLogger.child({ scope: 'session', wsId, agent: adapter.id }),
          replayBufferBytes: config.replayBufferBytes,
          highWatermarkBytes: config.bpHighWatermarkBytes,
          lowWatermarkBytes: config.bpLowWatermarkBytes,
          ...(ctx.initialReplayBytes ? { initialReplayBytes: ctx.initialReplayBytes } : {}),
        },
        adapter,
      };
    },
    launcherLogger.child({ scope: 'pool' }),
    transcriptWatcher,
  );

  let shuttingDown = false;

  const publicMeta = async (w: WorkspaceMeta): Promise<unknown> => {
    const live = pool.liveSessionsFor(w.id);
    await sessionRegistry.ensureLoaded(w.id).catch(() => undefined);
    const liveById = new Map(live.map((l) => [l.id, l]));
    const sessions = sessionRegistry.listFor(w.id).map((r) => {
      const liveEntry = liveById.get(r.id);
      return {
        id: r.id,
        wsId: r.wsId,
        agent: r.agent,
        name: r.name,
        createdAt: r.createdAt,
        lastActiveAt: r.lastActiveAt,
        state: r.state === 'running' && liveEntry ? 'running' : 'paused',
        agentSessionId: liveEntry?.agentSessionId ?? r.resumeHint?.value ?? null,
        pid: liveEntry?.pid ?? null,
        startedAt: liveEntry?.startedAt ?? null,
      };
    });
    // Workspace AI provider override signals — read by the Overview
    // dashboard for the "⚙ Workspace override" footer per card. Cheap
    // (single statSync each) so it's safe on the regular list poll.
    const agentOverride = {
      claude: existsSync(join(w.dir, '.claude', 'settings.local.json')),
      codex: existsSync(join(w.dir, '.codex')),
    };
    return { ...w, sessions, agentOverride };
  };

  const dispose = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    launcherLogger.info('workspaces.dispose', { reason, activeSessions: pool.size() });
    pool.disposeAll('plugin shutdown');
    transcriptWatcher.disposeAll();
  };

  return {
    config,
    registry,
    sessionRegistry,
    scrollbackStore,
    templates,
    adapters,
    creator,
    pool,
    transcriptWatcher,
    resolveAdapter,
    publicMeta,
    isShuttingDown: () => shuttingDown,
    dispose,
  };
}

export type { SessionFactoryContext };

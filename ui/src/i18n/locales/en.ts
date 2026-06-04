/**
 * English catalog — the SOURCE OF TRUTH for message keys. `zh`/`ja` are typed
 * against `Resources` (this shape with widened string leaves), so a missing or
 * extra key in a translation is a compile error. i18next key autocompletion is
 * driven off `typeof en` via CustomTypeOptions (see ../i18n.d.ts).
 *
 * Scope reminder: this catalog covers UI chrome ONLY. Never add agent-facing
 * copy here (skills / persona / templates / tool descriptions live in src/ and
 * are read by the model — translating them degrades behavior). The catalog
 * physically cannot import from src/, which keeps the boundary structural.
 *
 * Interpolation uses i18next `{{var}}` syntax.
 */

export const en = {
  nav: {
    item: {
      inbox: 'Inbox',
      tracked: 'Tracked',
      chat: 'Chat',
      workspaces: 'Workspaces',
      market: 'Market',
      news: 'News',
      tradingAsGit: 'Trading as Git',
      portfolio: 'Portfolio',
      automation: 'Automation',
      settings: 'Settings',
      dev: 'Dev',
    },
    section: {
      beta: 'Beta',
      system: 'System',
    },
    betaDescription:
      "Functional but not yet dependable. Trading-as-Git and Portfolio surface cross-broker unified state whose underlying abstraction is still being settled — try them, but don't depend on schema or UX as stable yet. Automation runs, but its trigger chain isn't closed in the current Harness architecture, so it can't fire end-to-end until Harness scheduling lands. Broker connection setup lives in Settings → Trading.",
    unread: '{{count}} unread',
    about: 'About {{label}}',
  },
  settings: {
    title: 'Settings',
    tab: {
      settings: 'Settings',
      tools: 'Tools',
    },
    language: {
      title: 'Language',
      description: 'Interface language. Takes effect immediately.',
    },
    agent: {
      title: 'Agent',
      description: 'Controls file-system and tool permissions for the AI. Changes apply on the next request.',
      evolutionMode: 'Evolution Mode',
      evolutionOn: 'Full project access — AI can modify source code',
      evolutionOff: 'Sandbox mode — AI can only edit data/brain/',
    },
    persona: {
      title: 'Persona',
      description: "The system prompt that defines Alice's personality and behavior. Changes take effect on next server restart.",
      loadError: 'Failed to load persona',
      saveError: 'Failed to save',
      loading: 'Loading...',
      saving: 'Saving...',
      save: 'Save',
      saved: 'Saved',
      unsaved: 'Unsaved changes',
    },
    compaction: {
      title: 'Compaction',
      description: 'Context window management. When conversation size approaches Max Context minus Max Output tokens, older messages are automatically summarized to free up space.',
      maxContextTokens: 'Max Context Tokens',
      maxOutputTokens: 'Max Output Tokens',
    },
    tools: {
      summary: '{{tools}} tools in {{groups}} groups — changes apply on next AI request',
      emptyTitle: 'No tools registered.',
      emptyDescription: 'Tools will appear here when the engine starts.',
      group: {
        thinking: 'Thinking Kit',
        cron: 'Cron Scheduler',
        equity: 'Equity Data',
        cryptoData: 'Crypto Data',
        currencyData: 'Currency Data',
        news: 'News',
        newsArchive: 'News Archive',
        analysis: 'Analysis Kit',
        cryptoTrading: 'Crypto Trading',
        securitiesTrading: 'Securities Trading',
      },
    },
  },
} as const

/** The `en` shape with every string leaf widened to `string` — the contract
 *  each translation catalog must satisfy. */
type Stringify<T> = { [K in keyof T]: T[K] extends string ? string : Stringify<T[K]> }
export type Resources = Stringify<typeof en>

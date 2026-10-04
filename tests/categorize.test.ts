import { describe, expect, it } from 'vitest'

import {
  classifyProductivity,
  explainMatch,
  isIgnored,
  isPrivateSample,
  learnFromRefile,
  learnWords,
  MAX_LEARNED_WORDS,
  pageTitle,
  readAddress,
  resolveCategory,
  titleNamesSite,
  UNCATEGORIZED,
  unlearnWords,
  urlHost,
  wordsOf,
} from '../src/core/categorize'
import type { CategoryRule, Project } from '../src/core/types'

const projects: Project[] = [
  { id: 'p1', name: 'OpenTime', color: '#fff', keywords: ['opentime', 'localhost:5273'] },
  { id: 'p2', name: 'Admin', color: '#fff', keywords: ['invoice', 'payroll'] },
  { id: 'p3', name: 'Archived', color: '#fff', keywords: ['legacy'], archived: true },
]

describe('urlHost', () => {
  it('keeps only the host and port', () => {
    expect(urlHost('https://github.com/acme/repo/pull/12?tab=files')).toBe('github.com')
    expect(urlHost('http://localhost:5273/today')).toBe('localhost:5273')
  })

  it('never leaks a path, query or fragment', () => {
    const host = urlHost('https://mail.example.com/inbox/secret-thread?token=abc123#msg')
    expect(host).toBe('mail.example.com')
    expect(host).not.toContain('token')
  })

  it('returns empty for junk rather than throwing', () => {
    expect(urlHost('not a url')).toBe('')
    expect(urlHost(undefined)).toBe('')
  })
})

describe('resolveCategory precedence', () => {
  const appRule: CategoryRule = { id: 'r1', kind: 'app', match: 'code', category: 'Engineering' }
  const keywordRule: CategoryRule = { id: 'r2', kind: 'keyword', match: 'opentime', category: 'Rebuild' }

  it('prefers a "Matching text" rule over a "Whole app" rule', () => {
    const result = resolveCategory(
      { app: 'Code', title: 'opentime — tracker.ts', url: '' },
      [appRule, keywordRule],
      projects
    )
    expect(result).toMatchObject({ category: 'Rebuild', source: 'keyword-rule' })
  })

  it('lets the project a window names beat a "Whole app" rule', () => {
    // The same app is not the same work: VS Code open on OpenTime is OpenTime.
    const result = resolveCategory({ app: 'Code', title: 'tracker.ts - OpenTime', url: '' }, [appRule], projects)
    expect(result).toMatchObject({ category: 'OpenTime', source: 'name' })
  })

  it('uses a "Whole app" rule when the window names nothing', () => {
    const result = resolveCategory({ app: 'Code', title: 'notes.md', url: '' }, [appRule], projects)
    expect(result).toMatchObject({ category: 'Engineering', source: 'app-rule' })
  })

  it('prefers a keyword rule over a project keyword', () => {
    const result = resolveCategory(
      { app: 'chrome', title: 'opentime dashboard', url: 'github.com' },
      [keywordRule],
      projects
    )
    expect(result).toMatchObject({ category: 'Rebuild', source: 'keyword-rule' })
  })

  it('falls through to a project keyword and says which', () => {
    const result = resolveCategory(
      { app: 'chrome', title: 'March invoice', url: '' },
      [],
      projects
    )
    expect(result).toMatchObject({
      category: 'Admin',
      projectId: 'p2',
      source: 'keyword',
      evidence: ['invoice'],
    })
  })

  it('matches project keywords against the url host too', () => {
    const result = resolveCategory({ app: 'chrome', title: 'Dashboard', url: 'localhost:5273' }, [], projects)
    expect(result.category).toBe('OpenTime')
  })

  it('skips archived projects', () => {
    const result = resolveCategory({ app: 'Code', title: 'legacy migration', url: '' }, [], projects)
    expect(result.category).toBe(UNCATEGORIZED)
  })

  it('is case-insensitive on both sides', () => {
    const result = resolveCategory({ app: 'CODE', title: 'OPENTIME', url: '' }, [], projects)
    expect(result.category).toBe('OpenTime')
  })

  it('returns the default when nothing matches', () => {
    const result = resolveCategory({ app: 'Solitaire', title: 'Klondike', url: '' }, [], projects)
    expect(result).toMatchObject({ category: UNCATEGORIZED, source: 'default' })
  })

  it('carries a productivity override from the winning rule', () => {
    const rule: CategoryRule = {
      id: 'r3',
      kind: 'app',
      match: 'slack',
      category: 'Comms',
      productivity: 'neutral',
    }
    const result = resolveCategory({ app: 'Slack', title: '#general', url: '' }, [rule], projects)
    expect(result.productivity).toBe('neutral')
  })
})

describe('classifyProductivity', () => {
  it('honours a rule override above every heuristic', () => {
    const sample = { app: 'Netflix', title: 'Some show', url: 'netflix.com' }
    const resolution = { category: 'Research', source: 'app-rule' as const, productivity: 'productive' as const }
    expect(classifyProductivity(sample, resolution)).toBe('productive')
  })

  it('marks known leisure as distracting', () => {
    expect(
      classifyProductivity(
        { app: 'chrome', title: 'Watch', url: 'netflix.com' },
        { category: UNCATEGORIZED, source: 'default' }
      )
    ).toBe('distracting')
  })

  it('treats anything the user categorised as productive', () => {
    expect(
      classifyProductivity(
        { app: 'Unknown App', title: 'whatever', url: '' },
        { category: 'Admin', source: 'keyword' }
      )
    ).toBe('productive')
  })

  it('recognises common work tools even when uncategorised', () => {
    expect(
      classifyProductivity(
        { app: 'Visual Studio Code', title: 'index.ts', url: '' },
        { category: UNCATEGORIZED, source: 'default' }
      )
    ).toBe('productive')
  })

  it('defaults to neutral for anything unrecognised', () => {
    expect(
      classifyProductivity(
        { app: 'Calculator', title: '', url: '' },
        { category: UNCATEGORIZED, source: 'default' }
      )
    ).toBe('neutral')
  })
})

describe('isIgnored', () => {
  it('matches case-insensitively', () => {
    expect(isIgnored('1Password', ['1password'])).toBe(true)
    expect(isIgnored('Code', ['1password'])).toBe(false)
  })

  it('ignores nothing when the list is empty', () => {
    expect(isIgnored('Code', [])).toBe(false)
  })
})

describe('isPrivateSample', () => {
  const sample = { app: 'chrome', title: 'Acme Merger — data room', url: 'docs.example.com' }

  it('honours the ignored-app list', () => {
    expect(isPrivateSample({ app: '1Password', title: 'Vault', url: '' }, ['1password'])).toBe(true)
  })

  it('matches a private subject in the window title, whatever the app', () => {
    expect(isPrivateSample(sample, [], ['acme merger'])).toBe(true)
    expect(isPrivateSample({ ...sample, app: 'Word' }, [], ['acme merger'])).toBe(true)
  })

  it('matches a private subject in the host', () => {
    expect(isPrivateSample(sample, [], ['docs.example.com'])).toBe(true)
  })

  it('does not match the app name through the title rule', () => {
    // The keyword list deliberately searches title and host only; matching the
    // app name too would make "chrome" a keyword that hides every web page.
    expect(isPrivateSample(sample, [], ['chrome'])).toBe(false)
  })

  it('records normally when nothing is configured', () => {
    expect(isPrivateSample(sample, [], [])).toBe(false)
    expect(isPrivateSample(sample, [])).toBe(false)
  })

  it('also hides a private subject that is only in the page address', () => {
    const page = { app: 'chrome', title: 'Dashboard', url: 'portal.example.com', address: 'portal.example.com/acme-merger/q3' }
    expect(isPrivateSample(page, [], ['acme-merger'])).toBe(true)
  })
})

describe('readAddress', () => {
  it('reads what Chrome and Edge show, with no scheme', () => {
    expect(readAddress('github.com/ElectricGamer61/OpenTime/pull/11')).toEqual({
      host: 'github.com',
      address: 'github.com/electricgamer61/opentime/pull/11',
    })
  })

  it('drops the query, the fragment and "www."', () => {
    expect(readAddress('https://www.youtube.com/watch?v=abc123#t=4')).toEqual({
      host: 'youtube.com',
      address: 'youtube.com/watch',
    })
  })

  it('keeps a local port, which is how dev servers are told apart', () => {
    expect(readAddress('localhost:5273/today')?.host).toBe('localhost:5273')
  })

  it('refuses what is being typed, and browser pages', () => {
    expect(readAddress('how to edit a video')).toBeNull()
    expect(readAddress('opentime')).toBeNull()
    expect(readAddress('chrome://newtab')).toBeNull()
    expect(readAddress('')).toBeNull()
  })
})

describe('titleNamesSite', () => {
  it('needs the site as a whole part of the title', () => {
    expect(titleNamesSite('lofi beats - YouTube - Google Chrome', 'youtube.com')).toBe(true)
    expect(
      titleNamesSite('Creating your first YouTube introduction video - Claude - Google Chrome', 'youtube.com')
    ).toBe(false)
    expect(titleNamesSite('Channel content - YouTube Studio - Google Chrome', 'youtube.com')).toBe(false)
  })
})

describe('pageTitle', () => {
  it('drops the part of the title that only names the app', () => {
    expect(
      pageTitle({ app: 'Visual Studio Code', title: 'tracker.ts - opentime - Visual Studio Code' })
    ).toBe('tracker.ts - opentime')
    expect(pageTitle({ app: 'DaVinci Resolve', title: 'DaVinci Resolve - BBD Opentime' })).toBe(
      'BBD Opentime'
    )
    expect(pageTitle({ app: 'Claude', title: 'Claude' })).toBe('')
  })
})

describe('matching on what is on screen, not on the app', () => {
  const mine: Project[] = [
    { id: 'p_open', name: 'OpenTime', color: '#fff', keywords: [] },
    { id: 'p_school', name: 'AP Bio', color: '#fff', keywords: ['classroom.google.com'] },
    {
      id: 'p_breaks',
      name: 'Breaks',
      color: '#fff',
      keywords: ['youtube.com', 'x.com'],
      productivity: 'distracting',
    },
  ]

  it('finds a project name however it is spelled', () => {
    for (const title of [
      'DaVinci Resolve - BBD Opentime',
      'open-time notes',
      'ElectricGamer61/OpenTime: A free tracker',
    ]) {
      expect(resolveCategory({ app: 'Anything', title, url: '' }, [], mine)).toMatchObject({
        category: 'OpenTime',
        source: 'name',
      })
    }
    // Part of a longer word is not a mention.
    expect(resolveCategory({ app: 'Anything', title: 'Reopentimes', url: '' }, [], mine).category).toBe(
      UNCATEGORIZED
    )
  })

  it('finds a project in the page address, not just the title', () => {
    const result = resolveCategory(
      {
        app: 'Google Chrome',
        title: 'Pull request #11 - Google Chrome',
        url: 'github.com',
        address: 'github.com/electricgamer61/opentime/pull/11',
      },
      [],
      mine
    )
    expect(result).toMatchObject({ category: 'OpenTime', source: 'name' })
  })

  it('tells a site apart from a chat that mentions it', () => {
    const watching = { app: 'Google Chrome', title: 'Lo-fi mix - YouTube - Google Chrome', url: 'youtube.com' }
    expect(resolveCategory(watching, [], mine)).toMatchObject({
      category: 'Breaks',
      productivity: 'distracting',
    })

    const chatting = {
      app: 'Google Chrome',
      title: 'Creating your first YouTube introduction video - Claude - Google Chrome',
      url: 'claude.ai',
    }
    expect(resolveCategory(chatting, [], mine).category).toBe(UNCATEGORIZED)
  })

  it('matches a site on its subdomains, and never on a lookalike', () => {
    expect(resolveCategory({ app: 'chrome', title: 'Videos', url: 'm.youtube.com' }, [], mine).category).toBe(
      'Breaks'
    )
    expect(resolveCategory({ app: 'chrome', title: 'Files', url: 'dropbox.com' }, [], mine).category).toBe(
      UNCATEGORIZED
    )
  })

  it('falls back to the title for a site when the browser hides the address', () => {
    const hidden = { app: 'Google Chrome', title: 'Lo-fi mix - YouTube - Google Chrome', url: '' }
    expect(resolveCategory(hidden, [], mine).category).toBe('Breaks')
  })

  it('never matches a starter project by its plain-word name', () => {
    const starter: Project[] = [{ id: 'p_writing', name: 'Writing', color: '#fff', keywords: ['obsidian'] }]
    expect(
      resolveCategory({ app: 'chrome', title: 'Tips for writing well', url: '' }, [], starter).category
    ).toBe(UNCATEGORIZED)
  })

  it('does not let the app name inside a title decide', () => {
    const deep: Project[] = [{ id: 'p_deep_work', name: 'Deep Work', color: '#fff', keywords: ['code'] }]
    const vscode = { app: 'Visual Studio Code', title: 'main.ts - opentime - Visual Studio Code', url: '' }
    expect(resolveCategory(vscode, [], [...deep, ...mine]).category).toBe('OpenTime')
    // With nothing else to go on, the app name still counts, just for less.
    expect(resolveCategory({ ...vscode, title: 'main.ts - Visual Studio Code' }, [], deep).category).toBe(
      'Deep Work'
    )
  })

  it('carries the project’s productivity with it', () => {
    const sample = { app: 'chrome', title: 'Home / X', url: 'x.com' }
    expect(classifyProductivity(sample, resolveCategory(sample, [], mine))).toBe('distracting')
  })
})

describe('learned words', () => {
  const chat = {
    app: 'Google Chrome',
    title: 'Creating your first YouTube introduction video - Claude - Google Chrome',
    url: 'claude.ai',
  }
  const video: Project = { id: 'p_video', name: 'Launch video', color: '#fff', keywords: [] }

  it('keeps the words that say something and drops the rest', () => {
    expect(wordsOf(chat)).toEqual(['creating', 'first', 'youtube', 'introduction', 'video', 'claude'])
    expect(wordsOf({ app: 'Code', title: 'index.ts - 2026 - Code' })).toEqual([])
  })

  it('files the next window like one you filed', () => {
    const taught = { ...video, learned: learnWords(undefined, chat) }
    const next = {
      app: 'Google Chrome',
      title: 'Script for my introduction video - Claude - Google Chrome',
      url: 'claude.ai',
    }
    const result = resolveCategory(next, [], [taught])
    expect(result).toMatchObject({ category: 'Launch video', source: 'learned' })
    expect(result.evidence).toEqual(expect.arrayContaining(['introduction', 'video']))
  })

  it('needs more than one shared word, unless that word is well established', () => {
    const taught = { ...video, learned: learnWords(undefined, chat) }
    const once = { app: 'Notepad', title: 'video ideas', url: '' }
    expect(resolveCategory(once, [], [taught]).category).toBe(UNCATEGORIZED)

    const often = { ...video, learned: { video: 3 } }
    expect(resolveCategory(once, [], [often]).category).toBe('Launch video')
  })

  it('ignores a word two projects both know', () => {
    const a: Project = { id: 'a', name: 'Alpha', color: '#fff', keywords: [], learned: { video: 3, edit: 3 } }
    const b: Project = { id: 'b', name: 'Beta', color: '#fff', keywords: [], learned: { video: 3, edit: 3 } }
    expect(resolveCategory({ app: 'x', title: 'video edit', url: '' }, [], [a, b]).category).toBe(
      UNCATEGORIZED
    )
  })

  it('forgets what it learned when a block is moved out', () => {
    expect(unlearnWords(learnWords(undefined, chat), chat)).toEqual({})
  })

  it('learns into the project a block moves to, and unlearns from the one it left', () => {
    const from: Project = { id: 'from', name: 'From', color: '#fff', keywords: [], learned: learnWords(undefined, chat) }
    const to: Project = { id: 'to', name: 'To', color: '#fff', keywords: [] }
    const next = learnFromRefile([from, to], { ...chat, projectId: 'from' }, 'to')!
    expect(next[0].learned).toEqual({})
    expect(next[1].learned).toMatchObject({ introduction: 1, video: 1 })
    // Re-applying the same project teaches nothing twice.
    expect(learnFromRefile(next, { ...chat, projectId: 'to' }, 'to')).toBeNull()
  })

  it('stays bounded', () => {
    let learned: Record<string, number> | undefined
    for (let i = 0; i < MAX_LEARNED_WORDS + 50; i += 1) {
      learned = learnWords(learned, { app: 'x', title: `topic${i}x` })
    }
    expect(Object.keys(learned!).length).toBe(MAX_LEARNED_WORDS)
  })
})

describe('explainMatch', () => {
  it('says why in one sentence', () => {
    expect(explainMatch('name', ['OpenTime'])).toBe('The window mentions “OpenTime”.')
    expect(explainMatch('learned', ['introduction', 'video'])).toContain('“introduction” and “video”')
    expect(explainMatch('context')).toContain('stayed with the work around it')
    expect(explainMatch(undefined)).toBeNull()
  })
})

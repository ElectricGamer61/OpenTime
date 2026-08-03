import { describe, expect, it } from 'vitest'

import {
  classifyProductivity,
  isIgnored,
  resolveCategory,
  UNCATEGORIZED,
  urlHost,
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

  it('prefers an app rule over everything else', () => {
    const result = resolveCategory(
      { app: 'Code', title: 'opentime — tracker.ts', url: '' },
      [appRule, keywordRule],
      projects
    )
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

  it('falls through to a project keyword and reports the project id', () => {
    const result = resolveCategory(
      { app: 'chrome', title: 'March invoice', url: '' },
      [],
      projects
    )
    expect(result).toMatchObject({ category: 'Admin', projectId: 'p2', source: 'project' })
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
        { category: 'Admin', source: 'project' }
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

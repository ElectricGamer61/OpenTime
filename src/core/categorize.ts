/**
 * Categorisation and productivity classification.
 *
 * Rule precedence (adapted from the older Norte tracker's `categorize()`, kept
 * because the ordering is the useful part — most specific user intent wins):
 *
 *   1. explicit per-app rule        ("always call Figma → Design")
 *   2. learned keyword rule         (from a correction in the review panel)
 *   3. project keyword match        (user-defined project keywords)
 *   4. UNCATEGORIZED
 *
 * All matching is done on a single lower-cased haystack of "app title url" so a
 * rule can key off any of the three without three separate code paths.
 */

import type { CategoryRule, Productivity, Project, WindowSample } from './types'

export const UNCATEGORIZED = 'Uncategorized'

/**
 * Apps whose URL we bother to read. Reading a URL forces the browser's
 * accessibility tree on, which has a real (small) cost, so it is browsers only.
 */
export const BROWSER_RE = /chrome|chromium|edge|firefox|brave|arc|opera|vivaldi|safari|zen/i

/**
 * Reduce a URL to host (+ port). Deliberately drops path, query and fragment so
 * OpenTime can never persist a session token, document name or message body.
 */
export function urlHost(raw?: string): string {
  if (!raw) return ''
  try {
    return new URL(raw).host
  } catch {
    return ''
  }
}

export function haystack(sample: Pick<WindowSample, 'app' | 'title' | 'url'>): string {
  return `${sample.app || ''} ${sample.title || ''} ${sample.url || ''}`.toLowerCase()
}

export interface CategoryResolution {
  category: string
  projectId?: string
  /** Set when the winning rule also pinned a productivity value. */
  productivity?: Productivity
  /** Which layer decided — surfaced in the UI so corrections are explainable. */
  source: 'app-rule' | 'keyword-rule' | 'project' | 'default'
}

export function resolveCategory(
  sample: Pick<WindowSample, 'app' | 'title' | 'url'>,
  rules: CategoryRule[],
  projects: Project[]
): CategoryResolution {
  const appKey = (sample.app || '').toLowerCase()
  const hay = haystack(sample)

  for (const rule of rules) {
    if (rule.kind !== 'app') continue
    if (appKey && rule.match === appKey) {
      return { category: rule.category, productivity: rule.productivity, source: 'app-rule' }
    }
  }

  for (const rule of rules) {
    if (rule.kind !== 'keyword') continue
    if (rule.match && hay.includes(rule.match)) {
      return { category: rule.category, productivity: rule.productivity, source: 'keyword-rule' }
    }
  }

  for (const project of projects) {
    if (project.archived) continue
    for (const kw of project.keywords || []) {
      if (kw && hay.includes(kw.toLowerCase())) {
        return { category: project.name, projectId: project.id, source: 'project' }
      }
    }
  }

  return { category: UNCATEGORIZED, source: 'default' }
}

/**
 * Built-in heuristics used only when no user rule or project claimed the
 * activity. Intentionally short and generic — the review panel is how a user
 * teaches OpenTime about their own tools, not a giant shipped keyword table.
 */
const DISTRACTING_RE =
  /netflix|twitch|hulu|disney\+|primevideo|prime video|reddit|9gag|tiktok|steam|epicgames|epic games|roblox|solitaire/i
const PRODUCTIVE_RE =
  /visual studio code|vscode|code\.exe|intellij|pycharm|webstorm|goland|rider|jetbrains|sublime|neovim|vim|emacs|xcode|terminal|powershell|cmd\.exe|windows terminal|iterm|warp|figma|sketch|notion|obsidian|linear|jira|confluence|docs\.google|sheets\.google|slides\.google|photoshop|illustrator|premiere|blender|excel|word|powerpoint|github\.com|gitlab\.com/i

export function classifyProductivity(
  sample: Pick<WindowSample, 'app' | 'title' | 'url'>,
  resolution: CategoryResolution
): Productivity {
  if (resolution.productivity) return resolution.productivity

  const hay = haystack(sample)
  if (DISTRACTING_RE.test(hay)) return 'distracting'
  // Anything the user explicitly mapped to a project or category is, by
  // definition, work they chose to name — treat it as productive.
  if (resolution.category !== UNCATEGORIZED) return 'productive'
  if (PRODUCTIVE_RE.test(hay)) return 'productive'
  return 'neutral'
}

export function isIgnored(app: string, ignoredApps: string[]): boolean {
  const key = (app || '').toLowerCase()
  if (!key) return false
  return ignoredApps.some((a) => a.toLowerCase() === key)
}

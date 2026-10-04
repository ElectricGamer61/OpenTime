/**
 * Categorisation and productivity classification.
 *
 * The question this answers is "which project was I working on?", and the app
 * is a poor guide to that: the same browser holds a chat about one project and
 * a video about nothing. So every signal is weighed, not just the app, and the
 * most specific one wins:
 *
 *   100  a "Matching text" rule the user taught
 *    90  the window names the project ("OpenTime", "open-time", "BBD Opentime")
 *    80  a "Whole app" rule the user taught
 *    72  one of the project's keywords, in the title or the address
 *  60-78 words the project learned from blocks the user filed under it
 *    55  one of the project's keywords, only in the app's name
 *     -  nothing: Uncategorized (the session builder may then keep a window
 *        with nothing to go on with the work around it; see sessions.ts)
 *
 * Nothing here guesses beyond the words on screen. Every match can be said
 * back to the user in a sentence ("the title mentions OpenTime"), which is the
 * whole point of `evidence`.
 *
 * Pure and dependency-free; `tests/categorize.test.ts` pins it.
 */

import type { CategoryRule, MatchSource, Productivity, Project, WindowSample } from './types'

export const UNCATEGORIZED = 'Uncategorized'

/**
 * Apps whose address we read. Reading one turns the browser's accessibility
 * tree on, which has a real (small) cost, so it is browsers only.
 */
export const BROWSER_RE = /\b(chrome|chromium|edge|msedge|firefox|brave|arc|opera|vivaldi|safari|zen)\b/i

/**
 * Reduce a URL to its host (+ port), without "www.". Drops the path, query and
 * fragment so OpenTime can never store a session token, document name or
 * message body.
 */
export function urlHost(raw?: string): string {
  if (!raw) return ''
  try {
    return new URL(raw).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * What a browser's address bar says, reduced to what matching may use.
 *
 * Chrome and Edge show "github.com/acme/repo" with no scheme; while someone is
 * typing, the bar holds their search instead. Anything that does not read as
 * an address (spaces, no dot, a browser page like chrome://newtab) is
 * rejected rather than guessed at. The query and fragment never survive: they
 * are where tokens and search terms live.
 */
export function readAddress(raw?: string): { host: string; address: string } | null {
  const value = (raw || '').trim()
  if (!value || /\s/.test(value)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const hostname = url.hostname
  if (!hostname.includes('.') && hostname !== 'localhost') return null
  const host = url.host.toLowerCase().replace(/^www\./, '')
  const path = decodeSafe(url.pathname).toLowerCase().replace(/\/+$/, '')
  return { host, address: `${host}${path}` }
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Tidy a keyword as typed: "https://www.YouTube.com/?feature=x" becomes
 * "youtube.com", "github.com/Acme/Repo/" becomes "github.com/acme/repo", and a
 * word is just lower-cased. Returns '' for input that names nothing.
 */
export function normalizeKeyword(raw: string): string {
  let value = String(raw ?? '').trim().toLowerCase()
  if (!value) return ''
  if (!/\s/.test(value) && /[.:/]/.test(value)) {
    value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    value = value.replace(/[?#].*$/, '')
    value = value.replace(/^www\./, '')
    value = value.replace(/\/+$/, '')
  }
  return value.replace(/\s+/g, ' ')
}

/** The fields matching reads. `address` is live-only; stored sessions have just `url`. */
export type MatchInput = Pick<WindowSample, 'app' | 'title' | 'url' | 'address'>

export interface CategoryResolution {
  category: string
  projectId?: string
  /** Set when the winning rule or project pins how the time counts. */
  productivity?: Productivity
  /** Which signal decided, so a correction is explainable. */
  source: MatchSource
  /** What matched, in the words the UI shows: a keyword, a site, learned words. */
  evidence?: string[]
}

/**
 * Projects shipped as starters. Their names are ordinary words ("Writing",
 * "Breaks", "Research"), so a title merely containing one is no evidence of
 * anything; they match by keyword only. A project someone creates is named
 * after the thing itself, which is exactly what a title mentions.
 */
const STARTER_PROJECT_IDS = new Set([
  'p_deep_work',
  'p_design',
  'p_writing',
  'p_communication',
  'p_meetings',
  'p_research',
  'p_breaks',
])

const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A keyword that names a site or a path on one, rather than a word. */
const isWebTerm = (term: string) => /[.:/]/.test(term) && !/\s/.test(term)

/** Whole-word, case-insensitive containment. */
function hasWord(text: string, word: string): boolean {
  if (!word || !text) return false
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(word)}($|[^\\p{L}\\p{N}])`, 'iu').test(text)
}

/**
 * Split a window title into the parts browsers and apps join with " - ",
 * " | " or " · ": "lofi beats - YouTube - Google Chrome".
 */
function titleSegments(title: string): string[] {
  return title
    .split(/\s[-–—|·•]\s/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Whether a browser title says it is on a site, for when the browser hides the
 * address. The site's name must be a whole segment of the title: "lofi beats -
 * YouTube" is on YouTube; "Making my first YouTube video - Claude" is a chat
 * that mentions it, and "Channel content - YouTube Studio" is somewhere else.
 */
export function titleNamesSite(title: string, site: string): boolean {
  const name = site.replace(/^www\./, '').split(/[.:/]/)[0]
  if (name.length < 4) return false
  return titleSegments(title || '').includes(name)
}

/**
 * The title without the part that only names the app: "tracker.ts - opentime
 * - Visual Studio Code" is about "tracker.ts - opentime". Otherwise every
 * VS Code window would match a keyword "code", and every Resolve window the
 * word "resolve".
 */
export function pageTitle(input: Pick<WindowSample, 'app' | 'title'>): string {
  const app = (input.app || '').trim().toLowerCase()
  const title = input.title || ''
  if (!app) return title
  const parts = title.split(/\s[-–—|·•]\s/)
  const kept = parts.filter((part) => part.trim().toLowerCase() !== app)
  return kept.length ? kept.join(' - ') : ''
}

/**
 * Where a keyword was found, or null. A site keyword ("youtube.com",
 * "github.com/acme") is looked for in the address, then the host, then as a
 * site segment of a browser title; a word keyword in the title and address
 * first, then the app's name.
 */
function findTerm(term: string, input: MatchInput): 'page' | 'app' | null {
  const t = term.trim().toLowerCase()
  if (!t) return null
  const host = (input.url || '').toLowerCase()
  const address = (input.address || host).toLowerCase()
  const title = pageTitle(input)
  if (isWebTerm(t)) {
    if (hasWord(address, t) || hasWord(host, t)) return 'page'
    if (!host && BROWSER_RE.test(input.app || '') && titleNamesSite(input.title || '', t)) return 'page'
    return null
  }
  if (hasWord(title, t) || hasWord(address, t)) return 'page'
  if (hasWord(input.app || '', t)) return 'app'
  return null
}

/**
 * A pattern for a project's name that tolerates how people and tools spell
 * it: "OpenTime" also finds "Opentime", "open time", "open-time" and
 * "ElectricGamer61/OpenTime". Null for names too short or too plain to be
 * evidence on their own.
 */
function namePattern(name: string): RegExp | null {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  if (!words.length || words.join('').length < 4) return null
  if (words.length === 1 && STOP_WORDS.has(words[0])) return null
  const body = words.map(escapeRe).join('[\\s\\-_.]*')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${body}($|[^\\p{L}\\p{N}])`, 'iu')
}

// ── Learned words ───────────────────────────────────────────────────────────

/**
 * Words too common to say anything about a project: English glue, and the
 * names browsers, editors and sites put in every title.
 */
const STOP_WORDS = new Set(
  `a an and are as at be but by can do for from get had has have how i if in into is it its
  me my new no not of on or our out so than that the their them then there these they this
  to up us was we what when where which who why will with you your
  google chrome microsoft edge mozilla firefox brave opera vivaldi safari browser
  visual studio code window windows file files folder edit view untitled document documents
  tab tabs page pages home inbox draft search results www com org net http https html index
  app apps new private incognito profile loading welcome start settings preview
  tsx jsx mjs cjs json css scss txt pdf doc docx xls xlsx ppt pptx csv png jpg jpeg gif svg
  webp mp3 mp4 mov wav mkv exe yml yaml log`
    .split(/\s+/)
    .filter(Boolean)
)

/** The most words one project keeps; the least-seen are dropped past it. */
export const MAX_LEARNED_WORDS = 300

/**
 * The words in a window that could identify a project: from the title and the
 * address path, minus stop words, numbers, and the app's own name (a Chrome
 * title always ends in "Google Chrome", which says nothing about the work).
 */
export function wordsOf(input: MatchInput): string[] {
  const appWords = new Set((input.app || '').toLowerCase().split(/[^\p{L}\p{N}]+/u))
  const path = (input.address || '').split('/').slice(1).join(' ')
  const out = new Set<string>()
  for (const raw of `${input.title || ''} ${path}`.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || raw.length > 32) continue
    if (/^\d+$/.test(raw)) continue
    if (STOP_WORDS.has(raw) || appWords.has(raw)) continue
    out.add(raw)
  }
  return [...out]
}

/**
 * Add a window's words to what a project has learned. Called when the user
 * files a block under the project, so the next window like it lands there on
 * its own.
 */
export function learnWords(
  learned: Record<string, number> | undefined,
  input: MatchInput
): Record<string, number> {
  const next = { ...(learned || {}) }
  for (const word of wordsOf(input)) next[word] = (next[word] || 0) + 1
  const entries = Object.entries(next)
  if (entries.length <= MAX_LEARNED_WORDS) return next
  entries.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(entries.slice(0, MAX_LEARNED_WORDS))
}

/** Take a window's words back off a project, when a block is moved out of it. */
export function unlearnWords(
  learned: Record<string, number> | undefined,
  input: MatchInput
): Record<string, number> | undefined {
  if (!learned) return learned
  const next = { ...learned }
  for (const word of wordsOf(input)) {
    if (!next[word]) continue
    if (next[word] <= 1) delete next[word]
    else next[word] -= 1
  }
  return next
}

/**
 * The projects after the user moves a block from one project to another: the
 * block's words are learned by the project it went to and taken back off the
 * one it left. Null when nothing changes (the block stayed where it was, or
 * neither side is a project).
 */
export function learnFromRefile(
  projects: Project[],
  block: MatchInput & { projectId?: string },
  toProjectId: string | undefined
): Project[] | null {
  if (block.projectId === toProjectId) return null
  let changed = false
  const next = projects.map((project) => {
    if (project.id === toProjectId) {
      changed = true
      return { ...project, learned: learnWords(project.learned, block) }
    }
    if (project.id === block.projectId && project.learned) {
      changed = true
      return { ...project, learned: unlearnWords(project.learned, block) }
    }
    return project
  })
  return changed ? next : null
}

/**
 * How strongly a window's words point at each project.
 *
 * A word only counts for the project that has seen it most, so a word two
 * projects share decides nothing. One word is not enough unless it has been
 * seen at least three times; two different words are. That keeps a single
 * common word ("video") from dragging unrelated windows in.
 */
function learnedScores(words: string[], projects: Project[]): Map<string, { score: number; words: string[] }> {
  const out = new Map<string, { score: number; words: string[] }>()
  if (!words.length) return out
  for (const project of projects) {
    const learned = project.learned
    if (!learned) continue
    const hits: Array<{ word: string; count: number }> = []
    for (const word of words) {
      const count = learned[word] || 0
      if (!count) continue
      const rival = projects.some((other) => other !== project && !other.archived && (other.learned?.[word] || 0) >= count)
      if (!rival) hits.push({ word, count })
    }
    if (!hits.length) continue
    const strength = hits.reduce((sum, h) => sum + Math.min(3, h.count), 0)
    if (hits.length < 2 && strength < 3) continue
    hits.sort((a, b) => b.count - a.count)
    out.set(project.id, {
      score: 60 + Math.min(18, Math.max(0, strength - 2) * 3),
      words: hits.slice(0, 3).map((h) => h.word),
    })
  }
  return out
}

// ── Resolution ──────────────────────────────────────────────────────────────

export function resolveCategory(
  sample: MatchInput,
  rules: CategoryRule[],
  projects: Project[]
): CategoryResolution {
  let best: (CategoryResolution & { score: number }) | null = null
  const offer = (score: number, resolution: CategoryResolution) => {
    if (!best || score > best.score) best = { ...resolution, score }
  }

  const appKey = (sample.app || '').toLowerCase()
  for (const rule of rules) {
    if (rule.kind === 'keyword') {
      if (rule.match && findTerm(rule.match, sample)) {
        offer(100, {
          category: rule.category,
          productivity: rule.productivity,
          source: 'keyword-rule',
          evidence: [rule.match],
        })
      }
    } else if (appKey && rule.match === appKey) {
      offer(80, {
        category: rule.category,
        productivity: rule.productivity,
        source: 'app-rule',
        evidence: [sample.app],
      })
    }
  }

  const live = projects.filter((p) => !p.archived)
  const page = `${pageTitle(sample)} ${sample.address || sample.url || ''}`
  const learned = learnedScores(wordsOf(sample), live)
  for (const project of live) {
    const base = { category: project.name, projectId: project.id, productivity: project.productivity }
    if (!STARTER_PROJECT_IDS.has(project.id)) {
      const pattern = namePattern(project.name)
      if (pattern?.test(page)) offer(90, { ...base, source: 'name', evidence: [project.name] })
    }
    for (const keyword of project.keywords || []) {
      const where = findTerm(keyword, sample)
      if (where) offer(where === 'page' ? 72 : 55, { ...base, source: 'keyword', evidence: [keyword] })
    }
    const words = learned.get(project.id)
    if (words) offer(words.score, { ...base, source: 'learned', evidence: words.words })
  }

  if (!best) return { category: UNCATEGORIZED, source: 'default' }
  const { score: _score, ...resolution } = best as CategoryResolution & { score: number }
  return resolution
}

/**
 * Built-in heuristics used only when no user rule or project claimed the
 * activity. Intentionally short and generic — the review panel is how a user
 * teaches OpenTime about their own tools, not a giant shipped keyword table.
 */
const DISTRACTING_RE =
  /netflix|twitch|hulu|disney\+|primevideo|prime video|reddit|9gag|tiktok|steam|epicgames|epic games|roblox|solitaire/i
const PRODUCTIVE_RE =
  /visual studio code|vscode|code\.exe|intellij|pycharm|webstorm|goland|rider|jetbrains|sublime|neovim|vim|emacs|xcode|terminal|powershell|cmd\.exe|windows terminal|iterm|warp|figma|sketch|notion|obsidian|linear|jira|confluence|docs\.google|sheets\.google|slides\.google|photoshop|illustrator|premiere|davinci resolve|blender|excel|word|powerpoint|github\.com|gitlab\.com/i

function heuristicHaystack(sample: MatchInput): string {
  return `${sample.app || ''} ${sample.title || ''} ${sample.url || ''}`.toLowerCase()
}

export function classifyProductivity(sample: MatchInput, resolution: CategoryResolution): Productivity {
  if (resolution.productivity) return resolution.productivity

  const hay = heuristicHaystack(sample)
  if (DISTRACTING_RE.test(hay)) return 'distracting'
  // Anything filed under a project or category the user named is, unless the
  // project says otherwise, work they chose to name: productive.
  if (resolution.category !== UNCATEGORIZED) return 'productive'
  if (PRODUCTIVE_RE.test(hay)) return 'productive'
  return 'neutral'
}

/** What a heuristic says about a window no project claimed. */
export function looksDistracting(sample: MatchInput): boolean {
  return DISTRACTING_RE.test(heuristicHaystack(sample))
}

/**
 * Why a session is filed where it is, as one sentence for the UI. Null when
 * there is nothing to say (a hand-made row, or one from before 0.4).
 */
export function explainMatch(source: MatchSource | undefined, evidence: string[] = []): string | null {
  const quoted = evidence.map((e) => `“${e}”`)
  const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}` : quoted[0]
  switch (source) {
    case 'keyword-rule':
      return list ? `A rule you made: anything with ${list}.` : 'A rule you made.'
    case 'app-rule':
      return list ? `A rule you made: everything in ${list}.` : 'A rule you made for this app.'
    case 'name':
      return list ? `The window mentions ${list}.` : 'The window mentions this project.'
    case 'keyword':
      return list ? `Matched the keyword ${list}.` : 'Matched one of the project’s keywords.'
    case 'learned':
      return list
        ? `Words OpenTime learned from blocks you filed here: ${list}.`
        : 'Words OpenTime learned from blocks you filed here.'
    case 'context':
      return 'Nothing in this window said what it was, so it stayed with the work around it.'
    case 'default':
      return 'Nothing matched a project. File it under one and OpenTime learns from it.'
    default:
      return null
  }
}

export function isIgnored(app: string, ignoredApps: string[]): boolean {
  const key = (app || '').toLowerCase()
  if (!key) return false
  return ignoredApps.some((a) => a.toLowerCase() === key)
}

/**
 * Whether a sample must never be recorded.
 *
 * Two layers, because "private" means two different things in practice: a whole
 * application you never want logged (a password manager, a therapy journal), and
 * a *subject* you never want logged whatever app it appears in — a client name,
 * a legal matter, a medical portal. The second is matched against the window
 * title and address, which is exactly where those leak.
 */
export function isPrivateSample(
  sample: MatchInput,
  ignoredApps: string[],
  ignoredTitleKeywords: string[] = []
): boolean {
  if (isIgnored(sample.app, ignoredApps)) return true
  if (!ignoredTitleKeywords.length) return false
  const hay = `${sample.title || ''} ${sample.url || ''} ${sample.address || ''}`.toLowerCase()
  return ignoredTitleKeywords.some((kw) => kw && hay.includes(kw.toLowerCase()))
}

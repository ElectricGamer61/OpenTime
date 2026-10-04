import { useEffect, useMemo, useRef, useState } from 'react'

import { summarizeDay, summarizeWeek } from '../../core/aggregate'
import { normalizeKeyword } from '../../core/categorize'
import type { CategoryRule, Productivity, Project } from '../../core/types'
import { Breakdown } from '../components/Charts'
import { Empty } from '../components/Empty'
import { IconClose, IconEmptyRule } from '../components/Icons'
import { duration } from '../lib/format'
import { CATEGORY_PALETTE } from '../lib/palette'
import type { OpenTimeState } from '../state/useOpenTime'

/* The same hues the calendar assigns to unrecognised categories, so a project
   the user creates cannot land on a colour the grid would never draw. */
const PALETTE = [...CATEGORY_PALETTE]

const COUNTS_AS: Array<{ id: Productivity; label: string }> = [
  { id: 'productive', label: 'Productive' },
  { id: 'neutral', label: 'Neutral' },
  { id: 'distracting', label: 'Distracting' },
]

/** Projects, what each one matches, and the rules the user taught. */
export function ProjectsView({ app }: { app: OpenTimeState }) {
  const [draft, setDraft] = useState('')

  const weekTotals = useMemo(
    () => summarizeWeek(app.week.map((d) => summarizeDay(d.dayKey, d.sessions, d.idle, d.events))),
    [app.week]
  )

  const secondsByCategory = useMemo(
    () => new Map(weekTotals.byCategory.map((b) => [b.key, b.seconds])),
    [weekTotals]
  )

  // Every change builds on the last one made here, not on `app.projects`,
  // which only catches up once a save comes back. Built on that, a keyword
  // typed and then a "Counts as" picked straight after (the field's blur
  // saves the keyword) wrote the project back without the keyword.
  const latest = useRef(app.projects)
  useEffect(() => {
    latest.current = app.projects
  }, [app.projects])
  const save = (next: Project[]) => {
    latest.current = next
    void app.saveProjects(next)
  }

  /** A patch, or a function of the project as it stands now (for lists). */
  type Change = Partial<Project> | ((p: Project) => Partial<Project>)
  const update = (id: string, change: Change) =>
    save(
      latest.current.map((p) =>
        p.id === id ? { ...p, ...(typeof change === 'function' ? change(p) : change) } : p
      )
    )

  const remove = (id: string) => save(latest.current.filter((p) => p.id !== id))

  const add = () => {
    const name = draft.trim()
    if (!name) return
    // No keywords to start with: a project is already found by its name.
    const project: Project = {
      id: `p_${Date.now().toString(36)}`,
      name,
      color: PALETTE[latest.current.length % PALETTE.length],
      keywords: [],
    }
    setDraft('')
    save([...latest.current, project])
  }

  const removeRule = (rule: CategoryRule) =>
    void app.saveRules(app.rules.filter((r) => r.id !== rule.id))

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Projects</h1>
          <p className="page-sub">
            Time lands in a project when the window mentions its name, shows one of its words or
            sites, or looks like blocks you moved there before.
          </p>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="grid" style={{ gap: 14, alignContent: 'start' }}>
          <div className="card">
            <h2 className="card-title">
              Your projects
              <span className="hint">Last 7 days</span>
            </h2>
            {app.projects.length === 0 ? (
              <Empty
                title="No projects yet"
                hint="Name one after what you work on, like a client, a course or a video, and your time lands under it."
              />
            ) : null}
            {app.projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                seconds={secondsByCategory.get(p.name) || 0}
                onChange={(patch) => update(p.id, patch)}
                onRemove={() => remove(p.id)}
              />
            ))}

            <div className="row project-add">
              <input
                placeholder="New project, like “OpenTime” or “AP Bio”"
                aria-label="New project name"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') add()
                }}
                style={{ flex: 1 }}
              />
              <button className="btn primary" onClick={add} disabled={!draft.trim()}>
                Add project
              </button>
            </div>
          </div>

          <div className="card">
            <h2 className="card-title">
              Rules you made
              <span className="hint">Checked first</span>
            </h2>
            {app.rules.length === 0 ? (
              <Empty
                glyph={<IconEmptyRule />}
                title="No rules yet"
                hint="Open a block on the calendar, pick a project and choose “Whole app” or “Matching text” to make one."
              />
            ) : (
              app.rules.map((r) => (
                <div className="rule-row" key={r.id}>
                  <div className="bar-name">
                    <span className="pill">{r.kind === 'app' ? 'App' : 'Text'}</span>
                    <span className="mono">{r.match}</span>
                    <span className="rule-arrow">→ {r.category}</span>
                  </div>
                  <button className="btn ghost danger" onClick={() => removeRule(r)}>
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="card" style={{ alignSelf: 'start' }}>
          <h2 className="card-title">
            Time by project
            <span className="hint">Last 7 days</span>
          </h2>
          <Breakdown buckets={weekTotals.byCategory} projects={app.projects} limit={12} />
        </div>
      </div>
    </>
  )
}

/**
 * One project: its name and colour, how its time counts, the words and sites
 * that file time under it, and what it has learned from the user's own moves.
 *
 * The name is edited as a draft and saved on Enter or leaving the field. Saved
 * on every keystroke, a half-typed name was briefly a real project name.
 */
function ProjectCard({
  project,
  seconds,
  onChange,
  onRemove,
}: {
  project: Project
  seconds: number
  onChange(change: Partial<Project> | ((p: Project) => Partial<Project>)): void
  onRemove(): void
}) {
  const [name, setName] = useState(project.name)
  const [keyword, setKeyword] = useState('')
  useEffect(() => setName(project.name), [project.name])

  const commitName = () => {
    const next = name.trim()
    if (next && next !== project.name) onChange({ name: next })
    else setName(project.name)
  }

  const addKeyword = () => {
    const values = keyword
      .split(',')
      .map(normalizeKeyword)
      .filter((v) => v && !project.keywords.includes(v))
    if (values.length) {
      onChange((p) => ({ keywords: [...p.keywords, ...new Set(values.filter((v) => !p.keywords.includes(v)))] }))
    }
    setKeyword('')
  }

  const learned = useMemo(
    () =>
      Object.entries(project.learned || {})
        .sort((a, b) => b[1] - a[1])
        .map(([word]) => word),
    [project.learned]
  )

  return (
    <div className="project-card">
      <div className="project-card-head">
        <input
          type="color"
          aria-label={`${project.name} colour`}
          value={project.color}
          onChange={(e) => onChange({ color: e.target.value })}
        />
        <input
          className="project-name"
          aria-label={`${project.name} name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') setName(project.name)
          }}
        />
        <select
          className="project-counts"
          aria-label={`${project.name} counts as`}
          value={project.productivity || 'productive'}
          onChange={(e) => onChange({ productivity: e.target.value as Productivity })}
        >
          {COUNTS_AS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <span className="pill mono project-time">{duration(seconds)}</span>
        <button
          className="icon-btn danger"
          onClick={onRemove}
          title={`Delete ${project.name}`}
          aria-label={`Delete ${project.name}`}
        >
          <IconClose size={14} />
        </button>
      </div>

      <div className="project-card-body">
        <div className="chip-list project-keywords">
          {project.keywords.map((k) => (
            <span className="chip" key={k}>
              {k}
              <button
                aria-label={`Stop matching ${k}`}
                title={`Stop matching ${k}`}
                onClick={() => onChange((p) => ({ keywords: p.keywords.filter((x) => x !== k) }))}
              >
                <IconClose size={12} />
              </button>
            </span>
          ))}
          <input
            className="chip-input"
            aria-label={`Add a word or site to ${project.name}`}
            placeholder={project.keywords.length ? 'Add…' : 'Add a word or site, like youtube.com'}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onBlur={addKeyword}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                addKeyword()
              }
              if (e.key === 'Backspace' && !keyword && project.keywords.length) {
                onChange((p) => ({ keywords: p.keywords.slice(0, -1) }))
              }
            }}
          />
        </div>

        {learned.length ? (
          <div className="project-learned">
            <span>
              Learned from your blocks: <b>{learned.slice(0, 5).join(', ')}</b>
              {learned.length > 5 ? ` and ${learned.length - 5} more` : ''}
            </span>
            <button
              className="btn ghost small"
              onClick={() => onChange({ learned: {} })}
              title="Forget the words this project learned. Keywords stay."
            >
              Forget
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

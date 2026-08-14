import { useMemo, useState } from 'react'

import { summarizeDay, summarizeWeek } from '../../core/aggregate'
import type { CategoryRule, Project } from '../../core/types'
import { Breakdown } from '../components/Charts'
import { Empty } from '../components/Empty'
import { IconClose, IconEmptyRule } from '../components/Icons'
import { duration } from '../lib/format'
import { CATEGORY_PALETTE } from '../lib/palette'
import type { OpenTimeState } from '../state/useOpenTime'

/* The same hues the calendar assigns to unrecognised categories, so a project
   the user creates cannot land on a colour the grid would never draw. */
const PALETTE = [...CATEGORY_PALETTE]

/** Projects and rules — the categorisation layer, editable without a restart. */
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

  const update = (id: string, patch: Partial<Project>) =>
    void app.saveProjects(app.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)))

  const remove = (id: string) => void app.saveProjects(app.projects.filter((p) => p.id !== id))

  const add = () => {
    const name = draft.trim()
    if (!name) return
    const project: Project = {
      id: `p_${Date.now().toString(36)}`,
      name,
      color: PALETTE[app.projects.length % PALETTE.length],
      keywords: [name.toLowerCase()],
    }
    setDraft('')
    void app.saveProjects([...app.projects, project])
  }

  const removeRule = (rule: CategoryRule) =>
    void app.saveRules(app.rules.filter((r) => r.id !== rule.id))

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Projects &amp; rules</h1>
          <p className="page-sub">
            Keywords are matched against the app name, window title and site host. First match wins.
          </p>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="grid" style={{ gap: 14, alignContent: 'start' }}>
          <div className="card">
            <h2 className="card-title">
              Projects
              <span className="hint">Last 7 days</span>
            </h2>
            {app.projects.length === 0 ? (
              <Empty
                title="No projects yet"
                hint="A project groups activity by keyword, so your time lands under a name you chose rather than an app name."
              />
            ) : null}
            {app.projects.map((p) => (
              <div className="project-row" key={p.id}>
                <input
                  type="color"
                  aria-label={`${p.name} colour`}
                  value={p.color}
                  onChange={(e) => update(p.id, { color: e.target.value })}
                  style={{ padding: 0, width: 22, height: 22, border: 'none', background: 'none' }}
                />
                <input
                  aria-label={`${p.name} name`}
                  value={p.name}
                  onChange={(e) => update(p.id, { name: e.target.value })}
                />
                <input
                  aria-label={`${p.name} keywords`}
                  value={p.keywords.join(', ')}
                  placeholder="keywords, comma separated"
                  onChange={(e) =>
                    update(p.id, {
                      keywords: e.target.value
                        .split(',')
                        .map((k) => k.trim().toLowerCase())
                        .filter(Boolean),
                    })
                  }
                />
                <div className="row" style={{ gap: 6 }}>
                  <span className="pill mono">{duration(secondsByCategory.get(p.name) || 0)}</span>
                  <button
                    className="icon-btn danger"
                    onClick={() => remove(p.id)}
                    title={`Delete ${p.name}`}
                    aria-label={`Delete ${p.name}`}
                  >
                    <IconClose size={14} />
                  </button>
                </div>
              </div>
            ))}

            <div className="row" style={{ marginTop: 14 }}>
              <input
                placeholder="New project name"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') add()
                }}
                style={{ flex: 1 }}
              />
              <button className="btn primary" onClick={add}>
                Add project
              </button>
            </div>
          </div>

          <div className="card">
            <h2 className="card-title">
              Learned rules
              <span className="hint">Checked before projects</span>
            </h2>
            {app.rules.length === 0 ? (
              <Empty
                glyph={<IconEmptyRule />}
                title="No rules yet"
                hint="Retag a block on the timeline and choose “Whole app” or “Matching text” to teach one."
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
            Time by category
            <span className="hint">Last 7 days</span>
          </h2>
          <Breakdown buckets={weekTotals.byCategory} projects={app.projects} limit={12} />
        </div>
      </div>
    </>
  )
}

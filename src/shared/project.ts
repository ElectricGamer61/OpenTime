/**
 * Where OpenTime lives on GitHub. The one place the repository is named:
 * feedback links, the releases page and the updater's feed all derive from it.
 */

import type { FeedbackKind } from './ipc'

export const REPO_OWNER = 'ElectricGamer61'
export const REPO_NAME = 'OpenTime'
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`
export const RELEASES_URL = `${REPO_URL}/releases/latest`

/** Issue-form templates in `.github/ISSUE_TEMPLATE`, by feedback kind. */
const TEMPLATES: Record<FeedbackKind, string> = {
  bug: 'bug_report.yml',
  idea: 'feature_request.yml',
  question: 'question.yml',
}

/**
 * The new-issue URL for one kind of feedback, with the version and OS filled
 * in. Nothing about the person or their tracked time goes into it, and
 * nothing is sent: it only opens a page they can read before submitting.
 */
export function feedbackUrl(kind: FeedbackKind, info: { version: string; platform: string }): string {
  const params = new URLSearchParams({ template: TEMPLATES[kind] })
  if (kind === 'bug') {
    params.set('version', info.version)
    params.set('os', info.platform)
  }
  return `${REPO_URL}/issues/new?${params.toString()}`
}

import { useMemo, useState } from 'react'

import type { AssistantConnector } from '../../shared/ipc'

/**
 * Settings → Assistant: connecting an AI assistant that speaks MCP (Rookbot,
 * Claude Desktop, Cursor) to OpenTime's read-only server.
 *
 * OpenTime itself has no AI in it and this changes nothing about that: the
 * server only answers questions from the files already on this computer, and
 * only when an assistant the user set up asks. The block is the whole setup,
 * so it is shown ready to paste with a copy button rather than described.
 */
export function AssistantSettings({ connector }: { connector: AssistantConnector | null }) {
  const [copied, setCopied] = useState(false)

  const config = useMemo(
    () =>
      connector
        ? JSON.stringify(
            {
              mcpServers: {
                opentime: { command: connector.command, args: connector.args, env: connector.env },
              },
            },
            null,
            2
          )
        : '',
    [connector]
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(config)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="card">
      <h2 className="card-title">Ask an assistant about your time</h2>
      <p className="card-lede">
        OpenTime has no AI in it. If you use an assistant that supports MCP, like Rookbot, Claude
        Desktop or Cursor, it can answer questions such as “how long did I spend on OpenTime this
        week?” from your time here. It can only read, never change anything, and nothing goes online.
      </p>

      <ol className="assistant-steps">
        <li>Copy the setup below.</li>
        <li>
          Paste it into your assistant’s MCP settings. For Rookbot that is{' '}
          <code>connectors.json</code>.
        </li>
        <li>Restart the assistant and ask it about your time.</li>
      </ol>

      <div className="assistant-config">
        <pre aria-label="Assistant setup">{config}</pre>
        <button className="btn small" onClick={() => void copy()} disabled={!config}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="assistant-foot">
        The time in progress is added when it ends, so the last few minutes may be missing from an
        answer.
      </p>
    </div>
  )
}

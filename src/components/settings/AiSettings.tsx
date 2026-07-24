import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader2, Check, AlertCircle, Cpu, Trash2 } from 'lucide-react'

import {
  getAiConfig, saveAiConfig, deleteAiTaskConfig, testAiTaskConnection,
  describeBackendError, type AiConfig, type AiTaskInput,
} from '@engine/backend'

interface AiSettingsProps {
  onClose: () => void
}

const PROVIDER_LABEL: Record<string, string> = {
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  custom: 'Custom (OpenAI-compatible)',
}

// Providers whose endpoint URL the user sets themselves.
const SHOWS_BASE_URL = new Set(['openrouter', 'custom'])

const SOURCE_LABEL: Record<string, string> = {
  config: 'custom settings',
  env: 'environment variables (.env)',
  none: 'not configured',
}

const TASK_INFO: Record<string, { label: string; hint: string }> = {
  translate: { label: 'Caption translation (Cut)', hint: 'Translate captions in the editor' },
}

const inputCls =
  'w-full rounded-md bg-bg-2 px-2.5 py-1.5 text-xs text-text-1 outline-none ring-1 ring-border focus:ring-accent disabled:opacity-50'

interface TaskDraft {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
}

const EMPTY_DRAFT: TaskDraft = { provider: '', baseUrl: '', apiKey: '', model: '' }

/**
 * Configure the editor AI connection. Keys are stored server-side (never
 * returned to the UI); leaving a key field blank keeps the saved key.
 */
export function AiSettings({ onClose }: AiSettingsProps) {
  const [cfg, setCfg] = useState<AiConfig | null>(null)
  const [drafts, setDrafts] = useState<Record<string, TaskDraft>>({})
  const [busyTask, setBusyTask] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function refresh() {
    try {
      const c = await getAiConfig()
      setCfg(c)
      setDrafts((prev) => {
        const next = { ...prev }
        for (const task of c.tasks) {
          const status = c.taskConfigs[task]
          // Don't clobber a field the user is actively editing with the same
          // provider — only reset apiKey (never echoed back) + reseed on first load.
          const existing = next[task]
          next[task] = {
            provider: status?.provider ?? '',
            baseUrl: status?.baseUrl ?? '',
            model: status?.model ?? '',
            apiKey: existing && existing.provider === (status?.provider ?? '') ? existing.apiKey : '',
          }
        }
        return next
      })
    } catch (e) {
      setError(describeBackendError(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  function draftFor(task: string): TaskDraft {
    return drafts[task] ?? EMPTY_DRAFT
  }

  function setDraft(task: string, patch: Partial<TaskDraft>) {
    setDrafts((d) => ({ ...d, [task]: { ...draftFor(task), ...patch } }))
  }

  function onProvider(task: string, provider: string) {
    const patch: Partial<TaskDraft> = { provider }
    if (provider && !draftFor(task).baseUrl) patch.baseUrl = cfg?.defaultBase[provider] ?? ''
    if (provider && !draftFor(task).model) patch.model = cfg?.defaultModels[provider] ?? ''
    setDraft(task, patch)
  }

  async function saveTask(task: string, opts: { quiet?: boolean } = {}) {
    setError(null); setNote(null); setBusyTask(task)
    try {
      const d = draftFor(task)
      const input: AiTaskInput = { provider: d.provider, baseUrl: d.baseUrl, apiKey: d.apiKey, model: d.model }
      const c = await saveAiConfig({ [task]: input })
      setCfg(c)
      setDraft(task, { apiKey: '' }) // never keep the secret in the field
      if (!opts.quiet) setNote(`Saved ${TASK_INFO[task]?.label ?? task}`)
      return c
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
      return null
    } finally {
      setBusyTask(null)
    }
  }

  async function clearTask(task: string) {
    setError(null); setNote(null); setBusyTask(task)
    try {
      const c = await deleteAiTaskConfig(task)
      setCfg(c)
      setDraft(task, { ...EMPTY_DRAFT })
      setNote(`Cleared ${TASK_INFO[task]?.label ?? task} settings (falling back to environment variables when available)`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusyTask(null)
    }
  }

  async function testTask(task: string) {
    setError(null); setNote(null); setBusyTask(task)
    try {
      const r = await testAiTaskConnection(task)
      const label = TASK_INFO[task]?.label ?? task
      if (r.ok) setNote(`${label}: OK · ${r.provider} · ${r.model}${r.sample ? ` → “${r.sample}”` : ''}`)
      else setError(r.error ?? 'Connection failed')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection test failed')
    } finally {
      setBusyTask(null)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[92] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-[560px] flex-col overflow-hidden rounded-xl bg-bg-1 shadow-e3 ring-1 ring-border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-text-1">
              <Cpu size={15} className="text-accent" /> AI Settings
            </h2>
            <p className="text-2xs text-text-3">
              Each task has its own provider, URL, key, and model. Tasks do not need to share one provider.
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-text-2 hover:bg-bg-3 hover:text-text-1">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-auto p-5">
          {(cfg?.tasks ?? Object.keys(TASK_INFO)).map((task) => (
            <TaskConnectionCard
              key={task}
              task={task}
              draft={draftFor(task)}
              status={cfg?.taskConfigs[task]}
              providers={cfg?.providers ?? ['openrouter']}
              defaultBase={cfg?.defaultBase ?? {}}
              defaultModels={cfg?.defaultModels ?? {}}
              busy={busyTask === task}
              onProvider={(p) => onProvider(task, p)}
              onChange={(patch) => setDraft(task, patch)}
              onSave={() => void saveTask(task)}
              onClear={() => void clearTask(task)}
              onTest={() => void testTask(task)}
            />
          ))}

          {error && (
            <p className="flex items-start gap-1.5 text-2xs text-danger">
              <AlertCircle size={13} className="mt-0.5 shrink-0" /> {error}
            </p>
          )}
          {note && !error && (
            <p className="flex items-start gap-1.5 text-2xs text-success">
              <Check size={13} className="mt-0.5 shrink-0" /> {note}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function TaskConnectionCard({
  task, draft, status, providers, defaultBase, defaultModels, busy,
  onProvider, onChange, onSave, onClear, onTest,
}: {
  task: string
  draft: TaskDraft
  status?: { provider: string; baseUrl: string; model: string; hasKey: boolean; source: string }
  providers: string[]
  defaultBase: Record<string, string>
  defaultModels: Record<string, string>
  busy: boolean
  onProvider: (provider: string) => void
  onChange: (patch: Partial<TaskDraft>) => void
  onSave: () => void
  onClear: () => void
  onTest?: () => void
}) {
  const info = TASK_INFO[task]
  const keyPlaceholder = status?.hasKey
    ? '•••••••• saved — leave blank to keep it'
    : draft.provider === 'custom' ? 'API key (optional for internal endpoints)'
    : 'Paste API key'

  return (
    <div className="rounded-lg bg-bg-2/40 p-3 ring-1 ring-border">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-text-1">{info?.label ?? task}</p>
          {info?.hint && <p className="text-2xs text-text-3">{info.hint}</p>}
        </div>
        <span className="flex items-center gap-1.5 text-2xs text-text-3">
          {SOURCE_LABEL[status?.source ?? 'none']}
          {status?.hasKey && <span className="text-success">· key saved</span>}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <Field label="Provider">
          <select
            value={draft.provider}
            onChange={(e) => onProvider(e.target.value)}
            disabled={busy}
            className={inputCls}
          >
            <option value="">— use environment variables (.env) —</option>
            {providers.map((p) => <option key={p} value={p}>{PROVIDER_LABEL[p] ?? p}</option>)}
          </select>
        </Field>

        {draft.provider && SHOWS_BASE_URL.has(draft.provider) && (
          <Field label="Base URL">
            <input
              value={draft.baseUrl}
              onChange={(e) => onChange({ baseUrl: e.target.value })}
              disabled={busy}
              placeholder={defaultBase[draft.provider] || 'http://localhost:1234/v1'}
              className={inputCls}
            />
          </Field>
        )}

        {draft.provider && (
          <>
            <Field label="API key">
              <input
                type="password"
                value={draft.apiKey}
                onChange={(e) => onChange({ apiKey: e.target.value })}
                disabled={busy}
                placeholder={keyPlaceholder}
                className={inputCls}
              />
            </Field>
            <Field label="Model">
              <input
                value={draft.model}
                onChange={(e) => onChange({ model: e.target.value })}
                disabled={busy}
                placeholder={defaultModels[draft.provider] || 'default model'}
                className={inputCls}
              />
            </Field>
          </>
        )}
      </div>

      <div className="mt-2.5 flex items-center justify-between">
        <button
          onClick={onClear}
          disabled={busy || status?.source !== 'config'}
          className="flex items-center gap-1 text-2xs text-text-3 hover:text-danger disabled:opacity-40"
        >
          <Trash2 size={12} /> Delete
        </button>
        <div className="flex gap-2">
          {onTest && (
            <button
              onClick={onTest}
              disabled={busy || !draft.provider}
              className="flex items-center gap-1.5 rounded-md bg-bg-3 px-3 py-1.5 text-2xs text-text-1 hover:bg-bg-4 disabled:opacity-40"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : null} Test
            </button>
          )}
          <button
            onClick={onSave}
            disabled={busy || !draft.provider}
            className="rounded-md bg-accent px-3.5 py-1.5 text-2xs font-medium text-white hover:bg-accent-hover disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs font-medium text-text-2">{label}</span>
      {children}
    </label>
  )
}

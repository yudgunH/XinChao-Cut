import { AlertTriangle, Check, Download, Gauge, Play, RefreshCw, Timer, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type {
  ExportBenchProgress,
  ExportBenchReport,
} from '@engine/export/bench/export-bench'
import {
  loadValidatedZeroCopyReport,
  runZeroCopyMatrix,
  type ZeroCopyMatrixCase,
  type ZeroCopyMatrixReport,
} from '@engine/export/zero-copy-self-test'

interface ZeroCopyDiagnosticsProps {
  gpuDriver?: string | null
  backendGpu?: string | null
  onClose(): void
}

function fmt(value: number | null | undefined): string {
  return value == null ? '—' : value.toFixed(1)
}

function statusClass(status: string): string {
  if (status === 'active') return 'text-success'
  if (status === 'fallback' || status === 'unsupported') return 'text-warning'
  return 'text-danger'
}

export function ZeroCopyDiagnostics({ gpuDriver, backendGpu, onClose }: ZeroCopyDiagnosticsProps) {
  const [report, setReport] = useState<ZeroCopyMatrixReport | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ completed: number; total: number; current: ZeroCopyMatrixCase } | null>(null)
  const [benchReport, setBenchReport] = useState<ExportBenchReport | null>(null)
  const [benchRunning, setBenchRunning] = useState(false)
  const [benchProgress, setBenchProgress] = useState<ExportBenchProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let current = true
    void loadValidatedZeroCopyReport({ gpuDriver, backendGpu }).then((cached) => {
      if (current) setReport(cached)
    })
    return () => {
      current = false
      abortRef.current?.abort()
    }
  }, [backendGpu, gpuDriver])

  async function run(soakSeconds?: number): Promise<void> {
    if (running || benchRunning) return
    const abort = new AbortController()
    abortRef.current = abort
    setRunning(true)
    setError(null)
    try {
      const next = await runZeroCopyMatrix({
        signal: abort.signal,
        gpuDriver,
        backendGpu,
        soakSeconds,
        onProgress: (completed, total, current) => setProgress({ completed, total, current }),
      })
      setReport(next)
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      abortRef.current = null
      setRunning(false)
      setProgress(null)
    }
  }

  async function runExportBench(): Promise<void> {
    if (running || benchRunning) return
    const abort = new AbortController()
    abortRef.current = abort
    setBenchRunning(true)
    setError(null)
    setBenchProgress({
      stage: 'fixture',
      completed: 0,
      total: 1,
      message: 'Preparing export benchmark',
    })
    try {
      const { runExportBenchmark } = await import('@engine/export/bench/export-bench')
      const next = await runExportBenchmark({
        browserZeroCopy: 'auto',
        // Dense timelines contain many adjacent cuts from the same
        // source. Exercise decoder handoff instead of benchmarking one long clip.
        videoSegments: 30,
        signal: abort.signal,
        onProgress: setBenchProgress,
      })
      setBenchReport(next)
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      abortRef.current = null
      setBenchRunning(false)
      setBenchProgress(null)
    }
  }

  function downloadReport(): void {
    if (!report) return
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `xinchao-zero-copy-${report.environment.webViewVersion}-${report.createdAt.replaceAll(':', '-')}.json`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-6">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border-strong bg-bg-1 shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <h2 className="font-medium text-text-1">GPU zero-copy diagnostics</h2>
            <p className="mt-0.5 text-2xs text-text-3">
              Encodes, decodes and compares safe/direct pixels in this packaged WebView.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              abortRef.current?.abort()
              onClose()
            }}
            className="rounded p-1.5 text-text-3 hover:bg-bg-3 hover:text-text-1"
            title={running || benchRunning ? 'Cancel test' : 'Close'}
          >
            <X size={16} />
          </button>
        </div>

        <div className="overflow-auto p-5">
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded bg-bg-2 p-3">
              <div className="text-2xs text-text-3">WebView2</div>
              <div className="mt-1 font-mono text-xs text-text-1">
                {report?.environment.webViewVersion ?? 'not tested'}
              </div>
            </div>
            <div className="rounded bg-bg-2 p-3">
              <div className="text-2xs text-text-3">GPU adapter</div>
              <div className="mt-1 truncate font-mono text-xs text-text-1" title={report?.environment.adapter?.description}>
                {report
                  ? (report.environment.adapter?.description ||
                    report.environment.adapter?.device ||
                    'identity hidden')
                  : 'not tested'}
              </div>
            </div>
            <div className="rounded bg-bg-2 p-3">
              <div className="text-2xs text-text-3">Verdict</div>
              <div className={`mt-1 font-mono text-xs ${report?.verdict === 'verified' ? 'text-success' : report ? 'text-warning' : 'text-text-1'}`}>
                {report?.verdict ?? 'not tested'}
              </div>
            </div>
          </div>

          {running && progress && (
            <div className="mb-4 rounded border border-accent/30 bg-accent/10 p-3">
              <div className="flex items-center justify-between text-xs text-accent">
                <span className="flex items-center gap-2"><RefreshCw size={13} className="animate-spin" /> {progress.current.id}</span>
                <span>{progress.completed}/{progress.total}</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded bg-bg-3">
                <div className="h-full bg-accent" style={{ width: `${progress.total ? progress.completed / progress.total * 100 : 0}%` }} />
              </div>
            </div>
          )}

          {benchRunning && benchProgress && (
            <div className="mb-4 rounded border border-accent/30 bg-accent/10 p-3">
              <div className="flex items-center justify-between text-xs text-accent">
                <span className="flex items-center gap-2">
                  <RefreshCw size={13} className="animate-spin" />
                  {benchProgress.message}
                </span>
                <span>
                  {Math.round(benchProgress.completed)}/{Math.round(benchProgress.total)}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded bg-bg-3">
                <div
                  className="h-full bg-accent"
                  style={{
                    width: `${benchProgress.total ? benchProgress.completed / benchProgress.total * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="mb-4 flex gap-2 rounded border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
              <AlertTriangle size={14} className="shrink-0" /> {error}
            </div>
          )}

          {benchReport && (
            <div
              className={`mb-4 rounded border p-3 ${
                benchReport.pass
                  ? 'border-success/30 bg-success/10'
                  : 'border-danger/40 bg-danger/10'
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className={`text-xs font-medium ${benchReport.pass ? 'text-success' : 'text-danger'}`}>
                    Export benchmark {benchReport.pass ? 'passed' : 'failed'}
                  </div>
                  <div className="mt-1 text-2xs text-text-3">
                    15s runtime MP4 · 1080×1920@30 · 30 jumping same-source cuts · 20 karaoke captions · sine audio
                  </div>
                </div>
                <div className="text-right font-mono text-xs text-text-1">
                  <div>{benchReport.metrics.fps.toFixed(1)} fps</div>
                  <div className="mt-1 text-2xs text-text-3">
                    zero-copy {benchReport.metrics.zeroCopy}
                  </div>
                </div>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-5">
                <div className="rounded bg-bg-2/80 p-2">
                  <div className="text-2xs text-text-3">Decode</div>
                  <div className="mt-1 font-mono text-xs text-text-1">
                    {fmt(benchReport.metrics.decodeMsPerFrame)} ms/f
                  </div>
                </div>
                <div className="rounded bg-bg-2/80 p-2">
                  <div className="text-2xs text-text-3">Draw</div>
                  <div className="mt-1 font-mono text-xs text-text-1">
                    {fmt(benchReport.metrics.drawMsPerFrame)} ms/f
                  </div>
                </div>
                <div className="rounded bg-bg-2/80 p-2">
                  <div className="text-2xs text-text-3">Encode + BP</div>
                  <div className="mt-1 font-mono text-xs text-text-1">
                    {fmt(benchReport.metrics.encodeAndBackpressureMsPerFrame)} ms/f
                  </div>
                </div>
                <div className="rounded bg-bg-2/80 p-2">
                  <div className="text-2xs text-text-3">Golden</div>
                  <div className={`mt-1 font-mono text-xs ${benchReport.golden.pass ? 'text-success' : 'text-danger'}`}>
                    {benchReport.golden.pass ? 'PASS' : 'FAIL'}
                  </div>
                </div>
                <div className="rounded bg-bg-2/80 p-2">
                  <div className="text-2xs text-text-3">Perf budget</div>
                  <div
                    className={`mt-1 font-mono text-xs ${
                      !benchReport.budget.applicable
                        ? 'text-text-3'
                        : benchReport.budget.pass
                          ? 'text-success'
                          : 'text-danger'
                    }`}
                  >
                    {!benchReport.budget.applicable
                      ? 'N/A'
                      : benchReport.budget.pass
                        ? 'PASS'
                        : 'FAIL'}
                  </div>
                </div>
              </div>
              <div className="mt-2 text-2xs text-text-3">
                Budget ≥ {benchReport.budget.minimumFps?.toFixed(1) ?? 'n/a'} fps ·
                seek fallback assets {benchReport.metrics.seekFallbackAssets.count} ·
                peak JS heap {benchReport.metrics.peakJsHeapBytes === null
                  ? 'unavailable'
                  : `${(benchReport.metrics.peakJsHeapBytes / 1024 / 1024).toFixed(0)} MiB`}
              </div>
            </div>
          )}

          {report && (
            <div className="overflow-hidden rounded border border-border">
              <table className="w-full text-left text-xs">
                <thead className="bg-bg-2 text-text-3">
                  <tr>
                    <th className="px-3 py-2 font-medium">Case</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Safe FPS</th>
                    <th className="px-3 py-2 font-medium">Direct FPS</th>
                    <th className="px-3 py-2 font-medium">Max queue</th>
                    <th className="px-3 py-2 font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {report.cases.map((entry) => (
                    <tr key={entry.id} className="border-t border-border text-text-2">
                      <td className="px-3 py-2 font-mono">{entry.id}</td>
                      <td className={`px-3 py-2 font-mono ${statusClass(entry.status)}`}>
                        {entry.status === 'active' && <Check size={11} className="mr-1 inline" />}
                        {entry.status}
                      </td>
                      <td className="px-3 py-2 font-mono">{fmt(entry.safe?.fps)}</td>
                      <td className="px-3 py-2 font-mono">{fmt(entry.direct?.fps)}</td>
                      <td className="px-3 py-2 font-mono">{Math.max(entry.safe?.maxQueue ?? 0, entry.direct?.maxQueue ?? 0)}</td>
                      <td className="max-w-60 truncate px-3 py-2 text-text-3" title={entry.reason}>{entry.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-3 text-2xs leading-relaxed text-text-3">
            “active” verifies decoded pixels, concurrent encoder sessions and throughput on this GPU + driver + WebView + codec profile.
            “fallback” is safe but stays on the Canvas2D path. WebCodecs does not expose a definitive
            hardware-encoder flag, so this report proves stability/throughput, not the physical NVENC engine.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          {report && (
            <button type="button" onClick={downloadReport} disabled={running || benchRunning} className="flex items-center gap-1.5 rounded border border-border-strong bg-bg-2 px-3 py-1.5 text-xs text-text-2 hover:bg-bg-3 disabled:opacity-50">
              <Download size={13} /> JSON
            </button>
          )}
          {report && (
            <button
              type="button"
              onClick={() => void run(15)}
              disabled={running || benchRunning}
              className="flex items-center gap-1.5 rounded border border-border-strong bg-bg-2 px-3 py-1.5 text-xs text-text-2 hover:bg-bg-3 disabled:opacity-50"
              title="Run each case for at least 15 seconds to expose long-run driver or device loss"
            >
              <Gauge size={13} /> 15s soak
            </button>
          )}
          <button
            type="button"
            onClick={() => benchRunning ? abortRef.current?.abort() : void runExportBench()}
            disabled={running}
            className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs disabled:opacity-50 ${
              benchRunning
                ? 'border-danger/30 bg-danger/15 text-danger'
                : 'border-border-strong bg-bg-2 text-text-2 hover:bg-bg-3'
            }`}
          >
            {benchRunning
              ? <><X size={13} /> Cancel benchmark</>
              : <><Timer size={13} /> Run export benchmark</>}
          </button>
          <button
            type="button"
            onClick={() => running ? abortRef.current?.abort() : void run()}
            disabled={benchRunning}
            className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs ${running ? 'bg-danger/15 text-danger' : 'bg-accent text-white hover:bg-accent/90'}`}
          >
            {running ? <><X size={13} /> Cancel</> : <><Play size={13} /> {report ? 'Run again' : 'Run matrix'}</>}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

import { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react'
import {
  X,
  Download,
  Pause,
  Play,
  AlertTriangle,
  HardDrive,
  WifiOff,
  CircleAlert,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Check,
  Share2,
} from 'lucide-react'
import { ItemSelect } from './AstraLibraryKit/components/item_select'
import { Button } from './AstraLibraryKit/components/button'
import { SelectField } from './AstraLibraryKit/components/select_field'
import { InputField } from './AstraLibraryKit/components/input_field'
import { Checkbox } from './AstraLibraryKit/components/checkbox'
import { cn } from './AstraLibraryKit/components/utils'

export type Resolution = '720p' | '1080p' | '4K'

export interface ExportItem {
  id: string
  title: string
  updated: string
  spec: string
  resolution: Resolution
  duration: string
  durationSeconds: number
  fileSizeMB: number
  sourceAvailable: boolean
  thumb: string
}

export interface AccountState {
  planTier: 'free' | 'pro'
  exportMinutesUsed: number
  exportMinutesLimit: number
}

export type NetworkStatus = 'online' | 'offline' | 'unstable'

export interface ExportEnv {
  freeDiskMB: number
  networkStatus: NetworkStatus
  forceEncodingError: boolean
}

interface ExportModalProps {
  isOpen: boolean
  onClose: () => void
  items: ExportItem[]
  account: AccountState
  env: ExportEnv
  existingFiles: Set<string>
  onExportComplete?: (totalDurationSeconds: number, totalSizeMB: number) => void
}

type Phase =
  | 'idle'
  | 'confirming'
  | 'queued'
  | 'exporting'
  | 'paused'
  | 'success'
  | 'partial'
  | 'failure'

type ErrorKind = 'disk-full' | 'encoding' | 'network'

interface ItemResult {
  itemId: string
  status: 'success' | 'failed'
  reason?: string
}

const VIDEO_SIZE_TO_RESOLUTION: Record<string, Resolution> = {
  '3840x2160': '4K',
  '1920x1080': '1080p',
  '1280x720': '720p',
}

const RESOLUTION_RANK: Record<Resolution, number> = {
  '720p': 1,
  '1080p': 2,
  '4K': 3,
}

const SIZE_PER_MINUTE_MB: Record<Resolution, number> = {
  '720p': 40,
  '1080p': 80,
  '4K': 200,
}

const ANIMATION_MS = 200

const INITIAL_FILE_NAME = 'cs-outdoors-v01'
const INITIAL_EXPORT_TYPE = 'public'
const INITIAL_FILE_TYPE = 'view'
const INITIAL_VIDEO_SIZE = 'never'

const SHARE_LINK_BASE = 'astra.app/share/'

const PROGRESS_DURATION_MS = 5000
const QUEUE_WAIT_MS = 1500
const STATUS_CYCLE_MS = 2500
const STATUS_MESSAGES = [
  'Reticulating splines...',
  'Compressing pixels...',
  'Polishing frames...',
  'Encoding audio...',
  'Wrangling bits...',
  'Finalizing magic...',
]

type Blocker = 'no-items' | 'no-filename' | 'source-missing' | 'plan-limit'
type Warning = 'mixed-resolution' | 'filename-collision'

interface Validation {
  blockers: Blocker[]
  warnings: Warning[]
  canExport: boolean
  needsConfirm: boolean
  fullFilename: string
  selectedItems: ExportItem[]
  totalDurationSeconds: number
  totalSizeMB: number
  outputResolution: Resolution
  upscaledItems: ExportItem[]
  uniqueResolutions: Resolution[]
  planMinutesRemaining: number
}

function validateExport(args: {
  items: ExportItem[]
  selected: Set<string>
  fileName: string
  fileType: string
  videoSize: string
  account: AccountState
  existingFiles: Set<string>
}): Validation {
  const { items, selected, fileName, fileType, videoSize, account, existingFiles } = args
  const selectedItems = items.filter((i) => selected.has(i.id))
  const outputResolution = VIDEO_SIZE_TO_RESOLUTION[videoSize] ?? '1080p'
  const totalDurationSeconds = selectedItems.reduce((sum, i) => sum + i.durationSeconds, 0)
  const totalSizeMB = Math.round(
    (totalDurationSeconds / 60) * SIZE_PER_MINUTE_MB[outputResolution],
  )
  const uniqueResolutions = Array.from(new Set(selectedItems.map((i) => i.resolution)))
  const upscaledItems = selectedItems.filter(
    (i) => RESOLUTION_RANK[i.resolution] < RESOLUTION_RANK[outputResolution],
  )
  const fullFilename = `${fileName.trim()}.${fileType}`

  const blockers: Blocker[] = []
  const warnings: Warning[] = []

  if (selectedItems.length === 0) blockers.push('no-items')
  if (fileName.trim().length === 0) blockers.push('no-filename')
  if (selectedItems.some((i) => !i.sourceAvailable)) blockers.push('source-missing')

  const planMinutesRemaining =
    account.planTier === 'pro'
      ? Infinity
      : Math.max(0, account.exportMinutesLimit - account.exportMinutesUsed)
  const wouldExceedPlan =
    account.planTier === 'free' && totalDurationSeconds / 60 > planMinutesRemaining
  if (wouldExceedPlan) blockers.push('plan-limit')

  if (uniqueResolutions.length > 1 || upscaledItems.length > 0) {
    warnings.push('mixed-resolution')
  }
  if (existingFiles.has(fullFilename) && fileName.trim().length > 0) {
    warnings.push('filename-collision')
  }

  return {
    blockers,
    warnings,
    canExport: blockers.length === 0,
    needsConfirm: warnings.length > 0,
    fullFilename,
    selectedItems,
    totalDurationSeconds,
    totalSizeMB,
    outputResolution,
    upscaledItems,
    uniqueResolutions,
    planMinutesRemaining,
  }
}

interface Outcome {
  kind: 'success' | 'failure' | 'partial'
  error?: ErrorKind
  failAtProgress?: number
  itemResults?: ItemResult[]
}

function computeOutcome(args: {
  totalSizeMB: number
  env: ExportEnv
  exportType: string
  selectedItems: ExportItem[]
}): Outcome {
  const { totalSizeMB, env, exportType, selectedItems } = args

  if (totalSizeMB > env.freeDiskMB) {
    return { kind: 'failure', error: 'disk-full', failAtProgress: 70 }
  }

  if (env.networkStatus === 'offline') {
    return { kind: 'failure', error: 'network', failAtProgress: 25 }
  }

  if (env.networkStatus === 'unstable') {
    return { kind: 'failure', error: 'network', failAtProgress: 55 }
  }

  if (env.forceEncodingError) {
    if (exportType === 'separate' && selectedItems.length > 1) {
      const failedItemIds = selectedItems.slice(0, 1).map((i) => i.id)
      return {
        kind: 'partial',
        itemResults: selectedItems.map((i) => ({
          itemId: i.id,
          status: failedItemIds.includes(i.id) ? 'failed' : 'success',
          reason: failedItemIds.includes(i.id) ? 'Encoding error' : undefined,
        })),
      }
    }
    return { kind: 'failure', error: 'encoding', failAtProgress: 45 }
  }

  return { kind: 'success' }
}

function formatMinutes(totalSeconds: number): string {
  const minutes = totalSeconds / 60
  if (minutes < 1) return `${Math.round(totalSeconds)}s`
  return `${minutes % 1 === 0 ? minutes : minutes.toFixed(1)} min`
}

function formatMB(mb: number): string {
  if (mb < 1) return `<1 MB`
  if (mb < 1000) return `${Math.round(mb)} MB`
  return `${(mb / 1000).toFixed(1)} GB`
}

export function ExportModal({
  isOpen,
  onClose,
  items,
  account,
  env,
  existingFiles,
  onExportComplete,
}: ExportModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [fileName, setFileName] = useState(INITIAL_FILE_NAME)
  const [exportType, setExportType] = useState(INITIAL_EXPORT_TYPE)
  const [fileType, setFileType] = useState(INITIAL_FILE_TYPE)
  const [videoSize, setVideoSize] = useState(INITIAL_VIDEO_SIZE)
  const [mounted, setMounted] = useState(isOpen)
  const [shown, setShown] = useState(false)

  const [phase, setPhase] = useState<Phase>('idle')
  const [visiblePhase, setVisiblePhase] = useState<Phase>('idle')
  const [contentShown, setContentShown] = useState(true)
  const [progress, setProgress] = useState(0)
  const [statusIndex, setStatusIndex] = useState(0)
  const [errorKind, setErrorKind] = useState<ErrorKind | null>(null)
  const [itemResults, setItemResults] = useState<ItemResult[]>([])
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false)
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)

  const progressRafRef = useRef<number | null>(null)
  const statusTimerRef = useRef<number | null>(null)
  const queueTimerRef = useRef<number | null>(null)
  const successTimerRef = useRef<number | null>(null)
  const pausedRef = useRef(false)
  const cancelledRef = useRef(false)
  const outcomeRef = useRef<Outcome | null>(null)
  const elapsedRef = useRef(0)
  const lastTickRef = useRef<number | null>(null)

  const validation = useMemo(
    () =>
      validateExport({
        items,
        selected,
        fileName,
        fileType,
        videoSize,
        account,
        existingFiles,
      }),
    [items, selected, fileName, fileType, videoSize, account, existingFiles],
  )

  const clearExportTimers = useCallback(() => {
    if (progressRafRef.current != null) {
      cancelAnimationFrame(progressRafRef.current)
      progressRafRef.current = null
    }
    if (statusTimerRef.current != null) {
      window.clearInterval(statusTimerRef.current)
      statusTimerRef.current = null
    }
    if (queueTimerRef.current != null) {
      window.clearTimeout(queueTimerRef.current)
      queueTimerRef.current = null
    }
    if (successTimerRef.current != null) {
      window.clearTimeout(successTimerRef.current)
      successTimerRef.current = null
    }
  }, [])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (cancelConfirmOpen) {
        setCancelConfirmOpen(false)
        return
      }
      if (
        visiblePhase === 'queued' ||
        visiblePhase === 'exporting' ||
        visiblePhase === 'paused'
      ) {
        setCancelConfirmOpen(true)
        return
      }
      onClose()
    },
    [cancelConfirmOpen, visiblePhase, onClose],
  )

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
      document.body.style.overflow = 'hidden'
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = ''
    }
  }, [isOpen, handleKeyDown])

  useEffect(() => {
    if (isOpen) {
      setMounted(true)
      let raf2 = 0
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setShown(true))
      })
      return () => {
        cancelAnimationFrame(raf1)
        cancelAnimationFrame(raf2)
      }
    }
    setShown(false)
    const t = setTimeout(() => {
      setMounted(false)
      resetAll()
    }, ANIMATION_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  useEffect(() => () => clearExportTimers(), [clearExportTimers])

  const visiblePhaseRef = useRef(visiblePhase)
  visiblePhaseRef.current = visiblePhase

  const innerRef = useRef<HTMLDivElement>(null)
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (!mounted) return
    if (!innerRef.current) return
    setMeasuredHeight(innerRef.current.offsetHeight + 48)
  }, [mounted, visiblePhase, itemResults.length])

  useEffect(() => {
    if (phase === visiblePhaseRef.current) return
    setContentShown(false)
    let raf1 = 0
    let raf2 = 0
    const swap = window.setTimeout(() => {
      setVisiblePhase(phase)
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setContentShown(true))
      })
    }, ANIMATION_MS)
    return () => {
      window.clearTimeout(swap)
      if (raf1) cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    }
  }, [phase])

  function resetAll() {
    setSelected(new Set())
    setFileName(INITIAL_FILE_NAME)
    setExportType(INITIAL_EXPORT_TYPE)
    setFileType(INITIAL_FILE_TYPE)
    setVideoSize(INITIAL_VIDEO_SIZE)
    setPhase('idle')
    setVisiblePhase('idle')
    setContentShown(true)
    setProgress(0)
    setStatusIndex(0)
    setErrorKind(null)
    setItemResults([])
    setCancelConfirmOpen(false)
    setOverwriteConfirmed(false)
    setLinkCopied(false)
    setMeasuredHeight(null)
    pausedRef.current = false
    cancelledRef.current = false
    outcomeRef.current = null
    elapsedRef.current = 0
    lastTickRef.current = null
    clearExportTimers()
  }

  function beginExportFlow() {
    if (!validation.canExport) return
    if (validation.needsConfirm && !overwriteConfirmed) {
      setPhase('confirming')
      return
    }
    runQueueThenExport()
  }

  function runQueueThenExport() {
    cancelledRef.current = false
    pausedRef.current = false
    elapsedRef.current = 0
    lastTickRef.current = null
    setProgress(0)
    setStatusIndex(0)
    setErrorKind(null)
    setItemResults([])

    outcomeRef.current = computeOutcome({
      totalSizeMB: validation.totalSizeMB,
      env,
      exportType,
      selectedItems: validation.selectedItems,
    })

    setPhase('queued')
    queueTimerRef.current = window.setTimeout(() => {
      queueTimerRef.current = null
      if (cancelledRef.current) return
      startExporting()
    }, QUEUE_WAIT_MS)
  }

  function startExporting() {
    setPhase('exporting')
    pausedRef.current = false
    lastTickRef.current = null

    const tick = (now: number) => {
      if (cancelledRef.current) {
        progressRafRef.current = null
        return
      }
      if (pausedRef.current) {
        lastTickRef.current = now
        progressRafRef.current = requestAnimationFrame(tick)
        return
      }
      if (lastTickRef.current == null) lastTickRef.current = now
      const delta = now - lastTickRef.current
      lastTickRef.current = now
      elapsedRef.current += delta
      const pct = Math.min(100, (elapsedRef.current / PROGRESS_DURATION_MS) * 100)
      setProgress(pct)

      const outcome = outcomeRef.current
      if (
        outcome &&
        outcome.kind === 'failure' &&
        outcome.failAtProgress != null &&
        pct >= outcome.failAtProgress
      ) {
        progressRafRef.current = null
        finalizeFailure(outcome.error!)
        return
      }

      if (pct < 100) {
        progressRafRef.current = requestAnimationFrame(tick)
      } else {
        progressRafRef.current = null
        if (statusTimerRef.current != null) {
          window.clearInterval(statusTimerRef.current)
          statusTimerRef.current = null
        }
        successTimerRef.current = window.setTimeout(() => finalizeSuccess(), 400)
      }
    }
    progressRafRef.current = requestAnimationFrame(tick)

    statusTimerRef.current = window.setInterval(() => {
      if (!pausedRef.current) {
        setStatusIndex((prev) => (prev + 1) % STATUS_MESSAGES.length)
      }
    }, STATUS_CYCLE_MS)
  }

  function finalizeSuccess() {
    const outcome = outcomeRef.current
    if (outcome?.kind === 'partial' && outcome.itemResults) {
      setItemResults(outcome.itemResults)
      setPhase('partial')
    } else {
      onExportComplete?.(validation.totalDurationSeconds, validation.totalSizeMB)
      setPhase('success')
    }
  }

  function finalizeFailure(kind: ErrorKind) {
    if (statusTimerRef.current != null) {
      window.clearInterval(statusTimerRef.current)
      statusTimerRef.current = null
    }
    setErrorKind(kind)
    setPhase('failure')
  }

  function handlePause() {
    pausedRef.current = true
    setPhase('paused')
  }

  function handleResume() {
    pausedRef.current = false
    lastTickRef.current = null
    setPhase('exporting')
  }

  function handleCloseAttempt() {
    if (
      visiblePhase === 'queued' ||
      visiblePhase === 'exporting' ||
      visiblePhase === 'paused'
    ) {
      setCancelConfirmOpen(true)
      return
    }
    onClose()
  }

  function handleConfirmCancel() {
    cancelledRef.current = true
    pausedRef.current = false
    clearExportTimers()
    setCancelConfirmOpen(false)
    onClose()
  }

  function handleRetry() {
    runQueueThenExport()
  }

  function handleConfirmContinue() {
    setOverwriteConfirmed(true)
    runQueueThenExport()
  }

  function handleConfirmGoBack() {
    setPhase('idle')
  }

  function handleCopyLink() {
    const url = `${SHARE_LINK_BASE}${fileName.trim()}`
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(url).catch(() => {})
    }
    setLinkCopied(true)
    window.setTimeout(() => setLinkCopied(false), 2000)
  }

  if (!mounted) return null

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => {
    const selectableIds = items.filter((i) => i.sourceAvailable).map((i) => i.id)
    setSelected((prev) =>
      prev.size === selectableIds.length ? new Set() : new Set(selectableIds),
    )
  }

  const firstSelectedItem = validation.selectedItems[0] ?? items[0]
  const displayFilename = validation.fullFilename
  const progressPct = Math.min(100, Math.round(progress))
  const isCompact = visiblePhase !== 'idle'
  const isSuccess = visiblePhase === 'success'

  return (
    <>
      <div
        className={cn(
          'fixed inset-0 bg-modal-scrim backdrop-blur-[16px] z-50 transition-opacity duration-200',
          shown ? 'opacity-100 ease-out' : 'opacity-0 ease-in',
        )}
        onClick={handleCloseAttempt}
        aria-hidden="true"
      />
      {isSuccess && contentShown && <SuccessCelebration />}
      <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Share"
          style={{ height: measuredHeight != null ? `${measuredHeight}px` : undefined }}
          className={cn(
            'export-token-drift',
            'pointer-events-auto bg-surface-bg rounded-3xl p-6 flex flex-col overflow-hidden',
            'transition-[opacity,translate,width,height] duration-200',
            isSuccess
              ? 'w-[480px] max-w-[calc(100vw-96px)] shadow-[0_30px_80px_-20px_rgba(82,80,243,0.45),0_10px_30px_-10px_rgba(71,252,116,0.35)]'
              : isCompact
              ? 'w-[640px] max-w-[calc(100vw-96px)]'
              : 'w-[calc(100vw-96px)]',
            shown ? 'opacity-100 translate-y-0 ease-out' : 'opacity-0 translate-y-6 ease-in',
          )}
        >
          <div ref={innerRef} className="flex flex-col w-full">
            {visiblePhase === 'idle' && (
              <IdleContent
                contentShown={contentShown}
                items={items}
                selected={selected}
                onToggle={toggle}
                onSelectAll={selectAll}
                fileName={fileName}
                onFileName={(v) => {
                  setFileName(v)
                  setOverwriteConfirmed(false)
                }}
                exportType={exportType}
                onExportType={setExportType}
                fileType={fileType}
                onFileType={(v) => {
                  setFileType(v)
                  setOverwriteConfirmed(false)
                }}
                videoSize={videoSize}
                onVideoSize={setVideoSize}
                validation={validation}
                account={account}
                onClose={onClose}
                onExport={beginExportFlow}
                linkCopied={linkCopied}
                onCopyLink={handleCopyLink}
              />
            )}

            {visiblePhase === 'confirming' && (
              <ConfirmingContent
                contentShown={contentShown}
                validation={validation}
                onClose={onClose}
                onContinue={handleConfirmContinue}
                onGoBack={handleConfirmGoBack}
              />
            )}

            {visiblePhase === 'queued' && (
              <QueuedContent
                contentShown={contentShown}
                onClose={handleCloseAttempt}
                onCancel={() => setCancelConfirmOpen(true)}
              />
            )}

            {visiblePhase === 'exporting' && (
              <ExportingContent
                contentShown={contentShown}
                progress={progress}
                progressPct={progressPct}
                statusMessage={STATUS_MESSAGES[statusIndex]}
                onClose={handleCloseAttempt}
                onPause={handlePause}
                onCancel={() => setCancelConfirmOpen(true)}
              />
            )}

            {visiblePhase === 'paused' && (
              <PausedContent
                contentShown={contentShown}
                progress={progress}
                progressPct={progressPct}
                onClose={handleCloseAttempt}
                onResume={handleResume}
                onCancel={() => setCancelConfirmOpen(true)}
              />
            )}

            {visiblePhase === 'success' && (
              <SuccessContent
                contentShown={contentShown}
                item={firstSelectedItem}
                filename={displayFilename}
                sizeMB={validation.totalSizeMB}
                onClose={onClose}
              />
            )}

            {visiblePhase === 'partial' && (
              <PartialContent
                contentShown={contentShown}
                items={validation.selectedItems}
                results={itemResults}
                onClose={onClose}
                onRetryFailed={handleRetry}
              />
            )}

            {visiblePhase === 'failure' && (
              <FailureContent
                contentShown={contentShown}
                kind={errorKind ?? 'encoding'}
                progressPct={progressPct}
                onClose={onClose}
                onRetry={handleRetry}
              />
            )}
          </div>
        </div>
      </div>

      <CancelConfirm
        open={cancelConfirmOpen}
        onKeep={() => setCancelConfirmOpen(false)}
        onDiscard={handleConfirmCancel}
      />
    </>
  )
}

function PhaseHeader({
  title,
  onClose,
  closeLabel = 'Close',
}: {
  title: string
  onClose: () => void
  closeLabel?: string
}) {
  return (
    <div className="flex items-center justify-between shrink-0">
      <h2 className="text-heading text-text-primary">{title}</h2>
      <button
        onClick={onClose}
        aria-label={closeLabel}
        className="size-6 flex items-center justify-center cursor-pointer text-text-primary hover:opacity-70 transition-opacity"
      >
        <X size={24} strokeWidth={1.5} />
      </button>
    </div>
  )
}

function PhaseShell({
  contentShown,
  children,
  height,
}: {
  contentShown: boolean
  children: React.ReactNode
  height?: string
}) {
  return (
    <div
      style={height ? { height } : undefined}
      className={cn(
        'flex flex-col gap-6 w-full transition-[opacity,translate] duration-200',
        height && 'min-h-0',
        contentShown
          ? 'opacity-100 translate-y-0 ease-out'
          : 'opacity-0 translate-y-3 ease-in',
      )}
    >
      {children}
    </div>
  )
}

function Banner({
  variant,
  title,
  body,
  icon,
}: {
  variant: 'warning' | 'danger' | 'info'
  title: string
  body?: string
  icon?: React.ReactNode
}) {
  const styles =
    variant === 'danger'
      ? 'bg-danger/10 border-danger/30 text-text-primary'
      : variant === 'warning'
      ? 'bg-warning/10 border-warning/40 text-text-primary'
      : 'bg-brand-tertiary border-brand-secondary text-text-primary'
  const iconColor =
    variant === 'danger'
      ? 'text-danger'
      : variant === 'warning'
      ? 'text-[#b88600]'
      : 'text-brand-primary'

  return (
    <div
      className={cn(
        'flex gap-3 items-start rounded-xl border px-4 py-3 shrink-0',
        styles,
      )}
      role="alert"
    >
      <span className={cn('shrink-0 mt-0.5', iconColor)}>
        {icon ?? <AlertTriangle size={18} strokeWidth={2} />}
      </span>
      <div className="flex flex-col gap-0.5 min-w-0">
        <p className="text-label-sm font-medium leading-tight">{title}</p>
        {body && <p className="text-[13px] leading-snug text-text-secondary">{body}</p>}
      </div>
    </div>
  )
}

interface IdleContentProps {
  contentShown: boolean
  items: ExportItem[]
  selected: Set<string>
  onToggle: (id: string) => void
  onSelectAll: () => void
  fileName: string
  onFileName: (v: string) => void
  exportType: string
  onExportType: (v: string) => void
  fileType: string
  onFileType: (v: string) => void
  videoSize: string
  onVideoSize: (v: string) => void
  validation: Validation
  account: AccountState
  onClose: () => void
  onExport: () => void
  linkCopied: boolean
  onCopyLink: () => void
}

function IdleContent({
  contentShown,
  items,
  selected,
  onToggle,
  onSelectAll: _onSelectAll,
  fileName,
  onFileName,
  exportType,
  onExportType,
  fileType,
  onFileType,
  videoSize,
  onVideoSize,
  validation,
  account: _account,
  onClose,
  onExport,
  linkCopied,
  onCopyLink,
}: IdleContentProps) {
  return (
    <div
      style={{ height: 'calc(100vh - 144px)' }}
      className={cn(
        'flex flex-col gap-6 min-h-0 w-full transition-[opacity,translate] duration-200',
        contentShown
          ? 'opacity-100 translate-y-0 ease-out'
          : 'opacity-0 translate-y-3 ease-in',
      )}
    >
      <PhaseHeader title="Share" onClose={onClose} />

      <div className="flex gap-4 flex-1 min-h-0">
        <div className="flex-1 overflow-y-auto min-w-0 pr-1 [scrollbar-width:thin]">
          <div
            className="grid gap-4 content-start"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }}
          >
            {items.map((item) => (
              <div key={item.id} className="relative">
                <ItemSelect
                  title={item.title}
                  updated={item.updated}
                  spec={item.spec}
                  duration={item.duration}
                  selected={selected.has(item.id)}
                  onChange={() => onToggle(item.id)}
                  thumbnail={
                    <img
                      src={item.thumb}
                      alt=""
                      className={cn(
                        'w-full h-full object-cover',
                        !item.sourceAvailable && 'grayscale opacity-50',
                      )}
                    />
                  }
                  className="w-full"
                />
                {!item.sourceAvailable && (
                  <div className="absolute top-3 left-3 right-3 flex items-center justify-center gap-1.5 px-2 py-1 rounded-md bg-danger text-on-brand text-[12px] font-medium pointer-events-none">
                    <CircleAlert size={12} />
                    Source missing
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="w-[320px] shrink-0 bg-bg-faint border border-border-secondary rounded-2xl p-6 flex flex-col gap-6 overflow-y-auto">
          <p className="text-heading text-text-primary">Sharing</p>
          <div className="flex flex-col gap-1.5">
            <InputField
              label="Share link"
              value={`${SHARE_LINK_BASE}${fileName}`}
              onChange={(v) =>
                onFileName(v.startsWith(SHARE_LINK_BASE) ? v.slice(SHARE_LINK_BASE.length) : v)
              }
              suffix={
                <button
                  type="button"
                  onClick={onCopyLink}
                  className="text-brand-primary text-[12px] font-medium cursor-pointer hover:opacity-70 transition-opacity"
                >
                  Copy link
                </button>
              }
            />
            {validation.blockers.includes('no-filename') && (
              <p className="text-[12px] text-danger flex items-center gap-1">
                <CircleAlert size={12} />
                Share link slug is required
              </p>
            )}
          </div>
          <SelectField
            label="Access"
            value={exportType}
            onChange={onExportType}
            options={[
              { value: 'public', label: 'Anyone with link' },
              { value: 'restricted', label: 'Restricted' },
            ]}
          />
          <SelectField
            label="Permissions"
            value={fileType}
            onChange={onFileType}
            options={[
              { value: 'view', label: 'Can view' },
              { value: 'comment', label: 'Can comment' },
              { value: 'edit', label: 'Can edit' },
            ]}
          />
          <SelectField
            label="Link expires"
            value={videoSize}
            onChange={onVideoSize}
            options={[
              { value: 'never', label: 'Never' },
              { value: '7d', label: '7 days' },
              { value: '30d', label: '30 days' },
            ]}
          />
          <Checkbox label="Notify on view" defaultChecked />
        </div>
      </div>

      <div className="flex gap-3 items-center shrink-0">
        <div className="flex-1 flex items-center justify-between">
          <button
            onClick={onCopyLink}
            className="text-brand-primary text-[16px] cursor-pointer hover:opacity-70 transition-opacity"
          >
            Copy link
          </button>
          <span
            className={cn(
              'text-[14px] flex items-center gap-1.5',
              linkCopied ? 'text-text-tertiary' : 'text-text-tertiary opacity-0',
            )}
            aria-live="polite"
          >
            Link copied!
          </span>
        </div>
        <Button
          variant="primary"
          iconEnd={<Share2 size={16} />}
          onClick={onExport}
          disabled={!validation.canExport}
        >
          Share
        </Button>
      </div>
    </div>
  )
}

function ConfirmingContent({
  contentShown,
  validation,
  onClose,
  onContinue,
  onGoBack,
}: {
  contentShown: boolean
  validation: Validation
  onClose: () => void
  onContinue: () => void
  onGoBack: () => void
}) {
  return (
    <PhaseShell contentShown={contentShown}>
      <PhaseHeader title="Continue with warnings?" onClose={onClose} />
      <div className="flex flex-col gap-3">
        {validation.warnings.includes('mixed-resolution') && (
          <Banner
            variant="warning"
            title="Mixed source resolutions"
            body={`${validation.uniqueResolutions.join(', ')} sources will be scaled to ${validation.outputResolution}. Lower-resolution items may look soft.`}
          />
        )}
        {validation.warnings.includes('filename-collision') && (
          <Banner
            variant="warning"
            title="Existing file will be overwritten"
            body={`"${validation.fullFilename}" already exists in the destination and will be replaced.`}
          />
        )}
      </div>
      <div className="flex gap-3 items-center justify-end shrink-0">
        <Button variant="subtle" onClick={onGoBack}>
          Go back
        </Button>
        <Button variant="primary" onClick={onContinue}>
          Continue anyway
        </Button>
      </div>
    </PhaseShell>
  )
}

function QueuedContent({
  contentShown,
  onClose,
  onCancel,
}: {
  contentShown: boolean
  onClose: () => void
  onCancel: () => void
}) {
  return (
    <PhaseShell contentShown={contentShown}>
      <PhaseHeader title="Queued" onClose={onClose} />
      <div className="flex flex-col gap-4 w-full">
        <div className="h-1 bg-bg-subtle rounded-[4px] overflow-hidden w-full relative">
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-brand-primary/40 to-transparent animate-[shimmer_1.6s_ease-in-out_infinite]" />
        </div>
        <div className="flex items-center justify-between text-[12px] leading-[1.5] text-text-secondary w-full">
          <p>Waiting in queue (1 ahead)…</p>
          <button
            onClick={onCancel}
            className="text-text-secondary hover:text-text-primary cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </PhaseShell>
  )
}

function ExportingContent({
  contentShown,
  progress,
  progressPct,
  statusMessage,
  onClose,
  onPause,
  onCancel,
}: {
  contentShown: boolean
  progress: number
  progressPct: number
  statusMessage: string
  onClose: () => void
  onPause: () => void
  onCancel: () => void
}) {
  return (
    <PhaseShell contentShown={contentShown}>
      <PhaseHeader title="Exporting" onClose={onClose} />
      <div className="flex flex-col gap-4 w-full">
        <div
          className="h-1 bg-bg-subtle rounded-[4px] overflow-hidden w-full"
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full bg-brand-primary will-change-[width]"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[12px] leading-[1.5] text-text-secondary w-full">
          <p>{statusMessage}</p>
          <p>{progressPct}%</p>
        </div>
        <div className="flex gap-2 items-center justify-end">
          <Button variant="subtle" iconStart={<Pause size={14} />} onClick={onPause}>
            Pause
          </Button>
          <Button variant="subtle" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </PhaseShell>
  )
}

function PausedContent({
  contentShown,
  progress,
  progressPct,
  onClose,
  onResume,
  onCancel,
}: {
  contentShown: boolean
  progress: number
  progressPct: number
  onClose: () => void
  onResume: () => void
  onCancel: () => void
}) {
  return (
    <PhaseShell contentShown={contentShown}>
      <PhaseHeader title="Paused" onClose={onClose} />
      <div className="flex flex-col gap-4 w-full">
        <div
          className="h-1 bg-bg-subtle rounded-[4px] overflow-hidden w-full"
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full bg-brand-primary opacity-60"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[12px] leading-[1.5] text-text-secondary w-full">
          <p>Paused at {progressPct}%</p>
        </div>
        <div className="flex gap-2 items-center justify-end">
          <Button variant="subtle" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" iconStart={<Play size={14} />} onClick={onResume}>
            Resume
          </Button>
        </div>
      </div>
    </PhaseShell>
  )
}

const CONFETTI_COLORS = ['#5250f3', '#47fc74', '#f8d33f', '#d1d0f9', '#7b7ab8', '#eaeaff']

type ConfettiShape = 'square' | 'circle' | 'streamer'

interface ConfettiParticle {
  tx: number
  ty: number
  rot: number
  sway: number
  delay: number
  duration: number
  color: string
  width: number
  height: number
  shape: ConfettiShape
}

const VIEWPORT_CONFETTI: ConfettiParticle[] = Array.from({ length: 96 }, (_, i) => {
  const angle = (i / 96) * Math.PI * 2 + (i % 5) * 0.04
  const dist = 280 + ((i * 47) % 420)
  const tx = Math.cos(angle) * dist
  const ty = Math.sin(angle) * dist - Math.abs(Math.sin(angle)) * 80
  const shapeIdx = i % 5
  const shape: ConfettiShape =
    shapeIdx === 3 ? 'streamer' : shapeIdx === 1 ? 'circle' : 'square'
  return {
    tx,
    ty,
    rot: ((i * 67) % 1080) - 540,
    sway: ((i * 31) % 70) - 35,
    delay: (i % 14) * 12,
    duration: 1500 + ((i * 41) % 900),
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    width: shape === 'streamer' ? 3 : shape === 'circle' ? 8 + (i % 4) : 7 + (i % 4),
    height: shape === 'streamer' ? 14 + (i % 10) : shape === 'circle' ? 8 + (i % 4) : 7 + (i % 4),
    shape,
  }
})

const AMBIENT_BUBBLES = Array.from({ length: 16 }, (_, i) => ({
  left: (i * 6.25 + ((i * 17) % 7)) % 100,
  size: 4 + ((i * 13) % 9),
  color: ['#5250f3', '#47fc74', '#d1d0f9', '#eaeaff', '#f8d33f'][i % 5],
  sway: ((i * 23) % 80) - 40,
  duration: 6000 + ((i * 311) % 4500),
  delay: ((i * 211) % 4500),
}))

const SHOCKWAVE_RINGS = [
  { delay: 60, color: 'rgba(71,252,116,0.55)', borderWidth: 4, duration: 1200 },
  { delay: 220, color: 'rgba(82,80,243,0.45)', borderWidth: 3, duration: 1400 },
  { delay: 420, color: 'rgba(71,252,116,0.30)', borderWidth: 2, duration: 1600 },
]

function SuccessCelebration() {
  return (
    <>
      {/* Background layer — celebration tint, shockwaves, ambient bubbles */}
      <div
        data-success-anim
        aria-hidden="true"
        className="fixed inset-0 z-50 pointer-events-none overflow-hidden"
      >
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 65% 55% at 50% 50%, rgba(71,252,116,0.22) 0%, rgba(82,80,243,0.10) 45%, transparent 78%)',
            animation: 'celebrate-tint 1400ms 60ms ease-out both',
          }}
        />
        {SHOCKWAVE_RINGS.map((r, i) => (
          <div
            key={i}
            className="absolute top-1/2 left-1/2 size-[420px] rounded-full"
            style={{
              borderStyle: 'solid',
              borderWidth: `${r.borderWidth}px`,
              borderColor: r.color,
              animation: `viewport-shockwave ${r.duration}ms ${r.delay}ms cubic-bezier(0.22, 1, 0.36, 1) both`,
            }}
          />
        ))}
        {AMBIENT_BUBBLES.map((b, i) => (
          <span
            key={i}
            className="absolute rounded-full"
            style={{
              left: `${b.left}%`,
              bottom: '-32px',
              width: `${b.size}px`,
              height: `${b.size}px`,
              backgroundColor: b.color,
              ['--sway' as string]: `${b.sway}px`,
              animation: `drift-up ${b.duration}ms ${b.delay}ms linear infinite`,
            }}
          />
        ))}
      </div>

      {/* Foreground layer — confetti cannon over modal */}
      <div
        data-success-anim
        aria-hidden="true"
        className="fixed inset-0 z-[55] pointer-events-none overflow-hidden flex items-center justify-center"
      >
        {VIEWPORT_CONFETTI.map((p, i) => (
          <span
            key={i}
            className={cn(
              'absolute',
              p.shape === 'circle'
                ? 'rounded-full'
                : p.shape === 'streamer'
                ? 'rounded-[2px]'
                : 'rounded-[1px]',
            )}
            style={{
              width: `${p.width}px`,
              height: `${p.height}px`,
              backgroundColor: p.color,
              ['--tx' as string]: `${p.tx}px`,
              ['--ty' as string]: `${p.ty}px`,
              ['--rot' as string]: `${p.rot}deg`,
              ['--sway' as string]: `${p.sway}px`,
              animation: `confetti-physics ${p.duration}ms ${p.delay}ms cubic-bezier(0.18, 0.7, 0.4, 1) both`,
              boxShadow: p.shape === 'streamer' ? '0 0 0.5px rgba(0,0,0,0.1)' : undefined,
            }}
          />
        ))}
      </div>
    </>
  )
}

function StampBadge() {
  return (
    <div
      data-success-anim
      aria-hidden="true"
      className="absolute -top-4 -right-4 z-30 pointer-events-none"
      style={{ animation: 'stamp-down 700ms 360ms cubic-bezier(0.34, 1.56, 0.64, 1) both' }}
    >
      <div
        className="absolute inset-0 rounded-full bg-success/50 blur-2xl"
        style={{ animation: 'success-flash 800ms 360ms ease-out both' }}
      />
      <div className="relative size-16 rounded-full bg-success flex items-center justify-center shadow-[0_16px_48px_-8px_rgba(71,252,116,0.85),0_0_0_4px_rgba(255,255,255,0.95)]">
        <Check
          size={36}
          strokeWidth={4}
          className="text-on-reverse"
          style={{
            strokeDasharray: 28,
            animation: 'success-check 480ms 640ms cubic-bezier(0.65, 0, 0.35, 1) both',
          }}
        />
      </div>
    </div>
  )
}

function SuccessContent({
  contentShown,
  item,
  filename,
  sizeMB,
  onClose,
}: {
  contentShown: boolean
  item: ExportItem | undefined
  filename: string
  sizeMB: number
  onClose: () => void
}) {
  return (
    <PhaseShell contentShown={contentShown}>
      <div className="flex items-center justify-end shrink-0 -mb-2">
        <button
          onClick={onClose}
          aria-label="Close"
          className="size-6 flex items-center justify-center cursor-pointer text-text-primary hover:opacity-70 transition-opacity"
        >
          <X size={24} strokeWidth={1.5} />
        </button>
      </div>

      <div
        className="relative pt-4"
        style={{ perspective: '1200px' }}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-8 z-0"
          style={{
            background:
              'radial-gradient(ellipse closest-side at 50% 40%, rgba(71,252,116,0.28) 0%, rgba(82,80,243,0.10) 55%, transparent 100%)',
            animation: 'success-glow 1300ms 120ms ease-out both',
          }}
        />

        <div
          className="relative w-full"
          style={{
            transformStyle: 'preserve-3d',
            animation: 'trophy-land 850ms 80ms cubic-bezier(0.34, 1.46, 0.64, 1) both',
          }}
        >
          <div className="relative aspect-[16/9] w-full rounded-2xl overflow-hidden bg-[#868686] shadow-[0_28px_60px_-20px_rgba(82,80,243,0.45),0_8px_24px_-8px_rgba(71,252,116,0.35)]">
            {item && <img src={item.thumb} alt="" className="w-full h-full object-cover" />}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-10"
              style={{
                background:
                  'linear-gradient(110deg, transparent 25%, rgba(255,255,255,0.6) 50%, transparent 75%)',
                animation: 'success-shine 1300ms 380ms cubic-bezier(0.22, 1, 0.36, 1) both',
              }}
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 z-10"
              style={{
                background:
                  'linear-gradient(to top, rgba(0,0,0,0.55) 0%, transparent 100%)',
              }}
            />
            <p
              className="absolute left-4 bottom-3 right-20 z-20 text-[18px] font-medium text-white truncate drop-shadow-[0_2px_6px_rgba(0,0,0,0.5)]"
              style={{
                animation: 'success-title 600ms 760ms cubic-bezier(0.34, 1.56, 0.64, 1) both',
              }}
            >
              {item?.title ?? 'Export'}
            </p>
          </div>
          <StampBadge />
        </div>

        <div
          className="relative flex flex-col items-center text-center gap-1 mt-6"
          style={{ animation: 'success-title 600ms 880ms cubic-bezier(0.34, 1.56, 0.64, 1) both' }}
        >
          <p className="text-title text-text-primary">Export complete</p>
          <p
            className="text-[14px] text-text-secondary tabular-nums"
            style={{
              animation:
                'filename-collapse 700ms 1000ms cubic-bezier(0.22, 1, 0.36, 1) both',
            }}
          >
            {filename} · {formatMB(sizeMB)}
          </p>
        </div>
      </div>

      <div
        className="flex gap-2 items-center justify-center shrink-0"
        style={{ animation: 'success-title 500ms 1140ms cubic-bezier(0.34, 1.56, 0.64, 1) both' }}
      >
        <Button variant="subtle" onClick={onClose}>
          Done
        </Button>
        <Button variant="primary" iconStart={<Download size={14} />}>
          Show in folder
        </Button>
      </div>
    </PhaseShell>
  )
}

function PartialContent({
  contentShown,
  items,
  results,
  onClose,
  onRetryFailed,
}: {
  contentShown: boolean
  items: ExportItem[]
  results: ItemResult[]
  onClose: () => void
  onRetryFailed: () => void
}) {
  const succeeded = results.filter((r) => r.status === 'success').length
  const failed = results.filter((r) => r.status === 'failed').length

  return (
    <PhaseShell contentShown={contentShown}>
      <PhaseHeader title="Export complete with errors" onClose={onClose} />
      <p className="text-[14px] text-text-secondary -mt-2">
        {succeeded} of {results.length} exported. {failed} failed.
      </p>
      <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto">
        {results.map((r) => {
          const item = items.find((i) => i.id === r.itemId)
          if (!item) return null
          const ok = r.status === 'success'
          return (
            <div
              key={r.itemId}
              className="flex items-center gap-3 p-2 rounded-lg bg-bg-faint border border-border-secondary"
            >
              <div className="size-12 rounded-md overflow-hidden bg-[#868686] shrink-0">
                <img src={item.thumb} alt="" className="w-full h-full object-cover" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-label-sm text-text-primary truncate">{item.title}</p>
                <p className="text-[12px] text-text-secondary truncate">
                  {ok ? 'Exported' : `Failed · ${r.reason ?? 'Unknown error'}`}
                </p>
              </div>
              <span
                className={cn(
                  'shrink-0 size-6 rounded-full flex items-center justify-center',
                  ok ? 'text-success' : 'text-danger',
                )}
              >
                {ok ? <CheckCircle2 size={20} /> : <XCircle size={20} />}
              </span>
            </div>
          )
        })}
      </div>
      <div className="flex gap-2 items-center justify-end shrink-0">
        <Button variant="subtle" onClick={onClose}>
          Open completed
        </Button>
        <Button
          variant="primary"
          iconStart={<RefreshCw size={14} />}
          onClick={onRetryFailed}
          disabled={failed === 0}
        >
          Retry failed
        </Button>
      </div>
    </PhaseShell>
  )
}

function FailureContent({
  contentShown,
  kind,
  progressPct,
  onClose,
  onRetry,
}: {
  contentShown: boolean
  kind: ErrorKind
  progressPct: number
  onClose: () => void
  onRetry: () => void
}) {
  const copy: Record<ErrorKind, { title: string; body: string; icon: React.ReactNode }> = {
    'disk-full': {
      title: 'Not enough disk space',
      body: `Export stopped at ${progressPct}%. Free up space on the destination drive and try again.`,
      icon: <HardDrive size={20} />,
    },
    encoding: {
      title: 'Encoding error',
      body: `Export failed at ${progressPct}%. The selected format or codec couldn't process one of the source clips.`,
      icon: <CircleAlert size={20} />,
    },
    network: {
      title: 'Connection lost',
      body: `Export stopped at ${progressPct}%. Check your network and try again.`,
      icon: <WifiOff size={20} />,
    },
  }
  const { title, body, icon } = copy[kind]

  return (
    <PhaseShell contentShown={contentShown}>
      <PhaseHeader title="Export failed" onClose={onClose} />
      <div className="flex gap-3 items-start p-4 rounded-2xl bg-danger/10 border border-danger/30">
        <span className="text-danger shrink-0 mt-0.5">{icon}</span>
        <div className="flex flex-col gap-1 min-w-0">
          <p className="text-label font-medium text-text-primary">{title}</p>
          <p className="text-[13px] text-text-secondary leading-snug">{body}</p>
        </div>
      </div>
      <div className="flex gap-2 items-center justify-end shrink-0">
        <Button variant="subtle" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" iconStart={<RefreshCw size={14} />} onClick={onRetry}>
          Retry
        </Button>
      </div>
    </PhaseShell>
  )
}

function CancelConfirm({
  open,
  onKeep,
  onDiscard,
}: {
  open: boolean
  onKeep: () => void
  onDiscard: () => void
}) {
  if (!open) return null
  return (
    <>
      <div
        className="fixed inset-0 bg-modal-scrim/60 z-[60]"
        onClick={onKeep}
        aria-hidden="true"
      />
      <div className="fixed inset-0 z-[60] flex items-center justify-center pointer-events-none">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Discard export?"
          className="pointer-events-auto bg-surface-bg rounded-2xl p-6 w-[400px] max-w-[calc(100vw-48px)] flex flex-col gap-4 shadow-xl"
        >
          <div className="flex flex-col gap-1.5">
            <h3 className="text-heading text-text-primary">Discard partial export?</h3>
            <p className="text-[13px] text-text-secondary leading-snug">
              The current export will be cancelled and any partial files will be removed.
            </p>
          </div>
          <div className="flex gap-2 items-center justify-end">
            <Button variant="subtle" onClick={onKeep}>
              Keep going
            </Button>
            <Button variant="primary" onClick={onDiscard}>
              Discard
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}

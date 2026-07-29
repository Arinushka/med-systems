import { useEffect, useRef, useState, type CSSProperties } from 'react'
import JSZip from 'jszip'

function formatDateYmd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function konturSearchDateRange(days = 20): { DateTimeFrom: string; DateTimeTo: string } {
  const to = new Date()
  const from = new Date()
  from.setDate(to.getDate() - (days - 1))
  return { DateTimeFrom: formatDateYmd(from), DateTimeTo: formatDateYmd(to) }
}

type LibraryDoc = {
  id: string
  originalFilename: string
  extension: string
  storedPath: string
  folderId?: string | null
  contentHash?: string | null
  indexedAt: string
}

type LibraryFolder = {
  id: string
  name: string
  createdAt: string
}

type MatchResult = {
  id: string
  originalFilename: string
  storedPath: string
  extension: string
  score: number
}

type RowResult = {
  indicator: string
  queryValueRaw: string
  matchedLibraryIndicator?: string
  matchedLibraryValueRaw?: string
  indicatorSimilarity: number
  indicatorOk: boolean
  valueMatch: boolean
  valueReason: string
  rowMatched: boolean
}

type AnalyzerInfo = {
  hasAnalyzer: boolean
  analyzers: string[]
}

type EmailNotification = {
  sent: boolean
  reason?: string
}

type TenderKey = {
  _id: string
  name: string
  Text?: string[]
  Exclude?: string[]
}

type TenderListItem = {
  _id: string
  orderName: string
  href?: string | null
  maxPrice?: number | null
  auctionNumber?: string | null
  customerName?: string | null
  customerInn?: string | null
}

type TenderAttachmentItem = {
  realName: string
  href: string
  source?: 'tenderplan' | 'kontur'
  zipArchiveKey?: string
  zipEntryPath?: string
}

type TenderMetaForMatch = {
  auctionNumber: string | null
  customerName: string | null
  customerInn: string | null
  maxPrice: number | null
  sourceUrl: string | null
}

type KonturListItem = {
  id: string
  orderName: string
  link: string | null
  maxPrice: number | null
}

type TenderLoadCacheEntry = {
  tenderItems: TenderListItem[]
  tenderItemsError: string
  konturItems: KonturListItem[]
  konturSearchError: string
}

type AutoMatchIntervalCode = '3m' | '5m' | '10m' | '30m' | '60m'

type AutoMatchHistoryItem = {
  timestamp: string
  keyId: string
  tenderId: string
  attachmentName: string
  status: 'matched' | 'no_match' | 'skipped' | 'error'
  message?: string
  matchPercent?: number
  bestMatchFilename?: string | null
}

type AutoMatchStatus = {
  enabled: boolean
  interval: AutoMatchIntervalCode
  running: boolean
  currentRunStartedAt: string | null
  lastRunAt: string | null
  lastRunFinishedAt: string | null
  stats: {
    processed: number
    matched: number
    noMatch: number
    skipped: number
    errors: number
  }
  currentItem: {
    stage: 'keys' | 'tenders' | 'tender_details' | 'attachment_download' | 'matching'
    keyId?: string
    tenderId?: string
    attachmentName?: string
    updatedAt: string
  } | null
  history: AutoMatchHistoryItem[]
}

const SEND_EMAIL_NOTIFICATIONS_STORAGE_KEY = 'ms:send-email-notifications'
const SEND_CRM_NOTIFICATIONS_STORAGE_KEY = 'ms:send-crm-notifications'
const MATCH_MIN_PERCENT_STORAGE_KEY = 'ms:match-min-percent-threshold'
const SELECTED_TENDER_KEY_IDS_STORAGE_KEY = 'ms:selected-tender-key-ids'

function readStoredBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (raw == null) return fallback
    if (raw === 'true') return true
    if (raw === 'false') return false
    return fallback
  } catch {
    return fallback
  }
}

function readStoredPercentThreshold(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = Number(window.localStorage.getItem(key))
    if (!Number.isFinite(raw)) return fallback
    if (raw < 0) return 0
    if (raw > 100) return 100
    return Math.round(raw)
  } catch {
    return fallback
  }
}

function readStoredStringArray(key: string, fallback: string[]): string[] {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return fallback
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    return fallback
  }
}

const AUTO_MATCH_INTERVAL_OPTIONS: Array<{ value: AutoMatchIntervalCode; label: string }> = [
  { value: '3m', label: '3 мин' },
  { value: '5m', label: '5 мин' },
  { value: '10m', label: '10 мин' },
  { value: '30m', label: '30 мин' },
  { value: '60m', label: '60 мин' },
]

function parseKonturItems(raw: unknown): KonturListItem[] {
  const result = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const items = Array.isArray(result?.Items) ? result.Items : []
  return items.map((x: any, idx: number) => ({
    id: String(x?.Id ?? x?.id ?? x?.Guid ?? x?.guid ?? idx),
    orderName: String(x?.OrderName ?? x?.orderName ?? ''),
    link: typeof (x?.Link ?? x?.link) === 'string' ? String(x?.Link ?? x?.link) : null,
    maxPrice:
      typeof (x?.MaxPrice ?? x?.maxPrice) === 'number'
        ? (x?.MaxPrice ?? x?.maxPrice)
        : Number.isFinite(Number(x?.MaxPrice ?? x?.maxPrice))
          ? Number(x?.MaxPrice ?? x?.maxPrice)
          : null,
  }))
}

function konturAttachmentsFromPurchase(detail: Record<string, unknown>): TenderAttachmentItem[] {
  const docs = Array.isArray(detail.Docs) ? detail.Docs : []
  return docs
    .filter((x: any) => typeof x?.Url === 'string' && String(x.Url).trim().length > 0)
    .map((x: any) => ({
      href: String(x.Url),
      realName: String(x?.FileName ?? ''),
      source: 'kontur' as const,
    }))
}

function konturMetaFromPurchase(item: KonturListItem, detail: Record<string, unknown>): TenderMetaForMatch {
  const organizer = detail.Organizer && typeof detail.Organizer === 'object' ? detail.Organizer : null
  const initialSum = detail.InitialSum && typeof detail.InitialSum === 'object' ? detail.InitialSum : null
  return {
    customerName:
      organizer && typeof (organizer as any).FullName === 'string' ? String((organizer as any).FullName) : null,
    customerInn: organizer && typeof (organizer as any).Inn === 'string' ? String((organizer as any).Inn) : null,
    auctionNumber:
      typeof detail.NotificationNumber === 'string' ? detail.NotificationNumber : item.id,
    maxPrice:
      initialSum && Number.isFinite(Number((initialSum as any).Price))
        ? Number((initialSum as any).Price)
        : item.maxPrice,
    sourceUrl:
      typeof detail.EtpLink === 'string'
        ? detail.EtpLink
        : typeof detail.Link === 'string'
          ? detail.Link
          : item.link,
  }
}

function attachmentEndpointBySource(source: TenderAttachmentItem['source']): string {
  return source === 'kontur' ? '/api/kontur/attachment' : '/api/tender-attachment'
}

function buildAttachmentUrl(fileItem: TenderAttachmentItem): string {
  const attachmentEndpoint = attachmentEndpointBySource(fileItem.source)
  return `${attachmentEndpoint}?href=${encodeURIComponent(fileItem.href)}&realName=${encodeURIComponent(fileItem.realName)}`
}

function looksLikeZip(fileName: string): boolean {
  return String(fileName ?? '').toLowerCase().endsWith('.zip')
}

function baseName(pathLike: string): string {
  const normalized = String(pathLike ?? '').replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

function scoreDecodedZipName(value: string): number {
  if (!value) return -1000
  let score = 0
  if (/[\u0400-\u04FF]/.test(value)) score += 6 // Cyrillic
  if (/[A-Za-z]/.test(value)) score += 2
  if (/\.(pdf|doc|docx|xls|xlsx|zip|txt|rtf)$/i.test(value)) score += 4
  if (/[�]/.test(value)) score -= 8 // replacement chars
  return score
}

function decodeZipFileName(bytes: Uint8Array): string {
  const decoders = ['utf-8', 'windows-1251', 'ibm866', 'koi8-r']
  let best = ''
  let bestScore = -10000
  for (const encoding of decoders) {
    try {
      const decoded = new TextDecoder(encoding).decode(bytes)
      const score = scoreDecodedZipName(decoded)
      if (score > bestScore) {
        best = decoded
        bestScore = score
      }
    } catch {
      // try next encoding
    }
  }
  return best || new TextDecoder('utf-8').decode(bytes)
}

function mimeByFilename(filename: string): string {
  const n = filename.toLowerCase()
  if (n.endsWith('.pdf')) return 'application/pdf'
  if (n.endsWith('.doc')) return 'application/msword'
  if (n.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (n.endsWith('.xls')) return 'application/vnd.ms-excel'
  if (n.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (n.endsWith('.txt')) return 'text/plain'
  return 'application/octet-stream'
}

function readAllDirectoryEntries(reader: any): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const entries: any[] = []
    const pump = () => {
      reader.readEntries(
        (batch: any[]) => {
          if (!batch || batch.length === 0) {
            resolve(entries)
            return
          }
          entries.push(...batch)
          pump()
        },
        (err: unknown) => reject(err),
      )
    }
    pump()
  })
}

async function collectFilesFromDropEntry(
  entry: any,
  prefix = '',
): Promise<Array<File & { webkitRelativePath?: string }>> {
  if (!entry) return []
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file(
        (f: File) => resolve(f),
        (err: unknown) => reject(err),
      )
    })
    const relPath = `${prefix}${file.name}`
    const wrapped = new File([file], file.name, {
      type: file.type,
      lastModified: file.lastModified,
    }) as File & { webkitRelativePath?: string }
    try {
      Object.defineProperty(wrapped, 'webkitRelativePath', {
        value: relPath,
        configurable: true,
      })
    } catch {
      // keep plain filename
    }
    return [wrapped]
  }

  if (entry.isDirectory) {
    const reader = entry.createReader()
    const childEntries = await readAllDirectoryEntries(reader)
    const nextPrefix = `${prefix}${entry.name}/`
    const nested = await Promise.all(childEntries.map((child) => collectFilesFromDropEntry(child, nextPrefix)))
    return nested.flat()
  }

  return []
}

async function uploadFile(endpoint: string, file: File, extraFields?: Record<string, string>): Promise<any> {
  const fd = new FormData()
  fd.append('file', file)
  // multer/originalname иногда приходит с неправильной кодировкой для кириллицы.
  // Передаём имя напрямую из браузера, чтобы отображение и индексация были корректными.
  fd.append('clientFilename', file.name)
  if (extraFields) {
    for (const [k, v] of Object.entries(extraFields)) fd.append(k, v)
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    body: fd,
  })

  const json = await resp.json().catch(() => null)
  if (!resp.ok) {
    throw new Error(json?.error ?? `Request failed with status ${resp.status}`)
  }
  return json
}

const supportedLibraryExt = new Set(['.pdf', '.doc', '.docx', '.xlsx', '.xls'])

function restoreUtf8FromLatin1(value: string): string {
  const maybeMojibake = /[ÐÑÒÓÖ×ØÙÚÛÜÝÞßà-ÿ╨╤]/.test(value)
  if (!maybeMojibake) return value
  try {
    const bytes = new Uint8Array(Array.from(value).map((ch) => ch.charCodeAt(0) & 0xff))
    const restored = new TextDecoder('utf-8').decode(bytes)
    if (/[\u0400-\u04FF]/.test(restored)) return restored
  } catch {
    // keep original
  }
  return value
}

function normalizeLibraryFilename(name: string): string {
  return restoreUtf8FromLatin1(String(name ?? '').replace(/\s+/g, ' ').trim())
}

function libraryDisplayName(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath
  return normalizeLibraryFilename(rel && rel.trim().length > 0 ? rel : file.name)
}

function shouldSkipLibraryFile(file: File): { skip: boolean; reason?: string } {
  const name = normalizeLibraryFilename(file.name)
  const lower = name.toLowerCase()
  if (!name) return { skip: true, reason: 'empty-name' }
  // Common OS/Office service files that should never be indexed.
  if (lower === '.ds_store' || lower === 'thumbs.db' || lower === 'desktop.ini') {
    return { skip: true, reason: 'system-file' }
  }
  if (lower.startsWith('~$') || lower.startsWith('._')) {
    return { skip: true, reason: 'temporary-file' }
  }
  const extIdx = lower.lastIndexOf('.')
  const ext = extIdx >= 0 ? lower.slice(extIdx) : ''
  if (!supportedLibraryExt.has(ext)) {
    return { skip: true, reason: 'unsupported-type' }
  }
  return { skip: false }
}

function isTransientLibraryUploadError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('unexpected end of form') ||
    m.includes('networkerror') ||
    m.includes('failed to fetch') ||
    m.includes('fetch failed') ||
    m.includes('request failed with status 5')
  )
}

function fileExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

async function looksLikeValidOfficeContainer(file: File): Promise<boolean> {
  const ext = fileExt(file.name)
  if (ext !== '.docx' && ext !== '.xlsx') return true
  if (file.size < 4) return false
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  // ZIP signature for OOXML containers.
  return head[0] === 0x50 && head[1] === 0x4b
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export default function App() {
  const [library, setLibrary] = useState<LibraryDoc[]>([])
  const [libraryFolders, setLibraryFolders] = useState<LibraryFolder[]>([])
  const [currentLibraryFolderId, setCurrentLibraryFolderId] = useState<string | null>(null)
  const [newLibraryFolderName, setNewLibraryFolderName] = useState('')
  const [movingLibraryDocId, setMovingLibraryDocId] = useState<string | null>(null)
  const [librarySearchQuery, setLibrarySearchQuery] = useState('')
  const [libraryStatus, setLibraryStatus] = useState<string>('')
  const [libraryError, setLibraryError] = useState<string>('')
  const [matchStatus, setMatchStatus] = useState<string>('')
  const [matchError, setMatchError] = useState<string>('')
  const [matches, setMatches] = useState<MatchResult[]>([])
  const [decision, setDecision] = useState<string>('')
  const [matchPercent, setMatchPercent] = useState<number | null>(null)
  const [minMatchPercentThreshold, setMinMatchPercentThreshold] = useState<number>(() =>
    readStoredPercentThreshold(MATCH_MIN_PERCENT_STORAGE_KEY, 30),
  )
  const [matchedCount, setMatchedCount] = useState<number | null>(null)
  const [bestMatchFilename, setBestMatchFilename] = useState<string | null>(null)
  const [rowResults, setRowResults] = useState<RowResult[]>([])
  const [llmExplanation, setLlmExplanation] = useState<string | null>(null)
  const [analyzerInfo, setAnalyzerInfo] = useState<AnalyzerInfo | null>(null)
  const [emailNotification, setEmailNotification] = useState<EmailNotification | null>(null)
  const [crmNotification, setCrmNotification] = useState<EmailNotification | null>(null)
  const [sendEmailNotifications, setSendEmailNotifications] = useState<boolean>(() =>
    readStoredBoolean(SEND_EMAIL_NOTIFICATIONS_STORAGE_KEY, true),
  )
  const [sendCrmNotifications, setSendCrmNotifications] = useState<boolean>(() =>
    readStoredBoolean(SEND_CRM_NOTIFICATIONS_STORAGE_KEY, true),
  )
  const [notificationEmail, setNotificationEmail] = useState('')
  const [notificationEmailDraft, setNotificationEmailDraft] = useState('')
  const [notificationEmailApplyError, setNotificationEmailApplyError] = useState('')
  const [settingsSaveStatus, setSettingsSaveStatus] = useState('')
  const [settingsSaveError, setSettingsSaveError] = useState('')
  const [isNotificationSettingsModalOpen, setIsNotificationSettingsModalOpen] = useState(false)
  const [notificationSettingsModalText, setNotificationSettingsModalText] = useState('')
  const [tenderKeys, setTenderKeys] = useState<TenderKey[]>([])
  const [selectedTenderKeyIds, setSelectedTenderKeyIds] = useState<string[]>(() =>
    readStoredStringArray(SELECTED_TENDER_KEY_IDS_STORAGE_KEY, []),
  )
  const [isTenderKeyDropdownOpen, setIsTenderKeyDropdownOpen] = useState(false)
  const [tenderKeysError, setTenderKeysError] = useState<string>('')
  const [tenderItems, setTenderItems] = useState<TenderListItem[]>([])
  const [tenderItemsError, setTenderItemsError] = useState<string>('')
  const [tenderAttachments, setTenderAttachments] = useState<TenderAttachmentItem[]>([])
  const [tenderAttachmentsError, setTenderAttachmentsError] = useState<string>('')
  const [konturItems, setKonturItems] = useState<KonturListItem[]>([])
  const [konturSearchError, setKonturSearchError] = useState<string>('')
  const [isTenderModalOpen, setIsTenderModalOpen] = useState(false)
  const [isAutoMatchLogsModalOpen, setIsAutoMatchLogsModalOpen] = useState(false)
  const [isClearLibraryModalOpen, setIsClearLibraryModalOpen] = useState(false)
  const [isTenderItemsLoading, setIsTenderItemsLoading] = useState(false)
  const [isAttachmentLoading, setIsAttachmentLoading] = useState(false)
  const [selectedRemoteFilename, setSelectedRemoteFilename] = useState<string>('')
  const [selectedTenderMeta, setSelectedTenderMeta] = useState<TenderMetaForMatch | null>(null)
  const tenderKeyDropdownRef = useRef<HTMLDivElement | null>(null)
  const libraryFileInputRef = useRef<HTMLInputElement | null>(null)
  const matchFileInputRef = useRef<HTMLInputElement | null>(null)
  const libraryOperationInProgressRef = useRef(false)
  const tenderLoadCacheRef = useRef<Map<string, TenderLoadCacheEntry>>(new Map())
  const zipArchivesRef = useRef<Map<string, JSZip>>(new Map())
  const [tenderModalStep, setTenderModalStep] = useState<'tenders' | 'attachments'>('tenders')
  const [autoMatchStatus, setAutoMatchStatus] = useState<AutoMatchStatus | null>(null)
  const [autoMatchIntervalDraft, setAutoMatchIntervalDraft] = useState<AutoMatchIntervalCode>('10m')
  const [autoMatchError, setAutoMatchError] = useState('')
  const [autoMatchBusy, setAutoMatchBusy] = useState(false)
  const [minCriteriaIfNameMatched, setMinCriteriaIfNameMatched] = useState(2)
  const minC = minCriteriaIfNameMatched
  const isMatchByPoints =
    decision === 'match' ||
    (matchedCount ?? 0) >= minC ||
    rowResults.length >= minC
  const autoMatchVisibleHistory = (() => {
    const all = Array.isArray(autoMatchStatus?.history) ? autoMatchStatus.history : []
    const runStartIso = autoMatchStatus?.currentRunStartedAt ?? autoMatchStatus?.lastRunAt ?? null
    if (!runStartIso) return all
    const runStart = Date.parse(runStartIso)
    if (!Number.isFinite(runStart)) return all
    return all.filter((item) => {
      const ts = Date.parse(String(item?.timestamp ?? ''))
      return Number.isFinite(ts) && ts >= runStart
    })
  })()
  const autoMatchHistoryForLogs = autoMatchVisibleHistory.slice().reverse()
  const autoMatchMatchedLogs = autoMatchHistoryForLogs.filter((item) => item.status === 'matched')
  const autoMatchErrorLogs = autoMatchHistoryForLogs.filter((item) => item.status === 'error')
  const autoMatchSkippedLogs = autoMatchHistoryForLogs.filter((item) => item.status === 'skipped')
  const normalizedLibrarySearchQuery = librarySearchQuery.trim().toLowerCase()
  const currentLibraryFolder =
    currentLibraryFolderId == null
      ? null
      : libraryFolders.find((f) => f.id === currentLibraryFolderId) ?? null
  const visibleLibraryDocs =
    currentLibraryFolderId == null
      ? library.filter((d) => !d.folderId)
      : library.filter((d) => d.folderId === currentLibraryFolderId)
  const visibleLibraryFolders = currentLibraryFolderId == null ? libraryFolders : []
  const filteredLibrary =
    normalizedLibrarySearchQuery.length === 0
      ? visibleLibraryDocs
      : visibleLibraryDocs.filter((d) => d.originalFilename.toLowerCase().includes(normalizedLibrarySearchQuery))
  function openNotificationSettingsModal(channel: 'email' | 'crm') {
    if (channel === 'email') {
      const emailValue =
        notificationEmailDraft.trim().length > 0 ? notificationEmailDraft.trim() : notificationEmail.trim()
      setNotificationSettingsModalText(
        emailValue.length > 0
          ? `Результаты будут направлены по почте (${emailValue}).`
          : 'Результаты будут направлены по почте (адрес по умолчанию).',
      )
    } else {
      setNotificationSettingsModalText('Результаты будут направлены в CRM.')
    }
    setIsNotificationSettingsModalOpen(true)
  }

  function applyNotificationEmail() {
    const trimmed = notificationEmailDraft.trim()
    if (sendEmailNotifications && trimmed.length > 0 && !isValidEmail(trimmed)) {
      setNotificationEmailApplyError('Введите корректный email')
      return
    }
    setNotificationEmailApplyError('')
    setNotificationEmail(trimmed)
  }

  function saveTenderSettings() {
    setSettingsSaveStatus('')
    setSettingsSaveError('')
    try {
      window.localStorage.setItem(SEND_EMAIL_NOTIFICATIONS_STORAGE_KEY, String(sendEmailNotifications))
      window.localStorage.setItem(SEND_CRM_NOTIFICATIONS_STORAGE_KEY, String(sendCrmNotifications))
      window.localStorage.setItem(MATCH_MIN_PERCENT_STORAGE_KEY, String(minMatchPercentThreshold))
      window.localStorage.setItem(SELECTED_TENDER_KEY_IDS_STORAGE_KEY, JSON.stringify(selectedTenderKeyIds))
      setSettingsSaveStatus('Настройки сохранены')
    } catch {
      setSettingsSaveError('Не удалось сохранить настройки')
    }
  }

  async function refreshLibrary(): Promise<LibraryDoc[]> {
    const resp = await fetch('/api/library/list')
    const json = await resp.json()
    if (!resp.ok) throw new Error(json?.error ?? 'Failed to load library')
    const docs: LibraryDoc[] = json.docs ?? []
    const folders: LibraryFolder[] = Array.isArray(json.folders) ? json.folders : []
    setLibraryFolders(folders)
    setLibrary(docs)
    setCurrentLibraryFolderId((prev) => {
      if (!prev) return prev
      return folders.some((f) => f.id === prev) ? prev : null
    })
    return docs
  }

  async function createLibraryFolder() {
    setLibraryError('')
    const name = newLibraryFolderName.trim()
    if (!name) {
      setLibraryError('Введите название папки')
      return
    }
    try {
      const resp = await fetch('/api/library/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const json = await resp.json().catch(() => null)
      if (!resp.ok) throw new Error(json?.error ?? `Failed: ${resp.status}`)
      await refreshLibrary()
      setNewLibraryFolderName('')
    } catch (e) {
      setLibraryError(e instanceof Error ? e.message : String(e))
    }
  }

  async function moveLibraryDoc(docId: string, folderId: string | null) {
    setLibraryError('')
    // Optimistic UI: immediately move file in local state.
    setLibrary((prev) => prev.map((doc) => (doc.id === docId ? { ...doc, folderId } : doc)))
    try {
      const resp = await fetch('/api/library/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId, folderId }),
      })
      const json = await resp.json().catch(() => null)
      if (!resp.ok) throw new Error(json?.error ?? `Failed: ${resp.status}`)
      const moved = json?.doc as LibraryDoc | undefined
      if (moved && moved.id) {
        setLibrary((prev) =>
          prev.map((doc) =>
            doc.id === moved.id
              ? {
                  ...doc,
                  folderId: moved.folderId ?? null,
                }
              : doc,
          ),
        )
      }
      await refreshLibrary()
    } catch (e) {
      // Roll back optimistic move by reloading canonical state.
      await refreshLibrary().catch(() => undefined)
      setLibraryError(e instanceof Error ? e.message : String(e))
    } finally {
      setMovingLibraryDocId(null)
    }
  }

  function readDraggedLibraryDocId(event: React.DragEvent): string {
    const custom = event.dataTransfer.getData('text/library-doc-id')
    if (custom && custom.trim().length > 0) return custom.trim()
    const plain = event.dataTransfer.getData('text/plain')
    if (plain && plain.startsWith('library-doc-id:')) return plain.slice('library-doc-id:'.length).trim()
    return ''
  }

  async function fetchAutoMatchStatus() {
    const resp = await fetch('/api/auto-match/status')
    const json = await resp.json().catch(() => null)
    if (!resp.ok) throw new Error(json?.error ?? `Failed: ${resp.status}`)
    const status = json as AutoMatchStatus
    setAutoMatchStatus(status)
    if (status?.interval) setAutoMatchIntervalDraft(status.interval)
    return status
  }

  async function onAutoMatchStart() {
    setAutoMatchBusy(true)
    setAutoMatchError('')
    try {
      const resp = await fetch('/api/auto-match/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interval: autoMatchIntervalDraft }),
      })
      const json = await resp.json().catch(() => null)
      if (!resp.ok) throw new Error(json?.error ?? `Failed: ${resp.status}`)
      setAutoMatchStatus(json as AutoMatchStatus)
    } catch (e) {
      setAutoMatchError(e instanceof Error ? e.message : String(e))
    } finally {
      setAutoMatchBusy(false)
    }
  }

  async function onAutoMatchStop() {
    setAutoMatchBusy(true)
    setAutoMatchError('')
    try {
      const resp = await fetch('/api/auto-match/stop', { method: 'POST' })
      const json = await resp.json().catch(() => null)
      if (!resp.ok) throw new Error(json?.error ?? `Failed: ${resp.status}`)
      setAutoMatchStatus(json as AutoMatchStatus)
    } catch (e) {
      setAutoMatchError(e instanceof Error ? e.message : String(e))
    } finally {
      setAutoMatchBusy(false)
    }
  }

  async function onAutoMatchRunOnce() {
    setAutoMatchBusy(true)
    setAutoMatchError('')
    try {
      const resp = await fetch('/api/auto-match/run-once', { method: 'POST' })
      const json = await resp.json().catch(() => null)
      if (!resp.ok) throw new Error(json?.error ?? `Failed: ${resp.status}`)
      await fetchAutoMatchStatus()
    } catch (e) {
      setAutoMatchError(e instanceof Error ? e.message : String(e))
    } finally {
      setAutoMatchBusy(false)
    }
  }

  async function clearLibrary() {
    setLibraryError('')
    setLibraryStatus('Очищаю библиотеку...')
    try {
      const resp = await fetch('/api/library/clear', { method: 'POST' })
      const json = await resp.json().catch(() => null)
      if (!resp.ok) throw new Error(json?.error ?? `Failed: ${resp.status}`)
      await refreshLibrary()
      setLibraryStatus('')
      setIsClearLibraryModalOpen(false)
    } catch (e) {
      setLibraryStatus('')
      setLibraryError(e instanceof Error ? e.message : String(e))
      setIsClearLibraryModalOpen(false)
    }
  }

  async function removeLibraryDoc(id: string) {
    setLibraryError('')
    try {
      const resp = await fetch(`/api/library/${encodeURIComponent(id)}`, { method: 'DELETE' })
      const json = await resp.json().catch(() => null)
      if (!resp.ok) throw new Error(json?.error ?? `Failed: ${resp.status}`)
      await refreshLibrary()
    } catch (e) {
      setLibraryError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    refreshLibrary().catch(() => {
      // Если библиотека ещё пуста или backend недоступен — просто оставим пустой список.
      setLibrary([])
    })
  }, [])

  useEffect(() => {
    fetchAutoMatchStatus().catch((e) => {
      setAutoMatchError(e instanceof Error ? e.message : String(e))
    })

    const id = window.setInterval(() => {
      fetchAutoMatchStatus().catch(() => undefined)
    }, 10000)

    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(SEND_EMAIL_NOTIFICATIONS_STORAGE_KEY, String(sendEmailNotifications))
    } catch {
      // Ignore storage errors (private mode/quota).
    }
  }, [sendEmailNotifications])

  useEffect(() => {
    try {
      window.localStorage.setItem(SEND_CRM_NOTIFICATIONS_STORAGE_KEY, String(sendCrmNotifications))
    } catch {
      // Ignore storage errors (private mode/quota).
    }
  }, [sendCrmNotifications])

  useEffect(() => {
    try {
      window.localStorage.setItem(MATCH_MIN_PERCENT_STORAGE_KEY, String(minMatchPercentThreshold))
    } catch {
      // Ignore storage errors (private mode/quota).
    }
  }, [minMatchPercentThreshold])

  useEffect(() => {
    try {
      window.localStorage.setItem(SELECTED_TENDER_KEY_IDS_STORAGE_KEY, JSON.stringify(selectedTenderKeyIds))
    } catch {
      // Ignore storage errors (private mode/quota).
    }
  }, [selectedTenderKeyIds])

  useEffect(() => {
    if (!isTenderKeyDropdownOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!tenderKeyDropdownRef.current) return
      const target = event.target as Node | null
      if (target && !tenderKeyDropdownRef.current.contains(target)) {
        setIsTenderKeyDropdownOpen(false)
      }
    }
    window.addEventListener('mousedown', onPointerDown)
    return () => window.removeEventListener('mousedown', onPointerDown)
  }, [isTenderKeyDropdownOpen])

  useEffect(() => {
    if (selectedTenderKeyIds.length > 0) return
    setTenderItems([])
    setTenderItemsError('')
    setTenderAttachments([])
    setTenderAttachmentsError('')
    setKonturItems([])
    setKonturSearchError('')
    setTenderModalStep('tenders')
    setIsTenderModalOpen(false)
    setSelectedTenderMeta(null)
  }, [selectedTenderKeyIds])

  async function onDropLibraryFiles(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (libraryOperationInProgressRef.current) return
    let files: Array<File & { webkitRelativePath?: string }> = []
    const items = Array.from(event.dataTransfer.items ?? [])
    if (items.length > 0) {
      const collected = await Promise.all(
        items.map(async (item) => {
          const asAny = item as any
          const entry = typeof asAny.webkitGetAsEntry === 'function' ? asAny.webkitGetAsEntry() : null
          if (entry) return await collectFilesFromDropEntry(entry)
          const f = item.getAsFile()
          return f ? [f as File & { webkitRelativePath?: string }] : []
        }),
      )
      files = collected.flat()
    }
    if (files.length === 0) {
      files = Array.from(event.dataTransfer.files ?? []) as Array<File & { webkitRelativePath?: string }>
    }
    if (files.length === 0) return
    await onAddToLibrary(files)
  }

  async function loadTendersByKey() {
    if (selectedTenderKeyIds.length === 0) return
    const cacheKey = [...selectedTenderKeyIds].sort().join('|')
    const cached = tenderLoadCacheRef.current.get(cacheKey)
    if (cached) {
      setIsTenderModalOpen(true)
      setIsTenderItemsLoading(false)
      setTenderItems(cached.tenderItems)
      setTenderItemsError(cached.tenderItemsError)
      setKonturItems(cached.konturItems)
      setKonturSearchError(cached.konturSearchError)
      setTenderAttachments([])
      setTenderAttachmentsError('')
      setTenderModalStep('tenders')
      setSelectedTenderMeta(null)
      return
    }

    let loadedTenderItems: TenderListItem[] = []
    let loadedTenderItemsError = ''
    let loadedKonturItems: KonturListItem[] = []
    let loadedKonturSearchError = ''
    setIsTenderModalOpen(true)
    setIsTenderItemsLoading(true)
    setTenderItemsError('')
    setTenderAttachments([])
    setTenderAttachmentsError('')
    setKonturItems([])
    setKonturSearchError('')
    setTenderModalStep('tenders')
    try {
      const tenderParams = new URLSearchParams()
      for (const keyId of selectedTenderKeyIds) tenderParams.append('key', keyId)
      const resp = await fetch(`/api/tender-tenders?${tenderParams.toString()}`)
      const json = await resp.json().catch(() => null)
      if (!resp.ok) throw new Error(json?.error ?? `Failed: ${resp.status}`)
      const raw = Array.isArray(json?.tenders) ? json.tenders : []
      const list: TenderListItem[] = raw
        .filter((x: any) => typeof x?._id === 'string' || typeof x?.orderName === 'string')
        .map((x: any) => ({ _id: String(x?._id ?? ''), orderName: String(x?.orderName ?? '') }))
      const details = await Promise.all(
        list.map(async (item) => {
          try {
            const dResp = await fetch(`/api/tenders/get?id=${encodeURIComponent(item._id)}`)
            const dJson = await dResp.json().catch(() => null)
            if (!dResp.ok) return item
            return {
              ...item,
              href: typeof dJson?.href === 'string' ? dJson.href : null,
              maxPrice:
                typeof dJson?.maxPrice === 'number'
                  ? dJson.maxPrice
                  : Number.isFinite(Number(dJson?.maxPrice))
                    ? Number(dJson.maxPrice)
                    : null,
              auctionNumber: typeof dJson?.auctionNumber === 'string' ? dJson.auctionNumber : null,
            }
          } catch {
            return item
          }
        }),
      )
      loadedTenderItems = details
      setTenderItems(details)
    } catch (e) {
      loadedTenderItems = []
      loadedTenderItemsError = e instanceof Error ? e.message : 'Не удалось загрузить элементы.'
      setTenderItems([])
      setTenderItemsError(loadedTenderItemsError)
    }

    // Kontur Zakupki external search (server-side proxy).
    try {
      const selectedKeys = tenderKeys.filter((k) => selectedTenderKeyIds.includes(k._id))
      const konturParams = new URLSearchParams({
        ...konturSearchDateRange(),
        Attachments: 'true',
      })
      const textSet = new Set<string>()
      const excludeSet = new Set<string>()
      for (const key of selectedKeys) {
        for (const t of key.Text ?? []) textSet.add(t)
        for (const e of key.Exclude ?? []) excludeSet.add(e)
      }
      for (const t of textSet) konturParams.append('Text', t)
      for (const e of excludeSet) konturParams.append('Exclude', e)
      if (selectedTenderKeyIds.length === 1) {
        konturParams.set('keyId', selectedTenderKeyIds[0])
      }
      const kResp = await fetch(`/api/kontur/search?${konturParams.toString()}`)
      const kJson = await kResp.json().catch(() => null)
      if (kResp.ok) {
        loadedKonturItems = parseKonturItems(kJson?.result ?? kJson)
        setKonturItems(loadedKonturItems)
      } else {
        loadedKonturItems = []
        loadedKonturSearchError = kJson?.error ?? `Kontur request failed: ${kResp.status}`
        setKonturSearchError(loadedKonturSearchError)
      }
    } catch (e) {
      loadedKonturItems = []
      loadedKonturSearchError = e instanceof Error ? e.message : String(e)
      setKonturSearchError(loadedKonturSearchError)
    } finally {
      tenderLoadCacheRef.current.set(cacheKey, {
        tenderItems: loadedTenderItems,
        tenderItemsError: loadedTenderItemsError,
        konturItems: loadedKonturItems,
        konturSearchError: loadedKonturSearchError,
      })
      setIsTenderItemsLoading(false)
    }
  }

  useEffect(() => {
    const run = async () => {
      try {
        setTenderKeysError('')
        const resp = await fetch('/api/tender-keys')
        const json = await resp.json().catch(() => null)
        if (!resp.ok) throw new Error(json?.error ?? `Failed: ${resp.status}`)
        const rawList = Array.isArray(json?.keys) ? json.keys : Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : []
        const list = Array.isArray(rawList)
          ? rawList
              .filter((x: any) => typeof x?._id === 'string' && typeof x?.name === 'string')
              .map((x: any) => ({
                _id: x._id as string,
                name: x.name as string,
                Text: Array.isArray(x?.Text) ? x.Text.map((v: unknown) => String(v)) : [],
                Exclude: Array.isArray(x?.Exclude) ? x.Exclude.map((v: unknown) => String(v)) : [],
              }))
          : []
        if (list.length === 0) {
          setTenderKeysError('Список ключей пуст или имеет неожиданный формат ответа.')
        }
        setTenderKeys(list)
        setSelectedTenderKeyIds((prev) => {
          if (prev.length === 0) return prev
          const validIds = new Set(list.map((item) => item._id))
          const next = prev.filter((id) => validIds.has(id))
          return next.length === prev.length ? prev : next
        })
      } catch (e) {
        setTenderKeysError(e instanceof Error ? e.message : 'Не удалось загрузить ключи.')
        setTenderKeys([])
      }
    }
    run()
  }, [])

  function toggleTenderKey(keyId: string, checked: boolean) {
    setSettingsSaveStatus('')
    setSettingsSaveError('')
    setSelectedTenderKeyIds((prev) => {
      if (checked) {
        return prev.includes(keyId) ? prev : [...prev, keyId]
      }
      return prev.filter((x) => x !== keyId)
    })
  }

  function fileIconByName(name: string): string {
    const n = String(name ?? '').toLowerCase()
    if (n.endsWith('.pdf')) return '📕'
    if (n.endsWith('.doc') || n.endsWith('.docx')) return '📘'
    if (n.endsWith('.xls') || n.endsWith('.xlsx')) return '📗'
    return '📄'
  }

  function formatPrice(value: number | null | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
    return new Intl.NumberFormat('ru-RU').format(value)
  }

  async function fetchAttachmentBlob(fileItem: TenderAttachmentItem): Promise<Blob> {
    const resp = await fetch(buildAttachmentUrl(fileItem))
    if (!resp.ok) {
      const json = await resp.json().catch(() => null)
      throw new Error(json?.error ?? `Failed: ${resp.status}`)
    }
    return await resp.blob()
  }

  async function expandZipAttachments(items: TenderAttachmentItem[]): Promise<TenderAttachmentItem[]> {
    const expanded: TenderAttachmentItem[] = []
    for (const item of items) {
      if (!looksLikeZip(item.realName)) {
        expanded.push(item)
        continue
      }

      try {
        const zipBlob = await fetchAttachmentBlob(item)
        const archive = await JSZip.loadAsync(zipBlob, {
          decodeFileName: decodeZipFileName,
        })
        const archiveKey = `${item.href}::${item.realName}`
        zipArchivesRef.current.set(archiveKey, archive)

        const innerFiles = Object.values(archive.files).filter((entry) => !entry.dir)
        if (innerFiles.length === 0) {
          expanded.push(item)
          continue
        }

        for (const entry of innerFiles) {
          expanded.push({
            href: item.href,
            source: item.source,
            realName: `${baseName(item.realName)} / ${baseName(entry.name)}`,
            zipArchiveKey: archiveKey,
            zipEntryPath: entry.name,
          })
        }
      } catch {
        // If zip expansion fails, keep original item so user can still open it.
        expanded.push(item)
      }
    }
    return expanded
  }

  async function openKonturPurchase(item: KonturListItem) {
    setIsTenderItemsLoading(true)
    setTenderAttachmentsError('')
    try {
      const resp = await fetch(`/api/kontur/purchases/get?id=${encodeURIComponent(item.id)}`)
      const json = await resp.json().catch(() => null)
      if (!resp.ok) throw new Error(json?.error ?? `Failed: ${resp.status}`)
      const detail = (json?.result ?? json) as Record<string, unknown>

      const attachments = konturAttachmentsFromPurchase(detail)
      const expandedAttachments = await expandZipAttachments(attachments)
      setTenderAttachments(expandedAttachments)
      setSelectedTenderMeta(konturMetaFromPurchase(item, detail))
      setTenderModalStep('attachments')
    } catch (e) {
      setTenderAttachments([])
      setTenderAttachmentsError(e instanceof Error ? e.message : 'Не удалось загрузить файлы.')
      setTenderModalStep('attachments')
    } finally {
      setIsTenderItemsLoading(false)
    }
  }

  async function openTenderAttachments(item: TenderListItem) {
    setIsTenderItemsLoading(true)
    setTenderAttachmentsError('')
    try {
      const resp = await fetch(`/api/tenders/get?id=${encodeURIComponent(item._id)}`)
      const json = await resp.json().catch(() => null)
      if (!resp.ok) throw new Error(json?.error ?? `Failed: ${resp.status}`)
      const raw = Array.isArray(json?.attachments) ? json.attachments : []
      const list = raw
        .filter((x: any) => typeof x?.href === 'string' || typeof x?.realName === 'string')
        .map((x: any) => ({ href: String(x?.href ?? ''), realName: String(x?.realName ?? '') }))
      const expandedAttachments = await expandZipAttachments(list)
      setTenderAttachments(expandedAttachments)
      const customersRaw = (json as any)?.customers ?? (json as any)?.data?.customers ?? null
      const customerGuid =
        Array.isArray(customersRaw) && customersRaw.length > 0
          ? String((customersRaw[0] as any)?.guid ?? '').trim()
          : customersRaw && typeof customersRaw === 'object'
            ? String((customersRaw as any)?.guid ?? '').trim()
            : ''
      let orgShortName: string | null = null
      let orgInn: string | null = null
      if (customerGuid) {
        try {
          const orgResp = await fetch(`/api/organizations/get?id=${encodeURIComponent(customerGuid)}`)
          const orgJson = await orgResp.json().catch(() => null)
          if (orgResp.ok) {
            orgShortName =
              typeof orgJson?.shortName === 'string'
                ? orgJson.shortName
                : typeof orgJson?.data?.shortName === 'string'
                  ? orgJson.data.shortName
                  : null
            orgInn =
              typeof orgJson?.inn === 'string'
                ? orgJson.inn
                : typeof orgJson?.data?.inn === 'string'
                  ? orgJson.data.inn
                  : null
          }
        } catch {
          // keep fallback values when organization fetch fails
        }
      }
      setSelectedTenderMeta({
        customerName:
          orgShortName ??
          (typeof json?.customerName === 'string'
            ? json.customerName
            : typeof json?.data?.customerName === 'string'
              ? json.data.customerName
              : null),
        customerInn:
          orgInn ??
          (typeof json?.customerInn === 'string'
            ? json.customerInn
            : typeof json?.data?.customerInn === 'string'
              ? json.data.customerInn
              : null),
        auctionNumber:
          typeof json?.auctionNumber === 'string'
            ? json.auctionNumber
            : typeof item?.auctionNumber === 'string'
              ? item.auctionNumber
              : null,
        maxPrice:
          typeof json?.maxPrice === 'number'
            ? json.maxPrice
            : Number.isFinite(Number(json?.maxPrice))
              ? Number(json.maxPrice)
              : typeof item?.maxPrice === 'number'
                ? item.maxPrice
                : null,
        sourceUrl:
          typeof json?.href === 'string'
            ? json.href
            : typeof item?.href === 'string'
              ? item.href
              : null,
      })
      setTenderModalStep('attachments')
    } catch (e) {
      setTenderAttachments([])
      setTenderAttachmentsError(e instanceof Error ? e.message : 'Не удалось загрузить файлы.')
      setTenderModalStep('attachments')
    } finally {
      setIsTenderItemsLoading(false)
    }
  }

  async function selectAttachmentAndMatch(fileItem: TenderAttachmentItem) {
    try {
      setMatchError('')
      setMatchStatus('Загружаю файл из аукционной документации...')
      setIsAttachmentLoading(true)
      let file: File
      if (fileItem.zipArchiveKey && fileItem.zipEntryPath) {
        const archive = zipArchivesRef.current.get(fileItem.zipArchiveKey)
        let entry = archive?.file(fileItem.zipEntryPath)
        if (!entry && archive) {
          // Fallback: sometimes entry names differ only by slash style/casing.
          const wanted = fileItem.zipEntryPath.replace(/\\/g, '/').toLowerCase()
          const alt = Object.keys(archive.files).find((k) => k.replace(/\\/g, '/').toLowerCase() === wanted)
          if (alt) entry = archive.file(alt)
        }
        if (!entry) throw new Error('Не удалось прочитать файл внутри ZIP-архива')
        const bytes = await entry.async('uint8array')
        const innerName = baseName(fileItem.zipEntryPath)
        const contentType = mimeByFilename(innerName)
        const blob = new Blob([Uint8Array.from(bytes)], { type: contentType })
        file = new File([blob], innerName, { type: contentType })
      } else {
        const blob = await fetchAttachmentBlob(fileItem)
        file = new File([blob], fileItem.realName || 'attachment', { type: blob.type || 'application/octet-stream' })
      }
      setSelectedRemoteFilename(file.name)
      setMatchStatus('')
      setIsTenderModalOpen(false)
      await onMatch(file, selectedTenderMeta)
    } catch (e) {
      setMatchStatus('')
      setMatchError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsAttachmentLoading(false)
    }
  }

  async function onAddToLibrary(filesInput: FileList | File[] | null) {
    setLibraryError('')
    const incoming = filesInput ? Array.from(filesInput) : []
    const files: File[] = []
    for (const f of incoming) {
      const check = shouldSkipLibraryFile(f)
      if (check.skip) {
        continue
      }
      files.push(f)
    }
    if (files.length === 0) {
      if (incoming.length > 0) {
        setLibraryError('Не найдено поддерживаемых файлов для индексации (pdf/doc/docx/xls/xlsx).')
      }
      return
    }
    libraryOperationInProgressRef.current = true
    setLibraryStatus(`Подготовка к индексации (${files.length})...`)
    try {
      await refreshLibrary().catch(() => undefined)
      let added = 0
      let skippedDuplicates = 0
      let skippedInvalidOffice = 0
      const failed: string[] = []
      let nextIndex = 0
      let finished = 0
      const total = files.length
      const workersCount = Math.min(4, Math.max(1, total))

      const runWorker = async () => {
        while (true) {
          const i = nextIndex++
          if (i >= total) return
          let file = files[i]
          const displayName = libraryDisplayName(file)
          try {
            const validOfficeContainer = await looksLikeValidOfficeContainer(file)
            if (!validOfficeContainer) {
              skippedInvalidOffice++
              continue
            }

            const normalizedName = normalizeLibraryFilename(file.name)
            if (normalizedName && normalizedName !== file.name) {
              file = new File([file], normalizedName, { type: file.type, lastModified: file.lastModified })
            }

            let uploaded = false
            let lastErr = ''
            const maxAttempts = 2
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              try {
                await uploadFile('/api/library/add', file)
                uploaded = true
                break
              } catch (e) {
                lastErr = e instanceof Error ? e.message : String(e)
                if (attempt >= maxAttempts || !isTransientLibraryUploadError(lastErr)) {
                  throw e
                }
                await new Promise((resolve) => setTimeout(resolve, 300 * attempt))
              }
            }
            if (!uploaded) {
              throw new Error(lastErr || 'Upload failed')
            }
            added++
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            const isDuplicate =
              message.toLowerCase().includes('уже есть в библиотеке') ||
              message.toLowerCase().includes('already exists') ||
              message.toLowerCase().includes('duplicate')
            if (isDuplicate) {
              skippedDuplicates++
            } else {
              failed.push(`${displayName}: ${message}`)
            }
          } finally {
            finished++
            setLibraryStatus(`Индексация ${finished}/${total}: ${displayName}`)
          }
        }
      }

      await Promise.all(Array.from({ length: workersCount }, () => runWorker()))

      setLibraryStatus('Готово. Обновляю список библиотеки...')
      await refreshLibrary()
      // Avoid confusion when newly added files are hidden by stale search filter.
      if (librarySearchQuery.trim().length > 0) {
        setLibrarySearchQuery('')
      }
      const summaryParts = [`Добавлено: ${added}`]
      if (skippedDuplicates > 0) summaryParts.push(`пропущено дубликатов: ${skippedDuplicates}`)
      if (skippedInvalidOffice > 0) summaryParts.push(`пропущено поврежденных office: ${skippedInvalidOffice}`)
      if (failed.length > 0) summaryParts.push(`ошибок: ${failed.length}`)
      setLibraryStatus(summaryParts.join(' • '))
      if (failed.length > 0) {
        setLibraryError(failed.slice(0, 2).join(' | ') + (failed.length > 2 ? ` (+${failed.length - 2} еще)` : ''))
      }
    } catch (e) {
      setLibraryStatus('')
      setLibraryError(e instanceof Error ? e.message : String(e))
    } finally {
      libraryOperationInProgressRef.current = false
      if (libraryFileInputRef.current) libraryFileInputRef.current.value = ''
    }
  }

  async function onMatch(file: File | null, tenderMeta?: TenderMetaForMatch | null) {
    if (libraryOperationInProgressRef.current) return
    setMatchError('')
    if (!file) return
    setMatchStatus('Идёт поиск...')
    setMatches([])
    setRowResults([])
    setDecision('')
    setMatchPercent(null)
    setMatchedCount(null)
    setBestMatchFilename(null)
    setLlmExplanation(null)
    setAnalyzerInfo(null)
    setEmailNotification(null)
    setCrmNotification(null)
    try {
      // Обновляем библиотеку перед матчингом, чтобы не зависеть от устаревшего состояния.
      await refreshLibrary().catch(() => undefined)
      if (library.length === 0) {
        setMatchStatus('')
        setMatchError('Библиотека пустая. Сначала добавьте техописания поставщика.')
        return
      }
      const extraFields: Record<string, string> = {}
      const src = tenderMeta ?? selectedTenderMeta
      if (src?.auctionNumber) extraFields.auctionNumber = src.auctionNumber
      if (src?.customerName) extraFields.customerName = src.customerName
      if (src?.customerInn) extraFields.customerInn = src.customerInn
      if (typeof src?.maxPrice === 'number' && Number.isFinite(src.maxPrice)) {
        extraFields.auctionPrice = String(src.maxPrice)
      }
      if (src?.sourceUrl) extraFields.sourceUrl = src.sourceUrl
      extraFields.sendEmail = sendEmailNotifications ? 'true' : 'false'
      extraFields.sendCrm = sendCrmNotifications ? 'true' : 'false'
      extraFields.minMatchPercentForCompliance = String(minMatchPercentThreshold)
      const targetEmail = notificationEmail.trim()
      if (targetEmail.length > 0) extraFields.notifyEmail = targetEmail
      const json = await uploadFile('/api/match', file, Object.keys(extraFields).length > 0 ? extraFields : undefined)
      setDecision(json.decision ?? '')
      setMatchPercent(typeof json.matchPercent === 'number' ? json.matchPercent : null)
      setMatches(json.matches ?? [])
      setMinCriteriaIfNameMatched(
        typeof json.minCriteriaIfNameMatched === 'number' ? json.minCriteriaIfNameMatched : 2,
      )
      setMatchedCount(typeof json.matchedCount === 'number' ? json.matchedCount : null)
      setBestMatchFilename(typeof json.bestMatchFilename === 'string' ? json.bestMatchFilename : null)
      setRowResults(Array.isArray(json.rowResults) ? json.rowResults : [])
      setLlmExplanation(typeof json.llmExplanation === 'string' ? json.llmExplanation : null)
      setAnalyzerInfo(
        json?.analyzerInfo && typeof json.analyzerInfo === 'object'
          ? {
              hasAnalyzer: Boolean((json.analyzerInfo as any).hasAnalyzer),
              analyzers: Array.isArray((json.analyzerInfo as any).analyzers)
                ? (json.analyzerInfo as any).analyzers
                    .filter((x: any) => typeof x === 'string')
                    .map((x: string) => x.trim())
                    .filter((x: string) => x.length > 0)
                : [],
            }
          : null,
      )
      setEmailNotification(
        json?.emailNotification && typeof json.emailNotification === 'object'
          ? {
              sent: Boolean((json.emailNotification as any).sent),
              reason:
                typeof (json.emailNotification as any).reason === 'string'
                  ? (json.emailNotification as any).reason
                  : undefined,
            }
          : null,
      )
      setCrmNotification(
        json?.crmNotification && typeof json.crmNotification === 'object'
          ? {
              sent: Boolean((json.crmNotification as any).sent),
              reason:
                typeof (json.crmNotification as any).reason === 'string'
                  ? (json.crmNotification as any).reason
                  : undefined,
            }
          : null,
      )
      setMatchStatus('')
    } catch (e) {
      setMatchStatus('')
      setMatchError(e instanceof Error ? e.message : String(e))
    } finally {
      if (matchFileInputRef.current) matchFileInputRef.current.value = ''
    }
  }

  return (
    <main className="ms-app">
      <h1 className="ms-title">Подбор теххарактеристик по загруженному файлу</h1>

      <section className="ms-section">
        <h2 className="ms-section-title">1. Добавить в библиотеку (техописания)</h2>
        <div className="ms-field">
          <label className="ms-label" htmlFor="library-upload-input">
            Выбрать файлы
          </label>
          <div className="ms-inline-row ms-inline-row--wrap">
            <button
              type="button"
              className="ms-btn"
              onClick={() => libraryFileInputRef.current?.click()}
            >
              Выбрать файлы
            </button>
          </div>
          <input
            ref={libraryFileInputRef}
            id="library-upload-input"
            type="file"
            accept=".pdf,.doc,.docx,.xlsx,.xls"
            multiple
            onChange={(e) => {
              void onAddToLibrary(e.target.files)
            }}
            style={{ display: 'none' }}
          />
          <div
            className="ms-muted"
            onDragOver={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onDrop={(e) => {
              void onDropLibraryFiles(e)
            }}
            style={{
              marginTop: 6,
              padding: '8px 10px',
              border: '1px dashed #c7d3e3',
              borderRadius: 8,
              background: '#f8fbff',
            }}
          >
            Можно перетащить сюда папку или файлы из Проводника
          </div>
        </div>
        {libraryStatus ? <p className="ms-status">{libraryStatus}</p> : null}
        {libraryError ? <p className="ms-error">Ошибка: {libraryError}</p> : null}
      </section>

      <section className="ms-section">
        <h2 className="ms-section-title">2. Загрузить описание товара</h2>
        <div className="ms-field">
          <label className="ms-label">
            Ключи
          </label>
          {tenderKeys.length === 0 ? (
            <p className="ms-muted">{tenderKeysError || 'Ключи не загружены'}</p>
          ) : (
            <div className="ms-key-select-wrap" ref={tenderKeyDropdownRef}>
              <button
                type="button"
                className="ms-select ms-select--trigger"
                onClick={() => setIsTenderKeyDropdownOpen((prev) => !prev)}
                aria-haspopup="listbox"
                aria-expanded={isTenderKeyDropdownOpen}
              >
                {selectedTenderKeyIds.length === 0
                  ? 'Выберите ключ'
                  : `Выбрано ключей: ${selectedTenderKeyIds.length}`}
              </button>
              {isTenderKeyDropdownOpen ? (
                <div className="ms-checkbox-list" role="listbox" aria-label="Ключи">
                  {tenderKeys.map((k) => (
                    <label key={k._id} className="ms-checkbox-item">
                      <input
                        type="checkbox"
                        checked={selectedTenderKeyIds.includes(k._id)}
                        onChange={(e) => toggleTenderKey(k._id, e.target.checked)}
                      />
                      <span>{k.name}</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>
        <div className="ms-field">
          <label className="ms-label" htmlFor="match-percent-threshold">
            Порог соответствия: {minMatchPercentThreshold}%
          </label>
          <input
            id="match-percent-threshold"
            type="range"
            min={0}
            max={100}
            step={1}
            value={minMatchPercentThreshold}
            onChange={(e) => {
              setMinMatchPercentThreshold(Number(e.target.value))
              setSettingsSaveStatus('')
              setSettingsSaveError('')
            }}
            className="ms-range"
            style={{ '--ms-range-progress': `${minMatchPercentThreshold}%` } as CSSProperties}
          />
          <p className="ms-muted">
            Итоговое решение «соответствует/не соответствует» будет рассчитываться по этому порогу.
          </p>
        </div>
        <div className="ms-field">
          <label className="ms-label" htmlFor="notification-email">
            Email для отправки
          </label>
          <div className="ms-inline-row">
            <input
              id="notification-email"
              type="email"
              className="ms-input"
              placeholder="name@example.com"
              value={notificationEmailDraft}
              onChange={(e) => {
                setNotificationEmailDraft(e.target.value)
                if (notificationEmailApplyError) setNotificationEmailApplyError('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  applyNotificationEmail()
                }
              }}
              disabled={!sendEmailNotifications}
            />
            <button
              type="button"
              className="ms-btn"
              onClick={applyNotificationEmail}
            >
              Применить почту
            </button>
            <label className="ms-switch" aria-label="Отправить на почту">
              <input
                type="checkbox"
                checked={sendEmailNotifications}
                onChange={(e) => {
                  const next = e.target.checked
                  setSendEmailNotifications(next)
                  setSettingsSaveStatus('')
                  setSettingsSaveError('')
                  if (next) openNotificationSettingsModal('email')
                }}
              />
              <span className="ms-switch-slider" aria-hidden="true" />
              <span className="ms-switch-label">Отправить на почту</span>
            </label>
            <label className="ms-switch" aria-label="Отправить в CRM">
              <input
                type="checkbox"
                checked={sendCrmNotifications}
                onChange={(e) => {
                  const next = e.target.checked
                  setSendCrmNotifications(next)
                  setSettingsSaveStatus('')
                  setSettingsSaveError('')
                  if (next) openNotificationSettingsModal('crm')
                }}
              />
              <span className="ms-switch-slider" aria-hidden="true" />
              <span className="ms-switch-label">Отправить в CRM</span>
            </label>
          </div>
          {notificationEmailApplyError ? (
            <p className="ms-error">{notificationEmailApplyError}</p>
          ) : null}
          <p className="ms-muted">
            Текущая почта для отправки:{' '}
            {notificationEmail.trim().length > 0 ? notificationEmail : 'не указана (используется почта по умолчанию)'}
          </p>
        </div>
        <button
          type="button"
          className="ms-btn"
          onClick={saveTenderSettings}
        >
          Сохранить настройки
        </button>
        {settingsSaveStatus ? <p className="ms-status">{settingsSaveStatus}</p> : null}
        {settingsSaveError ? <p className="ms-error">Ошибка: {settingsSaveError}</p> : null}
        <button
          type="button"
          className="ms-btn"
          onClick={() => void loadTendersByKey()}
          disabled={selectedTenderKeyIds.length === 0}
        >
          Показать элементы по ключам
        </button>
        <input
          ref={matchFileInputRef}
          id="match-file-input"
          type="file"
          accept=".pdf,.doc,.docx,.xlsx,.xls"
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null
            void onMatch(file)
          }}
        />
        {selectedRemoteFilename ? <p className="ms-muted">Выбран файл из аукционной документации: {selectedRemoteFilename}</p> : null}

        {matchStatus ? <p className="ms-status">{matchStatus}</p> : null}
        {matchError ? (
          <p className="ms-error">Ошибка: {matchError}</p>
        ) : null}

        {decision ? (
          <p className={`ms-result ${isMatchByPoints ? 'ms-result--ok' : 'ms-result--bad'}`}>
            Итог: {isMatchByPoints ? 'соответствует' : 'не соответствует'}
            {matchPercent != null ? ` • соответствие=${matchPercent.toFixed(1)}%` : ''}
            {bestMatchFilename ? ` • файл: ${bestMatchFilename}` : ''}
          </p>
        ) : null}

        {llmExplanation ? (
          <div className="ms-llm">
            <div className="ms-llm-title">Объяснение нейросети</div>
            <div className="ms-llm-text">{llmExplanation}</div>
          </div>
        ) : null}
        {analyzerInfo?.hasAnalyzer ? (
          <div className="ms-llm">
            <div className="ms-llm-title">Что для анализатора</div>
            <div className="ms-llm-text">
              {analyzerInfo.analyzers.length > 0
                ? `Да: ${analyzerInfo.analyzers.join(', ')}`
                : 'Да: указан признак "для анализатора".'}
            </div>
          </div>
        ) : null}
        {emailNotification ? (
          <div className="ms-llm">
            <div className="ms-llm-title">Отправка email</div>
            <div className="ms-llm-text">
              {emailNotification.sent
                ? 'Письмо отправлено.'
                : `Письмо не отправлено${emailNotification.reason ? `: ${emailNotification.reason}` : '.'}`}
            </div>
          </div>
        ) : null}
        {crmNotification ? (
          <div className="ms-llm">
            <div className="ms-llm-title">Отправка в CRM</div>
            <div className="ms-llm-text">
              {crmNotification.sent
                ? 'Отправлено в CRM.'
                : `В CRM не отправлено${crmNotification.reason ? `: ${crmNotification.reason}` : '.'}`}
            </div>
          </div>
        ) : null}

        {decision === 'match' && matches.length > 0 ? (
          <div className="ms-block">
            <h3 className="ms-subtitle">Топ совпадений</h3>
            <div className="ms-grid ms-grid--matches">
              {matches.map((m) => (
                <div key={m.id} className="ms-card ms-card--match">
                  <div className="ms-card-head">
                    <div>
                      <div className="ms-card-title">{m.originalFilename}</div>
                      <div className="ms-meta">{m.extension.toUpperCase()}</div>
                    </div>
                    <div className="ms-score">score {m.score.toFixed(4)}</div>
                  </div>
                  <div className="ms-path" title={m.storedPath}>
                    {m.storedPath}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : decision ? (
          <p className="ms-muted">Совпадения не найдены по текущему порогу.</p>
        ) : null}

        {decision && rowResults.length > 0 ? (
          <div className="ms-block">
            <h3 className="ms-subtitle">Проверка строк (первые {Math.min(20, rowResults.length)})</h3>
            <div className="ms-grid">
              {rowResults.slice(0, 20).map((r, idx) => (
                <div key={`${r.indicator}-${idx}`} className={`ms-card ${r.rowMatched ? 'ms-card--ok' : 'ms-card--bad'}`}>
                  <div className="ms-card-head">
                    <div className="ms-indicator">{r.indicator}</div>
                    <div className={`ms-pill ${r.rowMatched ? 'ms-pill--ok' : 'ms-pill--bad'}`}>
                      {r.rowMatched ? 'OK' : 'NO'}
                    </div>
                  </div>
                  <div className="ms-line">товар: {r.queryValueRaw}</div>
                  <div className="ms-line">
                    библиотека: {r.matchedLibraryIndicator ?? '-'} ={' '}
                    <span style={{ fontWeight: 700 }}>{r.matchedLibraryValueRaw ?? '-'}</span>
                  </div>
                  <div className="ms-line-meta">
                    sim {r.indicatorSimilarity.toFixed(3)} •{' '}
                    {r.valueMatch ? (
                      <span className="ms-ok">значение OK</span>
                    ) : (
                      <span className="ms-bad">значение NO ({r.valueReason})</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="ms-section">
        <h2 className="ms-section-title">3. Автосопоставление</h2>
        <div className="ms-field">
          <label className="ms-label" htmlFor="auto-match-interval">
            Интервал запуска
          </label>
          <select
            id="auto-match-interval"
            className="ms-select"
            value={autoMatchIntervalDraft}
            onChange={(e) => setAutoMatchIntervalDraft(e.target.value as AutoMatchIntervalCode)}
            disabled={autoMatchBusy || autoMatchStatus?.running}
          >
            {AUTO_MATCH_INTERVAL_OPTIONS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="ms-inline-row">
          <button
            type="button"
            className="ms-btn"
            onClick={() => void onAutoMatchStart()}
            disabled={autoMatchBusy || Boolean(autoMatchStatus?.enabled)}
          >
            Включить
          </button>
          <button
            type="button"
            className="ms-btn"
            onClick={() => void onAutoMatchStop()}
            disabled={autoMatchBusy || !autoMatchStatus?.enabled}
          >
            Выключить
          </button>
          <button
            type="button"
            className="ms-btn"
            onClick={() => void onAutoMatchRunOnce()}
            disabled={autoMatchBusy || Boolean(autoMatchStatus?.running)}
          >
            Запустить сейчас
          </button>
          <button
            type="button"
            className="ms-btn"
            onClick={() => setIsAutoMatchLogsModalOpen(true)}
            disabled={autoMatchHistoryForLogs.length === 0}
          >
            Логи
          </button>
        </div>
        {autoMatchError ? <p className="ms-error">Ошибка: {autoMatchError}</p> : null}
        {autoMatchStatus ? (
          <div className="ms-llm">
            <div className="ms-llm-title">Статус</div>
            <div className="ms-llm-text">
              {autoMatchStatus.enabled ? 'Включено' : 'Выключено'} • Интервал: {autoMatchStatus.interval} •{' '}
              {autoMatchStatus.running ? 'идет запуск' : 'ожидание'}
            </div>
            <div className="ms-llm-text">
              Обработано: {autoMatchStatus.stats.processed} • match: {autoMatchStatus.stats.matched} • no match:{' '}
              {autoMatchStatus.stats.noMatch} • пропущено: {autoMatchStatus.stats.skipped} • ошибок:{' '}
              {autoMatchStatus.stats.errors}
            </div>
            <div className="ms-llm-text">
              Последний старт: {autoMatchStatus.lastRunAt ? new Date(autoMatchStatus.lastRunAt).toLocaleString() : '—'}{' '}
              • Последнее завершение:{' '}
              {autoMatchStatus.lastRunFinishedAt ? new Date(autoMatchStatus.lastRunFinishedAt).toLocaleString() : '—'}
            </div>
            {autoMatchStatus.running && autoMatchStatus.currentItem ? (
              <div className="ms-llm-text">
                Текущий этап: {autoMatchStatus.currentItem.stage}
                {autoMatchStatus.currentItem.keyId ? ` • key: ${autoMatchStatus.currentItem.keyId}` : ''}
                {autoMatchStatus.currentItem.tenderId ? ` • tender: ${autoMatchStatus.currentItem.tenderId}` : ''}
                {autoMatchStatus.currentItem.attachmentName
                  ? ` • файл: ${autoMatchStatus.currentItem.attachmentName}`
                  : ''}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="ms-muted">Статус автосопоставления загружается...</p>
        )}
        {autoMatchVisibleHistory.length ? (
          <div className="ms-block">
            <h3 className="ms-subtitle">Последние результаты</h3>
            <div className="ms-grid ms-grid--library">
              {autoMatchVisibleHistory
                .slice()
                .reverse()
                .slice(0, 20)
                .map((item, idx) => (
                  <div key={`${item.timestamp}-${item.tenderId}-${idx}`} className="ms-card ms-card--lib">
                    <div className="ms-card-head">
                      <div>
                        <div className="ms-card-title">{item.attachmentName || 'Вложение'}</div>
                        <div className="ms-meta">
                          {new Date(item.timestamp).toLocaleString()} • key: {item.keyId || '—'} • tender:{' '}
                          {item.tenderId || '—'}
                        </div>
                      </div>
                      <div className="ms-id">{item.status}</div>
                    </div>
                    <div className="ms-path">
                      {typeof item.matchPercent === 'number' ? `match=${item.matchPercent.toFixed(1)}%` : ''}
                      {item.bestMatchFilename ? ` • ${item.bestMatchFilename}` : ''}
                      {item.message ? ` • ${item.message}` : ''}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="ms-section">
        <h2 className="ms-section-title">Библиотека</h2>
        {library.length === 0 && libraryFolders.length === 0 ? (
          <p className="ms-muted">Пока нет проиндексированных файлов.</p>
        ) : (
          <>
            <div className="ms-toolbar">
              <input
                type="text"
                className="ms-input ms-library-search"
                placeholder="Поиск по названию файла"
                value={librarySearchQuery}
                onChange={(e) => setLibrarySearchQuery(e.target.value)}
              />
              <div className="ms-inline-row">
                {currentLibraryFolderId ? (
                  <button
                    type="button"
                    className="ms-btn"
                    onClick={() => setCurrentLibraryFolderId(null)}
                  >
                    ← В корень
                  </button>
                ) : null}
                <input
                  type="text"
                  className="ms-input ms-folder-name-input"
                  placeholder="Новая папка"
                  value={newLibraryFolderName}
                  onChange={(e) => setNewLibraryFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void createLibraryFolder()
                    }
                  }}
                />
                <button
                  type="button"
                  className="ms-btn"
                  onClick={() => void createLibraryFolder()}
                  disabled={newLibraryFolderName.trim().length === 0}
                >
                  Создать папку
                </button>
              </div>
              <button
                type="button"
                onClick={() => setIsClearLibraryModalOpen(true)}
                className="ms-btn ms-btn--danger"
              >
                Очистить библиотеку
              </button>
            </div>
            {currentLibraryFolder ? (
              <p className="ms-muted">
                Открыта папка: <strong>{currentLibraryFolder.name}</strong>
              </p>
            ) : null}
            {normalizedLibrarySearchQuery.length > 0 && filteredLibrary.length < library.length ? (
              <p className="ms-muted">
                Поиск активен: скрыто файлов {visibleLibraryDocs.length - filteredLibrary.length}. Очистите поиск, чтобы увидеть все.
              </p>
            ) : null}
            {currentLibraryFolderId ? (
              <div
                className="ms-dropzone"
                onDragOver={(e) => {
                  e.preventDefault()
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const docId = readDraggedLibraryDocId(e)
                  if (docId) void moveLibraryDoc(docId, null)
                }}
              >
                Перетащите сюда файл, чтобы вернуть в корень
              </div>
            ) : null}
            {visibleLibraryFolders.length > 0 ? (
              <div className="ms-grid ms-grid--library">
                {visibleLibraryFolders.map((folder) => (
                  <div
                    key={folder.id}
                    className={`ms-card ms-card--folder ${movingLibraryDocId ? 'ms-card--folder-target' : ''}`}
                    onClick={() => setCurrentLibraryFolderId(folder.id)}
                    onDragOver={(e) => {
                      e.preventDefault()
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      const docId = readDraggedLibraryDocId(e)
                      if (docId) void moveLibraryDoc(docId, folder.id)
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setCurrentLibraryFolderId(folder.id)
                      }
                    }}
                  >
                    <div className="ms-card-title">📁 {folder.name}</div>
                    <div className="ms-meta">{new Date(folder.createdAt).toLocaleString()}</div>
                  </div>
                ))}
              </div>
            ) : null}
            {filteredLibrary.length === 0 ? (
              <p className="ms-muted">По вашему запросу файлы не найдены.</p>
            ) : (
              <div className="ms-grid ms-grid--library">
                {filteredLibrary.map((d) => (
                  <div
                    key={d.id}
                    className="ms-card ms-card--lib"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/library-doc-id', d.id)
                      e.dataTransfer.setData('text/plain', `library-doc-id:${d.id}`)
                      e.dataTransfer.effectAllowed = 'move'
                      setMovingLibraryDocId(d.id)
                    }}
                    onDragEnd={() => setMovingLibraryDocId(null)}
                  >
                    <div className="ms-card-actions">
                      <button
                        type="button"
                        className="ms-card-move"
                        onClick={() => void moveLibraryDoc(d.id, null)}
                        title="Переместить в корень"
                      >
                        ↥
                      </button>
                      <button
                        type="button"
                        className="ms-card-delete"
                        aria-label={`Удалить ${d.originalFilename}`}
                        onClick={() => removeLibraryDoc(d.id)}
                        title="Удалить из библиотеки"
                      >
                        ×
                      </button>
                    </div>
                    <div className="ms-card-head">
                      <div>
                        <div className="ms-card-title">{d.originalFilename}</div>
                        <div className="ms-meta">
                          {d.extension.toUpperCase()} • {new Date(d.indexedAt).toLocaleString()}
                        </div>
                      </div>
                      <div className="ms-id">id: {d.id.slice(0, 8)}…</div>
                    </div>
                    <div className="ms-path" title={d.storedPath}>
                      {d.storedPath}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>
      {isTenderModalOpen ? (
        <div className="ms-modal-overlay" onClick={() => setIsTenderModalOpen(false)}>
          <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ms-modal-head">
              <h3 className="ms-modal-title">
                {tenderModalStep === 'attachments' ? 'Аукционная документация' : 'Выберите подходящий элемент'}
              </h3>
              <button type="button" className="ms-modal-close" onClick={() => setIsTenderModalOpen(false)} aria-label="Закрыть">
                ×
              </button>
            </div>
            {tenderModalStep === 'attachments' ? (
              <button type="button" className="ms-btn" onClick={() => setTenderModalStep('tenders')}>
                Назад к элементам
              </button>
            ) : null}
            {isTenderItemsLoading || isAttachmentLoading ? <p className="ms-muted">Загрузка...</p> : null}
            {tenderModalStep === 'tenders' && !isTenderItemsLoading && tenderItemsError ? <p className="ms-error">Ошибка: {tenderItemsError}</p> : null}
            {tenderModalStep === 'tenders' && !isTenderItemsLoading && konturSearchError ? (
              <p className="ms-error">Kontur ошибка: {konturSearchError}</p>
            ) : null}
            {tenderModalStep === 'tenders' && !isTenderItemsLoading && konturItems.length > 0 ? (
              <div className="ms-grid ms-grid--tenders">
                {konturItems.map((item) => (
                  <button
                    type="button"
                    key={`kontur-${item.id}-${item.orderName}`}
                    className="ms-card ms-card--tender ms-card--kontur ms-card-button"
                    onClick={() => openKonturPurchase(item)}
                  >
                    <div className="ms-card-title">{item.orderName || 'Без названия'}</div>
                    <div className="ms-line">НМЦК: {formatPrice(item.maxPrice)} ₽</div>
                    {item.link ? (
                      <a
                        href={item.link}
                        target="_blank"
                        rel="noreferrer"
                        className="ms-link"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Перейти по ссылке
                      </a>
                    ) : null}
                    <div className="ms-meta">{item.id || 'Без id'}</div>
                  </button>
                ))}
              </div>
            ) : null}
            {tenderModalStep === 'tenders' &&
            !isTenderItemsLoading &&
            !tenderItemsError &&
            tenderItems.length === 0 &&
            konturItems.length === 0 ? (
              <p className="ms-muted">Элементы не найдены.</p>
            ) : null}
            {tenderModalStep === 'tenders' && !isTenderItemsLoading && tenderItems.length > 0 ? (
              <div className="ms-grid ms-grid--tenders">
                {tenderItems.map((item) => (
                  <button
                    type="button"
                    className="ms-card ms-card--tender ms-card-button"
                    key={`${item._id}-${item.orderName}`}
                    onClick={() => openTenderAttachments(item)}
                  >
                    <div className="ms-card-title">{item.orderName || 'Без названия'}</div>
                    <div className="ms-line">НМЦК: {formatPrice(item.maxPrice)} ₽</div>
                    {item.href ? (
                      <a
                        href={item.href}
                        target="_blank"
                        rel="noreferrer"
                        className="ms-link"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Перейти по ссылке
                      </a>
                    ) : null}
                    <div className="ms-meta">{item._id || 'Без _id'}</div>
                  </button>
                ))}
              </div>
            ) : null}
            {tenderModalStep === 'attachments' && !isTenderItemsLoading && tenderAttachmentsError ? (
              <p className="ms-error">Ошибка: {tenderAttachmentsError}</p>
            ) : null}
            {tenderModalStep === 'attachments' && !isTenderItemsLoading && !tenderAttachmentsError && tenderAttachments.length === 0 ? (
              <p className="ms-muted">Файлы не найдены.</p>
            ) : null}
            {tenderModalStep === 'attachments' && !isTenderItemsLoading && tenderAttachments.length > 0 ? (
              <div className="ms-grid ms-grid--tenders">
                {tenderAttachments.map((item) => (
                  <button
                    type="button"
                    className="ms-card ms-card--tender ms-card-button"
                    key={`${item.href}-${item.realName}`}
                    onClick={() => selectAttachmentAndMatch(item)}
                  >
                    <div className="ms-card-title">
                      {fileIconByName(item.realName)} {item.realName || 'Без названия'}
                    </div>
                    <div className="ms-meta">{item.href}</div>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {isAutoMatchLogsModalOpen ? (
        <div className="ms-modal-overlay" onClick={() => setIsAutoMatchLogsModalOpen(false)}>
          <div
            className="ms-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="auto-match-logs-title"
          >
            <div className="ms-modal-head">
              <h3 className="ms-modal-title" id="auto-match-logs-title">
                Логи автосопоставления
              </h3>
              <button
                type="button"
                className="ms-modal-close"
                onClick={() => setIsAutoMatchLogsModalOpen(false)}
                aria-label="Закрыть"
              >
                ×
              </button>
            </div>

            <div className="ms-log-section">
              <div className="ms-log-section-title">Сопоставлены ({autoMatchMatchedLogs.length})</div>
              {autoMatchMatchedLogs.length === 0 ? (
                <p className="ms-muted">Нет успешных сопоставлений.</p>
              ) : (
                <div className="ms-grid ms-grid--library">
                  {autoMatchMatchedLogs.slice(0, 50).map((item, idx) => (
                    <div key={`log-matched-${item.timestamp}-${idx}`} className="ms-card ms-card--ok">
                      <div className="ms-card-title">{item.attachmentName || 'Вложение'}</div>
                      <div className="ms-line">
                        Совпало с: <strong>{item.bestMatchFilename || 'не указан файл библиотеки'}</strong>
                      </div>
                      <div className="ms-meta">
                        {typeof item.matchPercent === 'number' ? `match=${item.matchPercent.toFixed(1)}%` : 'match=—'} •{' '}
                        {new Date(item.timestamp).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="ms-log-section">
              <div className="ms-log-section-title">Ошибки ({autoMatchErrorLogs.length})</div>
              {autoMatchErrorLogs.length === 0 ? (
                <p className="ms-muted">Ошибок нет.</p>
              ) : (
                <div className="ms-grid ms-grid--library">
                  {autoMatchErrorLogs.slice(0, 50).map((item, idx) => (
                    <div key={`log-error-${item.timestamp}-${idx}`} className="ms-card ms-card--bad">
                      <div className="ms-card-title">{item.attachmentName || 'Вложение'}</div>
                      <div className="ms-line">Ошибка: {item.message || 'без описания'}</div>
                      <div className="ms-meta">{new Date(item.timestamp).toLocaleString()}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="ms-log-section">
              <div className="ms-log-section-title">Пропущены ({autoMatchSkippedLogs.length})</div>
              {autoMatchSkippedLogs.length === 0 ? (
                <p className="ms-muted">Пропущенных файлов нет.</p>
              ) : (
                <div className="ms-grid ms-grid--library">
                  {autoMatchSkippedLogs.slice(0, 50).map((item, idx) => (
                    <div key={`log-skipped-${item.timestamp}-${idx}`} className="ms-card">
                      <div className="ms-card-title">{item.attachmentName || 'Вложение'}</div>
                      <div className="ms-line">Причина: {item.message || 'без причины'}</div>
                      <div className="ms-meta">{new Date(item.timestamp).toLocaleString()}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {isClearLibraryModalOpen ? (
        <div className="ms-modal-overlay" onClick={() => setIsClearLibraryModalOpen(false)}>
          <div className="ms-modal ms-modal--confirm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="clear-library-title">
            <div className="ms-modal-head">
              <h3 className="ms-modal-title" id="clear-library-title">
                Подтвердите действие
              </h3>
              <button
                type="button"
                className="ms-modal-close"
                onClick={() => setIsClearLibraryModalOpen(false)}
                aria-label="Закрыть"
              >
                ×
              </button>
            </div>
            <p className="ms-modal-text">
              Удалить все файлы из библиотеки? Это действие нельзя отменить.
            </p>
            <div className="ms-modal-actions">
              <button type="button" className="ms-btn" onClick={() => setIsClearLibraryModalOpen(false)}>
                Отмена
              </button>
              <button
                type="button"
                className="ms-btn ms-btn--danger"
                onClick={() => void clearLibrary()}
                disabled={libraryStatus === 'Очищаю библиотеку...'}
              >
                {libraryStatus === 'Очищаю библиотеку...' ? 'Очищаю...' : 'Очистить библиотеку'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {isNotificationSettingsModalOpen ? (
        <div className="ms-modal-overlay" onClick={() => setIsNotificationSettingsModalOpen(false)}>
          <div className="ms-modal ms-modal--confirm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="ms-modal-head">
              <h3 className="ms-modal-title">Настройки отправки применены</h3>
              <button
                type="button"
                className="ms-modal-close"
                onClick={() => setIsNotificationSettingsModalOpen(false)}
                aria-label="Закрыть"
              >
                ×
              </button>
            </div>
            <p className="ms-modal-text">{notificationSettingsModalText}</p>
            <div className="ms-modal-actions">
              <button type="button" className="ms-btn" onClick={() => setIsNotificationSettingsModalOpen(false)}>
                Понятно
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}


import { useEffect, useState } from 'react'

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
  indexedAt: string
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
  source?: 'tenderplan' | 'bicotender' | 'kontur'
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

type BicotenderListItem = {
  id: string
  name: string
  cost: number | null
}

function parseBicotenderItems(raw: unknown): BicotenderListItem[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.values(raw as Record<string, unknown>).map((x: any, idx: number) => ({
    id: String(x?.tender_id ?? idx),
    name: String(x?.name ?? ''),
    cost: Number.isFinite(Number(x?.cost)) ? Number(x?.cost) : null,
  }))
}

function bicotenderAttachmentsFromDetail(detail: Record<string, unknown>): TenderAttachmentItem[] {
  const filesRaw = detail.files && typeof detail.files === 'object' ? detail.files : {}
  return Object.values(filesRaw as Record<string, unknown>)
    .filter((x: any) => typeof x?.sourceUrl === 'string' && String(x.sourceUrl).trim().length > 0)
    .map((x: any) => ({
      href: String(x.sourceUrl),
      realName: String(x?.name ?? ''),
      source: 'bicotender' as const,
    }))
}

function bicotenderMetaFromDetail(item: BicotenderListItem, detail: Record<string, unknown>): TenderMetaForMatch {
  const company = detail.company && typeof detail.company === 'object' ? detail.company : null
  return {
    customerName: company && typeof (company as any).name === 'string' ? String((company as any).name) : null,
    customerInn: company && typeof (company as any).inn === 'string' ? String((company as any).inn) : null,
    auctionNumber: typeof detail.srcNoticeNumber === 'string' ? detail.srcNoticeNumber : item.id,
    maxPrice: Number.isFinite(Number(detail.cost)) ? Number(detail.cost) : item.cost,
    sourceUrl: typeof detail.sourceUrl === 'string' ? detail.sourceUrl : null,
  }
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

export default function App() {
  const [library, setLibrary] = useState<LibraryDoc[]>([])
  const [status, setStatus] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [matches, setMatches] = useState<MatchResult[]>([])
  const [decision, setDecision] = useState<string>('')
  const [matchPercent, setMatchPercent] = useState<number | null>(null)
  const [matchedCount, setMatchedCount] = useState<number | null>(null)
  const [bestMatchFilename, setBestMatchFilename] = useState<string | null>(null)
  const [rowResults, setRowResults] = useState<RowResult[]>([])
  const [llmExplanation, setLlmExplanation] = useState<string | null>(null)
  const [analyzerInfo, setAnalyzerInfo] = useState<AnalyzerInfo | null>(null)
  const [emailNotification, setEmailNotification] = useState<EmailNotification | null>(null)
  const [tenderKeys, setTenderKeys] = useState<TenderKey[]>([])
  const [selectedTenderKeyId, setSelectedTenderKeyId] = useState<string>('')
  const [tenderKeysError, setTenderKeysError] = useState<string>('')
  const [tenderItems, setTenderItems] = useState<TenderListItem[]>([])
  const [tenderItemsError, setTenderItemsError] = useState<string>('')
  const [tenderAttachments, setTenderAttachments] = useState<TenderAttachmentItem[]>([])
  const [tenderAttachmentsError, setTenderAttachmentsError] = useState<string>('')
  const [konturItems, setKonturItems] = useState<KonturListItem[]>([])
  const [konturSearchError, setKonturSearchError] = useState<string>('')
  const [bicotenderItems, setBicotenderItems] = useState<BicotenderListItem[]>([])
  const [bicotenderError, setBicotenderError] = useState<string>('')
  const [isTenderModalOpen, setIsTenderModalOpen] = useState(false)
  const [isTenderItemsLoading, setIsTenderItemsLoading] = useState(false)
  const [isAttachmentLoading, setIsAttachmentLoading] = useState(false)
  const [selectedRemoteFilename, setSelectedRemoteFilename] = useState<string>('')
  const [selectedTenderMeta, setSelectedTenderMeta] = useState<TenderMetaForMatch | null>(null)
  const [tenderModalStep, setTenderModalStep] = useState<'tenders' | 'attachments'>('tenders')
  const [minCriteriaIfNameMatched, setMinCriteriaIfNameMatched] = useState(2)
  const minC = minCriteriaIfNameMatched
  const isMatchByPoints =
    decision === 'match' ||
    (matchedCount ?? 0) >= minC ||
    rowResults.length >= minC
  async function refreshLibrary() {
    const resp = await fetch('/api/library/list')
    const json = await resp.json()
    if (!resp.ok) throw new Error(json?.error ?? 'Failed to load library')
    setLibrary(json.docs ?? [])
  }

  async function clearLibrary() {
    setError('')
    setStatus('Очищаю библиотеку...')
    try {
      const resp = await fetch('/api/library/clear', { method: 'POST' })
      const json = await resp.json().catch(() => null)
      if (!resp.ok) throw new Error(json?.error ?? `Failed: ${resp.status}`)
      await refreshLibrary()
      setStatus('')
    } catch (e) {
      setStatus('')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function removeLibraryDoc(id: string) {
    setError('')
    try {
      const resp = await fetch(`/api/library/${encodeURIComponent(id)}`, { method: 'DELETE' })
      const json = await resp.json().catch(() => null)
      if (!resp.ok) throw new Error(json?.error ?? `Failed: ${resp.status}`)
      await refreshLibrary()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    refreshLibrary().catch(() => {
      // Если библиотека ещё пуста или backend недоступен — просто оставим пустой список.
      setLibrary([])
    })
  }, [])

  useEffect(() => {
    const loadTendersByKey = async () => {
      if (!selectedTenderKeyId) {
        setTenderItems([])
        setTenderItemsError('')
        setTenderAttachments([])
        setTenderAttachmentsError('')
        setKonturItems([])
        setKonturSearchError('')
        setBicotenderItems([])
        setBicotenderError('')
        setTenderModalStep('tenders')
        setIsTenderModalOpen(false)
        setSelectedTenderMeta(null)
        return
      }
      setIsTenderItemsLoading(true)
      setTenderItemsError('')
      setTenderAttachments([])
      setTenderAttachmentsError('')
      setKonturItems([])
      setKonturSearchError('')
      setBicotenderItems([])
      setBicotenderError('')
      setTenderModalStep('tenders')
      try {
        const resp = await fetch(`/api/tender-tenders?key=${encodeURIComponent(selectedTenderKeyId)}`)
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
        setTenderItems(details)

        // Kontur Zakupki external search (server-side proxy).
        try {
          const selectedKey = tenderKeys.find((k) => k._id === selectedTenderKeyId)
          const konturParams = new URLSearchParams({
            ...konturSearchDateRange(),
            keyId: selectedTenderKeyId,
            Attachments: 'true',
          })
          for (const t of selectedKey?.Text ?? []) konturParams.append('Text', t)
          for (const e of selectedKey?.Exclude ?? []) konturParams.append('Exclude', e)
          const kResp = await fetch(`/api/kontur/search?${konturParams.toString()}`)
          const kJson = await kResp.json().catch(() => null)
          if (kResp.ok) {
            setKonturItems(parseKonturItems(kJson?.result ?? kJson))
          } else {
            setKonturSearchError(kJson?.error ?? `Kontur request failed: ${kResp.status}`)
          }
        } catch (e) {
          setKonturSearchError(e instanceof Error ? e.message : String(e))
        }

        // Bicotender external search (server-side proxy).
        try {
          const selectedKey = tenderKeys.find((k) => k._id === selectedTenderKeyId)
          const bicotenderParams = new URLSearchParams({ keyId: selectedTenderKeyId })
          for (const t of selectedKey?.Text ?? []) bicotenderParams.append('keywords', t)
          for (const e of selectedKey?.Exclude ?? []) bicotenderParams.append('nokeywords', e)
          const bResp = await fetch(`/api/bicotender/tenders?${bicotenderParams.toString()}`)
          const bJson = await bResp.json().catch(() => null)
          if (bResp.ok) {
            setBicotenderItems(parseBicotenderItems(bJson?.result ?? bJson))
          } else {
            setBicotenderError(bJson?.error ?? `Bicotender request failed: ${bResp.status}`)
          }
        } catch (e) {
          setBicotenderError(e instanceof Error ? e.message : String(e))
        }
      } catch (e) {
        setTenderItems([])
        setTenderItemsError(e instanceof Error ? e.message : 'Не удалось загрузить элементы.')
      } finally {
        setIsTenderItemsLoading(false)
        setIsTenderModalOpen(true)
      }
    }
    loadTendersByKey()
  }, [selectedTenderKeyId])

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
      } catch (e) {
        setTenderKeysError(e instanceof Error ? e.message : 'Не удалось загрузить ключи.')
        setTenderKeys([])
      }
    }
    run()
  }, [])

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

  async function openKonturPurchase(item: KonturListItem) {
    setIsTenderItemsLoading(true)
    setTenderAttachmentsError('')
    try {
      const resp = await fetch(`/api/kontur/purchases/get?id=${encodeURIComponent(item.id)}`)
      const json = await resp.json().catch(() => null)
      if (!resp.ok) throw new Error(json?.error ?? `Failed: ${resp.status}`)
      const detail = (json?.result ?? json) as Record<string, unknown>

      setTenderAttachments(konturAttachmentsFromPurchase(detail))
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

  async function openBicotenderTender(item: BicotenderListItem) {
    setIsTenderItemsLoading(true)
    setTenderAttachmentsError('')
    try {
      const resp = await fetch(`/api/bicotender/tenders/get?tender_id=${encodeURIComponent(item.id)}`)
      const json = await resp.json().catch(() => null)
      if (!resp.ok) throw new Error(json?.error ?? `Failed: ${resp.status}`)
      const detail = (json?.result ?? json) as Record<string, unknown>

      setTenderAttachments(bicotenderAttachmentsFromDetail(detail))
      setSelectedTenderMeta(bicotenderMetaFromDetail(item, detail))
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
      setTenderAttachments(list)
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
        customerName: orgShortName ?? null,
        customerInn: orgInn,
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
      setError('')
      setStatus('Загружаю файл из аукционной документации...')
      setIsAttachmentLoading(true)
      const attachmentEndpoint =
        fileItem.source === 'bicotender' || fileItem.source === 'kontur'
          ? '/api/bicotender/attachment'
          : '/api/tender-attachment'
      const url = `${attachmentEndpoint}?href=${encodeURIComponent(fileItem.href)}&realName=${encodeURIComponent(fileItem.realName)}`
      const resp = await fetch(url)
      if (!resp.ok) {
        const json = await resp.json().catch(() => null)
        throw new Error(json?.error ?? `Failed: ${resp.status}`)
      }
      const blob = await resp.blob()
      const file = new File([blob], fileItem.realName || 'attachment', { type: blob.type || 'application/octet-stream' })
      setSelectedRemoteFilename(file.name)
      setStatus('')
      setIsTenderModalOpen(false)
      await onMatch(file, selectedTenderMeta)
    } catch (e) {
      setStatus('')
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIsAttachmentLoading(false)
    }
  }

  async function onAddToLibrary(file: File | null) {
    setError('')
    if (!file) return
    setStatus('Идёт индексация...')
    try {
      await uploadFile('/api/library/add', file)
      setStatus('Готово. Обновляю библиотеку...')
      await refreshLibrary()
      setStatus('')
    } catch (e) {
      setStatus('')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function onMatch(file: File | null, tenderMeta?: TenderMetaForMatch | null) {
    setError('')
    if (!file) return
    setStatus('Идёт поиск...')
    setMatches([])
    setRowResults([])
    setDecision('')
    setMatchPercent(null)
    setMatchedCount(null)
    setBestMatchFilename(null)
    setLlmExplanation(null)
    setAnalyzerInfo(null)
    setEmailNotification(null)
    try {
      // Обновляем библиотеку перед матчингом, чтобы не зависеть от устаревшего состояния.
      await refreshLibrary().catch(() => undefined)
      if (library.length === 0) {
        setStatus('')
        setError('Библиотека пустая. Сначала добавьте техописания поставщика.')
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
      setStatus('')
    } catch (e) {
      setStatus('')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <main className="ms-app">
      <h1 className="ms-title">Подбор теххарактеристик по загруженному файлу</h1>

      <section className="ms-section">
        <h2 className="ms-section-title">1. Добавить в библиотеку (техописания)</h2>
        <input
          type="file"
          accept=".pdf,.doc,.docx,.xlsx,.xls"
          onChange={(e) => onAddToLibrary(e.target.files?.[0] ?? null)}
        />
      </section>

      <section className="ms-section">
        <h2 className="ms-section-title">2. Загрузить описание товара</h2>
        <div className="ms-field">
          <label className="ms-label" htmlFor="tender-key-select">
            Ключ
          </label>
          <select
            id="tender-key-select"
            className="ms-select"
            value={selectedTenderKeyId}
            onChange={(e) => setSelectedTenderKeyId(e.target.value)}
            disabled={tenderKeys.length === 0}
          >
            <option value="">
              {tenderKeys.length === 0 ? (tenderKeysError || 'Ключи не загружены') : 'Выберите ключ'}
            </option>
            {tenderKeys.length === 0 ? null : (
              tenderKeys.map((k) => (
                <option key={k._id} value={k._id}>
                  {k.name}
                </option>
              ))
            )}
          </select>
        </div>
        <button type="button" className="ms-btn" onClick={() => setIsTenderModalOpen(true)} disabled={!selectedTenderKeyId}>
          Показать элементы по ключу
        </button>
        <input
          type="file"
          accept=".pdf,.doc,.docx,.xlsx,.xls"
          onChange={(e) => onMatch(e.target.files?.[0] ?? null)}
        />
        {selectedRemoteFilename ? <p className="ms-muted">Выбран файл из аукционной документации: {selectedRemoteFilename}</p> : null}

        {status ? <p className="ms-status">{status}</p> : null}
        {error ? (
          <p className="ms-error">Ошибка: {error}</p>
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
        <h2 className="ms-section-title">Библиотека</h2>
        {library.length === 0 ? (
          <p className="ms-muted">Пока нет проиндексированных файлов.</p>
        ) : (
          <>
            <div className="ms-toolbar">
              <button
                type="button"
                onClick={() => clearLibrary()}
                className="ms-btn"
              >
                Очистить библиотеку
              </button>
            </div>
            <div className="ms-grid ms-grid--library">
              {library.map((d) => (
                <div key={d.id} className="ms-card ms-card--lib">
                  <button
                    type="button"
                    className="ms-card-close"
                    aria-label={`Удалить ${d.originalFilename}`}
                    onClick={() => removeLibraryDoc(d.id)}
                    title="Удалить из библиотеки"
                  >
                    ×
                  </button>
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
            {tenderModalStep === 'tenders' && !isTenderItemsLoading && bicotenderError ? (
              <p className="ms-error">Bicotender ошибка: {bicotenderError}</p>
            ) : null}
            {tenderModalStep === 'tenders' && !isTenderItemsLoading && bicotenderItems.length > 0 ? (
              <div className="ms-grid ms-grid--tenders">
                {bicotenderItems.map((item) => (
                  <button
                    type="button"
                    key={`bicotender-${item.id}-${item.name}`}
                    className="ms-card ms-card--tender ms-card--bicotender ms-card-button"
                    onClick={() => openBicotenderTender(item)}
                  >
                    <div className="ms-card-title">{item.name || 'Без названия'}</div>
                    <div className="ms-line">НМЦК: {formatPrice(item.cost)} ₽</div>
                    <div className="ms-meta">{item.id || 'Без id'}</div>
                  </button>
                ))}
              </div>
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
            konturItems.length === 0 &&
            bicotenderItems.length === 0 ? (
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
    </main>
  )
}


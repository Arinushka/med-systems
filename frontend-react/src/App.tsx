import { useEffect, useState } from 'react'

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

async function uploadFile(endpoint: string, file: File): Promise<any> {
  const fd = new FormData()
  fd.append('file', file)
  // multer/originalname иногда приходит с неправильной кодировкой для кириллицы.
  // Передаём имя напрямую из браузера, чтобы отображение и индексация были корректными.
  fd.append('clientFilename', file.name)

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
  const isMatchByPoints = (matchedCount ?? 0) >= 2
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

  async function onMatch(file: File | null) {
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
    try {
      // Обновляем библиотеку перед матчингом, чтобы не зависеть от устаревшего состояния.
      await refreshLibrary().catch(() => undefined)
      if (library.length === 0) {
        setStatus('')
        setError('Библиотека пустая. Сначала добавьте техописания поставщика.')
        return
      }
      const json = await uploadFile('/api/match', file)
      setDecision(json.decision ?? '')
      setMatchPercent(typeof json.matchPercent === 'number' ? json.matchPercent : null)
      setMatches(json.matches ?? [])
      setMatchedCount(typeof json.matchedCount === 'number' ? json.matchedCount : null)
      setBestMatchFilename(typeof json.bestMatchFilename === 'string' ? json.bestMatchFilename : null)
      setRowResults(Array.isArray(json.rowResults) ? json.rowResults : [])
      setLlmExplanation(typeof json.llmExplanation === 'string' ? json.llmExplanation : null)
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
          accept=".pdf,.docx,.xlsx,.xls"
          onChange={(e) => onAddToLibrary(e.target.files?.[0] ?? null)}
        />
      </section>

      <section className="ms-section">
        <h2 className="ms-section-title">2. Загрузить описание товара</h2>
        <input
          type="file"
          accept=".pdf,.docx,.xlsx,.xls"
          onChange={(e) => onMatch(e.target.files?.[0] ?? null)}
        />

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
    </main>
  )
}


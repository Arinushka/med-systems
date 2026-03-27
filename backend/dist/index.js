import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { embedTexts } from './lib/openaiEmbeddings';
import { centroid } from './lib/centroid';
import { cosineSimilarity } from './utils/cosine';
import { extractRowsFromFile } from './lib/rows';
import { loadIndex, saveIndex } from './lib/indexStore';
import { valuesMatch } from './lib/valueCompare';
import { compareProductNamesWithOllama, judgeMatch } from './lib/judge';
import { createLibraryStorage } from './lib/storage';
import { isExcludedFromParameterMatch, scoreKeyValueIndicators, tenderAliasesAllowValueCompare, } from './lib/keyValueScoring';
import { extractNormalizedProductNamesFromRows } from './lib/productName';
const app = express();
function productNameHintFromFilename(filename) {
    const base = path.basename(filename, path.extname(filename));
    let s = base
        .toLowerCase()
        .replace(/[–—-]+/g, ' ')
        .replace(/[_]+/g, ' ')
        .replace(/[()]/g, ' ');
    // Remove common template words that carry no product meaning.
    // Note: JS \\w does not match Cyrillic reliably for these forms, so keep explicit patterns.
    s = s
        .replace(/тех(?:ническ[а-яё]*)?\s*задан[а-яё]*/gi, ' ')
        .replace(/техническ[а-яё]*/gi, ' ')
        .replace(/тз/gi, ' ')
        .replace(/тх/gi, ' ')
        .replace(/поставщик[а-яё]*/gi, ' ')
        .replace(/аукцион[а-яё]*/gi, ' ')
        .replace(/закупк[а-яё]*/gi, ' ')
        .replace(/сайте/gi, ' ')
        .replace(/zakupki/gi, ' ')
        .replace(/gov/gi, ' ')
        .replace(/ru/gi, ' ')
        .replace(/docx/gi, ' ')
        .replace(/pdf/gi, ' ')
        .replace(/xlsx/gi, ' ')
        .replace(/xls/gi, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    if (!s || s.length < 3)
        return null;
    return s;
}
function tokenizeName(s) {
    return (s ?? '')
        .toLowerCase()
        .split(/\s+/g)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3);
}
function namesContainmentMatch(a, b) {
    const x = (a ?? '').trim();
    const y = (b ?? '').trim();
    if (!x || !y)
        return false;
    // Direct containment for long enough phrases.
    const minLen = 14;
    if ((x.length >= minLen && y.includes(x)) || (y.length >= minLen && x.includes(y)))
        return true;
    // Token-coverage containment (shorter name should mostly be present in longer one).
    const ta = tokenizeName(x);
    const tb = tokenizeName(y);
    if (ta.length < 3 || tb.length < 3)
        return false;
    const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    const longSet = new Set(longer);
    let hit = 0;
    for (const t of shorter)
        if (longSet.has(t))
            hit++;
    if (hit / shorter.length >= 0.75)
        return true;
    // Semantic-root fallback: tolerate inflection/word-form differences
    // (e.g. "наркотики" vs "наркотических") in procurement naming.
    const roots = (arr) => arr
        .filter((t) => t.length >= 5)
        .map((t) => t.slice(0, 5));
    const ra = new Set(roots(ta));
    const rb = new Set(roots(tb));
    let commonRoots = 0;
    for (const r of ra)
        if (rb.has(r))
            commonRoots++;
    if (commonRoots > 0) {
        const text = `${x} ${y}`;
        if (/(ивд|тест|анализ|диагност|кассет|панел|контейнер|полоск)/.test(text))
            return true;
    }
    return false;
}
function productNameListsContainmentMatch(a, b) {
    for (const x of a) {
        for (const y of b) {
            if (namesContainmentMatch(x, y))
                return true;
        }
    }
    return false;
}
// Load environment variables for local dev.
// We try multiple locations because backend can be started from different working directories.
const envCandidates = [
    path.join(process.cwd(), '.env'),
    path.join(process.cwd(), '..', '.env'),
    path.join(process.cwd(), 'backend', '.env'),
    path.join(process.cwd(), '..', 'backend', '.env'),
];
const envPath = envCandidates.find((p) => existsSync(p));
if (envPath) {
    dotenv.config({ path: envPath, override: true });
}
else {
    console.warn('No .env file found for OpenAI credentials. Create `backend/.env` with `OPENAI_API_KEY=...`.');
}
app.use(cors());
app.use(express.json());
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 25 * 1024 * 1024, // 25MB per file
    },
});
const LIB_DIR = path.join(process.cwd(), 'data', 'library');
const storage = createLibraryStorage(LIB_DIR);
function restoreUtf8FromLatin1(maybeMojibake) {
    // If browser sent UTF-8 bytes but headers were decoded as latin1,
    // we'd see patterns like `ÐŸÑ€...`. Converting latin1 -> utf8 restores the original.
    // We'll only apply conversion when it looks like mojibake.
    const looksMojibake = /[ÐÑÒÓÖ×ØÙÚÛÜÝÞßà-ÿ]/.test(maybeMojibake);
    if (!looksMojibake)
        return maybeMojibake;
    const restored = Buffer.from(maybeMojibake, 'latin1').toString('utf8');
    // If the restored string contains Cyrillic, assume it was correct.
    if (/[\u0400-\u04FF]/.test(restored))
        return restored;
    return maybeMojibake;
}
function safeExtension(filename) {
    const ext = path.extname(filename).toLowerCase();
    if (!ext)
        return '';
    return ext;
}
app.get('/api/health', (_req, res) => {
    const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);
    const judgeProvider = String(process.env.JUDGE_PROVIDER ?? '').toLowerCase();
    const embeddingsProvider = String(process.env.EMBEDDINGS_PROVIDER ?? '').toLowerCase();
    const embeddingMode = embeddingsProvider === 'local' ? 'local' : openaiConfigured ? 'openai' : 'local';
    res.json({
        ok: true,
        openaiConfigured,
        embeddingMode,
        judgeProvider: judgeProvider || null,
    });
});
app.post('/api/library/add', upload.single('file'), async (req, res) => {
    try {
        const f = req.file;
        if (!f)
            return res.status(400).json({ error: 'Missing file (field "file")' });
        const clientFilename = typeof req.body?.clientFilename === 'string' ? req.body.clientFilename : null;
        const originalFilename = clientFilename ?? f.originalname;
        const fixedFilename = restoreUtf8FromLatin1(originalFilename);
        const extension = safeExtension(fixedFilename);
        if (!['.pdf', '.docx', '.xlsx', '.xls'].includes(extension)) {
            return res.status(400).json({ error: 'Unsupported file type' });
        }
        const id = crypto.randomUUID();
        const storedPath = await storage.save({ id, originalFilename: fixedFilename, buffer: f.buffer });
        const rows = await extractRowsFromFile({ buffer: f.buffer, filename: fixedFilename });
        if (rows.length === 0) {
            return res.status(400).json({ error: 'No rows detected in file (indicator/value)' });
        }
        const indicatorEmbeddings = await embedTexts(rows.map((r) => r.indicator));
        for (let i = 0; i < rows.length; i++) {
            rows[i] = { ...rows[i], embedding: indicatorEmbeddings[i] };
        }
        // Store a doc embedding as fallback/ranking.
        const docEmbedding = centroid(indicatorEmbeddings);
        const doc = {
            id,
            originalFilename: fixedFilename,
            extension,
            storedPath,
            docEmbedding,
            rowsCount: rows.length,
            rows,
            indexedAt: new Date().toISOString(),
        };
        const index = await loadIndex();
        index.docs.push(doc);
        await saveIndex(index);
        res.json({
            ok: true,
            id,
            originalFilename,
            rows: rows.length,
        });
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        res.status(500).json({ error: message });
    }
});
app.get('/api/library/list', async (_req, res) => {
    try {
        const index = await loadIndex();
        res.json({
            ok: true,
            docs: index.docs.map((d) => ({
                id: d.id,
                originalFilename: d.originalFilename,
                extension: d.extension,
                storedPath: d.storedPath,
                rowsCount: d.rowsCount ?? (Array.isArray(d.rows) ? d.rows.length : null),
                indexedAt: d.indexedAt,
            })),
        });
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        res.status(500).json({ error: message });
    }
});
app.delete('/api/library/:id', async (req, res) => {
    try {
        const id = String(req.params.id ?? '').trim();
        if (!id)
            return res.status(400).json({ error: 'Missing document id' });
        const index = await loadIndex();
        const doc = index.docs.find((d) => d.id === id);
        if (!doc)
            return res.status(404).json({ error: 'Document not found' });
        // Remove physical file/object (best effort).
        await storage.remove(doc.storedPath).catch(() => undefined);
        index.docs = index.docs.filter((d) => d.id !== id);
        await saveIndex(index);
        res.json({ ok: true, removedId: id });
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        res.status(500).json({ error: message });
    }
});
app.post('/api/library/clear', async (_req, res) => {
    try {
        const indexPath = path.join(process.cwd(), 'data', 'library-index.json');
        await storage.clearAll();
        await fs.rm(indexPath, { force: true });
        res.json({ ok: true });
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        res.status(500).json({ error: message });
    }
});
app.post('/api/library/reindexStored', async (_req, res) => {
    try {
        const supported = new Set(['.pdf', '.docx', '.xlsx', '.xls']);
        const storageFiles = await storage.list();
        const libraryFiles = storageFiles.filter((x) => supported.has(path.extname(x.name).toLowerCase()));
        // Clear existing index; keep physical files.
        const indexPath = path.join(process.cwd(), 'data', 'library-index.json');
        await fs.rm(indexPath, { force: true });
        const docs = [];
        for (const file of libraryFiles) {
            const storedPath = file.storedPath;
            const name = file.name;
            // Try to parse stored format: <uuid>-<originalFilename>
            const m = name.match(/^([0-9a-fA-F-]{36})-(.+)$/);
            const id = m?.[1] ?? crypto.randomUUID();
            const originalFilenameRaw = m?.[2] ?? name;
            const fixedFilename = restoreUtf8FromLatin1(originalFilenameRaw);
            const extension = safeExtension(fixedFilename);
            const buffer = await storage.read(storedPath);
            const rows = await extractRowsFromFile({ buffer, filename: fixedFilename });
            if (rows.length === 0)
                continue;
            const indicatorEmbeddings = await embedTexts(rows.map((r) => r.indicator));
            for (let i = 0; i < rows.length; i++) {
                ;
                rows[i] = { ...rows[i], embedding: indicatorEmbeddings[i] };
            }
            const docEmbedding = centroid(indicatorEmbeddings);
            docs.push({
                id,
                originalFilename: fixedFilename,
                extension,
                storedPath,
                docEmbedding,
                rowsCount: rows.length,
                rows: rows,
                indexedAt: new Date().toISOString(),
            });
        }
        await saveIndex({
            version: 1,
            createdAt: new Date().toISOString(),
            docs,
        });
        res.json({ ok: true, docsIndexed: docs.length });
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        res.status(500).json({ error: message });
    }
});
app.post('/api/match', upload.single('file'), async (req, res) => {
    try {
        const f = req.file;
        if (!f)
            return res.status(400).json({ error: 'Missing file (field "file")' });
        const clientFilename = typeof req.body?.clientFilename === 'string' ? req.body.clientFilename : null;
        const originalFilename = clientFilename ?? f.originalname;
        const fixedFilename = restoreUtf8FromLatin1(originalFilename);
        const extension = safeExtension(fixedFilename);
        if (!['.pdf', '.docx', '.xlsx', '.xls'].includes(extension)) {
            return res.status(400).json({ error: 'Unsupported file type' });
        }
        const index = await loadIndex();
        if (index.docs.length === 0) {
            return res.status(400).json({ error: 'Library is empty. Add tech specification files first.' });
        }
        const queryRows = await extractRowsFromFile({ buffer: f.buffer, filename: fixedFilename });
        if (queryRows.length === 0) {
            return res.status(400).json({ error: 'No rows detected in uploaded file (indicator/value)' });
        }
        // First gate: product name must match between query file and library document (any of several parsed titles).
        const queryProductNames = extractNormalizedProductNamesFromRows(queryRows);
        const queryFileHint = productNameHintFromFilename(fixedFilename);
        const queryNamesForGate = [...queryProductNames];
        if (queryFileHint && !queryNamesForGate.includes(queryFileHint))
            queryNamesForGate.push(queryFileHint);
        const indicatorEmbeddings = await embedTexts(queryRows.map((r) => r.indicator));
        for (let i = 0; i < queryRows.length; i++) {
            queryRows[i] = { ...queryRows[i], embedding: indicatorEmbeddings[i] };
        }
        const indicatorSimilarityThreshold = Number(process.env.MATCH_INDICATOR_SIM_THRESHOLD ?? 0.75);
        const passThresholdPercent = Number(process.env.MATCH_PASS_PERCENT ?? 82);
        const minCriteriaIfNameMatched = Number(process.env.MATCH_MIN_CRITERIA_IF_NAME_MATCH ?? 2);
        const maxCandidateDocs = Number(process.env.MATCH_CANDIDATE_DOCS ?? 8);
        const maxKeyRows = Number(process.env.MATCH_KEYVALUE_MAX_QUERY_ROWS ?? 40);
        const maxLibraryRows = Number(process.env.MATCH_KEYVALUE_MAX_LIBRARY_ROWS ?? 300);
        // Row-based decision; global centroid ranking is not used currently.
        const candidateDocs = index.docs.filter((doc) => Array.isArray(doc.rows) && doc.rows.length > 0);
        if (candidateDocs.length === 0) {
            return res.status(400).json({ error: 'Library contains no structured rows. Re-index the library.' });
        }
        if (queryNamesForGate.length === 0) {
            return res.json({
                ok: true,
                embeddingMode: String(process.env.EMBEDDINGS_PROVIDER ?? '').toLowerCase() === 'local'
                    ? 'local'
                    : process.env.OPENAI_API_KEY
                        ? 'openai'
                        : 'local',
                thresholdUsed: Number(process.env.MATCH_PASS_PERCENT ?? 82),
                indicatorSimilarityThresholdUsed: Number(process.env.MATCH_INDICATOR_SIM_THRESHOLD ?? 0.75),
                decision: 'no_match',
                bestScore: 0,
                matchPercent: 0,
                matchedCount: 0,
                totalCount: 0,
                bestMatchFilename: null,
                rowResults: [],
                llmDecision: null,
                llmConfidence: null,
                llmExplanation: 'В загруженном файле не найдено значение в колонке "Наименование товара". Сравнение по параметрам не выполнялось.',
                matches: [],
                productNameGate: { query: [], queryRows: queryProductNames, queryFileHint, library: [] },
            });
        }
        const productNameSimilarityThreshold = Number(process.env.MATCH_PRODUCT_NAME_SIM_THRESHOLD ?? 0.82);
        const libDocNames = candidateDocs.map((doc) => {
            const names = extractNormalizedProductNamesFromRows(doc.rows ?? []);
            const fileHint = productNameHintFromFilename(doc.originalFilename);
            const namesForGate = [...names];
            if (fileHint && !namesForGate.includes(fileHint))
                namesForGate.push(fileHint);
            return {
                doc,
                names,
                fileHint,
                namesForGate,
            };
        });
        const allNames = new Set(queryNamesForGate);
        for (const x of libDocNames) {
            for (const n of x.namesForGate)
                allNames.add(n);
        }
        const allNamesList = [...allNames];
        const allNameEmbeddings = allNamesList.length > 0 ? await embedTexts(allNamesList) : [];
        const nameEmbeddingMap = new Map();
        for (let i = 0; i < allNamesList.length; i++) {
            if (Array.isArray(allNameEmbeddings[i]))
                nameEmbeddingMap.set(allNamesList[i], allNameEmbeddings[i]);
        }
        const queryNameSet = new Set(queryNamesForGate);
        let gatedWithNameDiagnostics = libDocNames
            .map(({ doc, names, fileHint, namesForGate }) => {
            if (namesForGate.length === 0) {
                return {
                    doc,
                    names,
                    fileHint,
                    exactMatch: false,
                    semanticMatch: false,
                    bestSimilarity: -1,
                    bestPair: null,
                };
            }
            const exactMatch = namesForGate.some((n) => queryNameSet.has(n)) ||
                productNameListsContainmentMatch(queryNamesForGate, namesForGate);
            let bestSimilarity = -1;
            let bestPair = null;
            for (const qn of queryNamesForGate) {
                const qEmb = nameEmbeddingMap.get(qn);
                if (!qEmb)
                    continue;
                for (const ln of namesForGate) {
                    const lEmb = nameEmbeddingMap.get(ln);
                    if (!lEmb)
                        continue;
                    const s = cosineSimilarity(qEmb, lEmb);
                    if (s > bestSimilarity) {
                        bestSimilarity = s;
                        bestPair = { query: qn, library: ln };
                    }
                }
            }
            const semanticMatch = Number.isFinite(bestSimilarity) && bestSimilarity >= productNameSimilarityThreshold;
            return { doc, names, fileHint, namesForGate, exactMatch, semanticMatch, bestSimilarity, bestPair };
        });
        // Optional Ollama semantic gate for product names (meaning-based matching).
        if (String(process.env.JUDGE_PROVIDER ?? '').toLowerCase() === 'ollama') {
            // Ollama roundtrips are expensive; call it only for best unresolved candidates.
            const maxDocsForOllamaNameGate = Number(process.env.MATCH_OLLAMA_NAME_GATE_MAX_DOCS ?? 3);
            const unresolved = gatedWithNameDiagnostics
                .filter((x) => !x.exactMatch && !x.semanticMatch && Array.isArray(x.namesForGate) && x.namesForGate.length > 0)
                .sort((a, b) => Number(b.bestSimilarity ?? -1) - Number(a.bestSimilarity ?? -1))
                .slice(0, Math.max(0, maxDocsForOllamaNameGate));
            for (const x of unresolved) {
                try {
                    const ollamaName = await compareProductNamesWithOllama({
                        queryNames: queryNamesForGate,
                        libraryNames: x.namesForGate,
                    });
                    if (ollamaName) {
                        ;
                        x.ollamaNameMatch = ollamaName;
                        if (ollamaName.match) {
                            x.semanticMatch = true;
                            if (Number.isFinite(ollamaName.similarity)) {
                                x.bestSimilarity = Math.max(Number(x.bestSimilarity ?? -1), Number(ollamaName.similarity));
                            }
                            if (ollamaName.bestQueryName && ollamaName.bestLibraryName) {
                                x.bestPair = { query: ollamaName.bestQueryName, library: ollamaName.bestLibraryName };
                            }
                        }
                    }
                }
                catch (_e) {
                    // Ignore single-doc Ollama errors; fallback gate remains active.
                }
            }
        }
        gatedWithNameDiagnostics = gatedWithNameDiagnostics.filter((x) => x.exactMatch || x.semanticMatch);
        const gatedCandidateDocs = gatedWithNameDiagnostics.map((x) => x.doc);
        if (gatedCandidateDocs.length === 0) {
            const libraryNameSamples = libDocNames.slice(0, 12).map(({ doc, names, fileHint, namesForGate }) => {
                let bestSimilarity = -1;
                let bestPair = null;
                for (const qn of queryNamesForGate) {
                    const qEmb = nameEmbeddingMap.get(qn);
                    if (!qEmb)
                        continue;
                    for (const ln of namesForGate) {
                        const lEmb = nameEmbeddingMap.get(ln);
                        if (!lEmb)
                            continue;
                        const s = cosineSimilarity(qEmb, lEmb);
                        if (s > bestSimilarity) {
                            bestSimilarity = s;
                            bestPair = { query: qn, library: ln };
                        }
                    }
                }
                const diag = gatedWithNameDiagnostics.find((x) => x.doc.id === doc.id);
                return {
                    id: doc.id,
                    originalFilename: doc.originalFilename,
                    normalizedNames: names,
                    fileHint,
                    namesForGate,
                    bestSimilarity: Number.isFinite(bestSimilarity) ? bestSimilarity : null,
                    bestPair,
                    ollamaNameMatch: diag?.ollamaNameMatch ?? null,
                };
            });
            const anyLibraryHasName = libraryNameSamples.some((x) => x.normalizedNames.length > 0);
            const llmExplanation = anyLibraryHasName
                ? 'Названия товара не совпадают по смыслу. Сравнение по ключевым показателям не выполнялось. Поле productNameGate в ответе показывает извлеченные названия и их семантическую близость.'
                : 'В документах библиотеки не найдено наименование товара (пусто или устарел индекс). Выполните переиндексацию библиотеки (reindexStored) или заново загрузите файлы. Сравнение по параметрам не выполнялось.';
            return res.json({
                ok: true,
                embeddingMode: String(process.env.EMBEDDINGS_PROVIDER ?? '').toLowerCase() === 'local'
                    ? 'local'
                    : process.env.OPENAI_API_KEY
                        ? 'openai'
                        : 'local',
                thresholdUsed: Number(process.env.MATCH_PASS_PERCENT ?? 82),
                indicatorSimilarityThresholdUsed: Number(process.env.MATCH_INDICATOR_SIM_THRESHOLD ?? 0.75),
                decision: 'no_match',
                bestScore: 0,
                matchPercent: 0,
                matchedCount: 0,
                totalCount: 0,
                bestMatchFilename: null,
                rowResults: [],
                llmDecision: null,
                llmConfidence: null,
                llmExplanation,
                matches: [],
                productNameGate: {
                    query: queryNamesForGate,
                    queryRows: queryProductNames,
                    queryFileHint,
                    semanticThreshold: productNameSimilarityThreshold,
                    library: libraryNameSamples,
                },
            });
        }
        // 1) Fast coarse ranking using docEmbedding vs query centroid.
        const queryVectors = queryRows
            .filter((r) => !isExcludedFromParameterMatch(r.indicator))
            .map((r) => r.embedding)
            .filter((v) => Array.isArray(v));
        const queryDocEmbedding = queryVectors.length > 0 ? centroid(queryVectors) : null;
        const rankedByDocEmbedding = queryDocEmbedding
            ? gatedCandidateDocs
                .map((doc) => {
                const emb = doc.docEmbedding;
                const docScore = Array.isArray(emb) ? cosineSimilarity(queryDocEmbedding, emb) : -Infinity;
                return { doc, docScore };
            })
                .sort((a, b) => b.docScore - a.docScore)
                .slice(0, maxCandidateDocs)
            : gatedCandidateDocs.slice(0, maxCandidateDocs).map((doc) => ({ doc, docScore: -Infinity }));
        // 2) Expensive key-value scoring only for top candidates.
        const scoredDocs = rankedByDocEmbedding
            .map(({ doc }) => {
            const libRows = Array.isArray(doc.rows) ? doc.rows : [];
            const libRowsWithEmb = libRows.filter((r) => Array.isArray(r.embedding));
            if (libRowsWithEmb.length === 0) {
                return { doc, score: -Infinity, matchedCount: 0, totalCount: 0, matchedKeys: [] };
            }
            // Pre-filter library rows by similarity to query centroid (cuts O(N*M)).
            let reducedLibRowsWithEmb = libRowsWithEmb;
            if (queryDocEmbedding && libRowsWithEmb.length > maxLibraryRows) {
                reducedLibRowsWithEmb = [...libRowsWithEmb]
                    .map((r) => ({ r, s: cosineSimilarity(queryDocEmbedding, r.embedding) }))
                    .sort((a, b) => b.s - a.s)
                    .slice(0, maxLibraryRows)
                    .map((x) => x.r);
            }
            else if (libRowsWithEmb.length > maxLibraryRows) {
                reducedLibRowsWithEmb = libRowsWithEmb.slice(0, maxLibraryRows);
            }
            const valueToleranceRel = Number(process.env.MATCH_VALUE_TOLERANCE_REL ?? 0.1);
            const valueToleranceAbs = Number(process.env.MATCH_VALUE_TOLERANCE_ABS ?? 0);
            const prop = scoreKeyValueIndicators({
                queryRows: queryRows,
                libraryRows: reducedLibRowsWithEmb,
                indicatorSimilarityThreshold,
                valueToleranceRel,
                valueToleranceAbs,
                maxKeyRows,
            });
            const score = prop.totalPossible > 0 ? prop.points / prop.totalPossible : 0;
            return {
                doc,
                score,
                matchedCount: prop.points,
                totalCount: prop.totalPossible,
                matchedKeys: prop.matchedIndicators,
            };
        })
            .sort((a, b) => b.score - a.score);
        const heuristicBest = scoredDocs[0];
        // LLM judge step (neural network) for final decision.
        // For speed we can skip LLM when heuristic already reached required matched criteria.
        // This dramatically reduces latency on local Ollama models.
        const skipLlmWhenHeuristicConfident = String(process.env.MATCH_SKIP_LLM_IF_CRITERIA_MATCH ?? 'true') === 'true';
        const selected = heuristicBest;
        let llm = null;
        let llmError = null;
        const judgeProvider = String(process.env.JUDGE_PROVIDER ?? '').toLowerCase();
        const heuristicEnough = heuristicBest.matchedCount >= minCriteriaIfNameMatched;
        const shouldRunLlm = !(skipLlmWhenHeuristicConfident && heuristicEnough);
        if (shouldRunLlm) {
            try {
                const queryRowsForJudge = queryRows
                    .filter((r) => !isExcludedFromParameterMatch(r.indicator))
                    .map((r) => ({ indicator: r.indicator, valueRaw: r.valueRaw }));
                const selectedDoc = selected.doc;
                const libraryRowsForJudge = Array.isArray(selectedDoc?.rows)
                    ? selectedDoc.rows
                        .filter((r) => !isExcludedFromParameterMatch(r.indicator))
                        .map((r) => ({ indicator: r.indicator, valueRaw: r.valueRaw }))
                    : [];
                llm = await judgeMatch({
                    queryRows: queryRowsForJudge,
                    libraryRows: libraryRowsForJudge,
                    fileNames: { query: fixedFilename, library: selectedDoc?.originalFilename },
                });
                if (!llm) {
                    if (judgeProvider === 'openai') {
                        if (!process.env.OPENAI_API_KEY) {
                            llmError =
                                'OpenAI judge включен, но `OPENAI_API_KEY` не задан. Вставьте ключ в `backend/.env`. Используется эвристика.';
                        }
                        else {
                            llmError =
                                'OpenAI judge не сработал (возможна блокировка по региону 403/not supported). При необходимости включите VPN/прокси в поддерживаемый регион. Используется эвристика.';
                        }
                    }
                    else {
                        llmError =
                            'Нейросеть не вернула корректный структурированный ответ (judge). Используется эвристика.';
                    }
                }
                else if (!llm.explanation || llm.explanation.trim().length === 0) {
                    llmError = 'Нейросеть вернула решение, но не приложила текстовое объяснение. Используется эвристика по строкам.';
                }
            }
            catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                // Provide the original failure reason to help debugging proxy/VPN issues.
                llmError = `Ошибка при вызове нейросети (подробности): ${message}. Используется эвристика.`;
                llm = null;
            }
        }
        else {
            llmError = 'Нейросеть пропущена: эвристика уже выполнила критерий совпадения.';
        }
        // For Ollama judge we trust model decision/similarity as final.
        const decisionByCriteriaIfNameMatched = heuristicBest.matchedCount >= minCriteriaIfNameMatched ? 'match' : 'no_match';
        const decision = judgeProvider === 'ollama' && llm?.decision
            ? llm.decision
            : decisionByCriteriaIfNameMatched;
        // Build row-level explanation for the selected document only.
        let rowResults = [];
        const selectedDoc = selected.doc;
        if (selectedDoc && Array.isArray(selectedDoc.rows) && selectedDoc.rows?.length) {
            const libRowsWithEmb = selectedDoc.rows.filter((r) => Array.isArray(r.embedding) && !isExcludedFromParameterMatch(r.indicator));
            if (libRowsWithEmb.length > 0) {
                const queryRowsForResults = queryRows.filter((r) => !isExcludedFromParameterMatch(r.indicator));
                rowResults = queryRowsForResults.map((qRow) => {
                    const qEmb = qRow.embedding;
                    let bestSimAll = -Infinity;
                    let bestLibAll = null;
                    let bestSimValueMatch = -Infinity;
                    let bestLibValueMatch = null;
                    for (const lRow of libRowsWithEmb) {
                        const s = cosineSimilarity(qEmb, lRow.embedding);
                        if (s > bestSimAll) {
                            bestSimAll = s;
                            bestLibAll = lRow;
                        }
                        const aliasPair = tenderAliasesAllowValueCompare(qRow.indicator, lRow.indicator);
                        if (s < indicatorSimilarityThreshold && !aliasPair)
                            continue;
                        const m = valuesMatch({
                            queryValueRaw: qRow.valueRaw,
                            libraryValueRaw: lRow.valueRaw,
                            toleranceRel: Number(process.env.MATCH_VALUE_TOLERANCE_REL ?? 0.1),
                            toleranceAbs: Number(process.env.MATCH_VALUE_TOLERANCE_ABS ?? 0),
                        });
                        if (m.match && s > bestSimValueMatch) {
                            bestSimValueMatch = s;
                            bestLibValueMatch = lRow;
                        }
                    }
                    const chosenLib = bestLibValueMatch ?? bestLibAll;
                    const m = chosenLib
                        ? valuesMatch({
                            queryValueRaw: qRow.valueRaw,
                            libraryValueRaw: chosenLib.valueRaw,
                            toleranceRel: Number(process.env.MATCH_VALUE_TOLERANCE_REL ?? 0.1),
                            toleranceAbs: Number(process.env.MATCH_VALUE_TOLERANCE_ABS ?? 0),
                        })
                        : { match: false, reason: 'no candidate' };
                    const bestSimForIndicatorOk = chosenLib === bestLibValueMatch ? bestSimValueMatch : bestSimAll;
                    const indicatorOk = bestSimForIndicatorOk >= indicatorSimilarityThreshold ||
                        (chosenLib != null && tenderAliasesAllowValueCompare(qRow.indicator, chosenLib.indicator));
                    const valueOk = Boolean(m.match);
                    return {
                        indicator: qRow.indicator,
                        queryValueRaw: qRow.valueRaw,
                        matchedLibraryIndicator: chosenLib?.indicator,
                        matchedLibraryValueRaw: chosenLib?.valueRaw,
                        indicatorSimilarity: bestSimForIndicatorOk,
                        valueMatch: valueOk,
                        indicatorOk,
                        valueReason: m.reason,
                        rowMatched: indicatorOk && valueOk,
                    };
                });
                // User-facing output: show only actual matched criteria for the selected file.
                rowResults = rowResults.filter((r) => Boolean(r.rowMatched));
            }
        }
        res.json({
            ok: true,
            embeddingMode: String(process.env.EMBEDDINGS_PROVIDER ?? '').toLowerCase() === 'local'
                ? 'local'
                : process.env.OPENAI_API_KEY
                    ? 'openai'
                    : 'local',
            thresholdUsed: passThresholdPercent,
            indicatorSimilarityThresholdUsed: indicatorSimilarityThreshold,
            minCriteriaIfNameMatched,
            decision,
            bestScore: selected.score,
            matchPercent: Number.isFinite(selected.score) ? selected.score * 100 : 0,
            matchedCount: selected.matchedCount,
            totalCount: selected.totalCount,
            bestMatchFilename: selected.doc?.originalFilename ?? null,
            rowResults,
            llmDecision: llm?.decision ?? null,
            llmConfidence: llm?.confidence ?? null,
            llmSimilarity: llm?.similarity ?? null,
            llmExplanation: llm?.explanation && llm.explanation.trim().length > 0 ? llm.explanation : llmError ?? null,
            // We return only the best matching document.
            matches: decision === 'match'
                ? scoredDocs.slice(0, 1).map((m) => ({
                    id: m.doc.id,
                    originalFilename: m.doc.originalFilename,
                    storedPath: m.doc.storedPath,
                    extension: m.doc.extension,
                    score: m.score,
                    matchPercent: Number.isFinite(m.score) ? m.score * 100 : 0,
                    matchedCount: m.matchedCount,
                    totalCount: m.totalCount,
                }))
                : [],
        });
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        res.status(500).json({ error: message });
    }
});
const port = Number(process.env.PORT ?? 3001);
app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Backend listening on http://localhost:${port}`);
});

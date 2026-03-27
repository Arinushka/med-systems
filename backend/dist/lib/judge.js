import OpenAI from 'openai';
import { createProxiedOpenaiFetch } from './openaiFetchProxy';
function clamp01(n) {
    if (!Number.isFinite(n))
        return 0;
    if (n < 0)
        return 0;
    if (n > 1)
        return 1;
    return n;
}
function toCompactRows(rows, maxRows) {
    if (!Array.isArray(rows))
        return [];
    const filtered = rows.filter((r) => r && typeof r.indicator === 'string' && typeof r.valueRaw === 'string');
    return filtered.slice(0, maxRows);
}
function buildPrompt(params) {
    const { queryRows, libraryRows, fileNames } = params;
    return `
Ты эксперт по анализу теххарактеристик и подбору лабораторных/медицинских реагентов/изделий.
Тебе даны два набора данных с колонками:
- indicator: наименование показателя
- valueRaw: значение/диапазон

Нужно определить, соответствует ли описание товара из queryRows теххарактеристикам поставщика из libraryRows.

Правила:
1) Если большая часть показателей (по смыслу indicator) совпадает по значениям (valueRaw, включая числовые диапазоны/допуски) — решение: "match".
2) Если показатели или значения существенно расходятся или отсутствует ключевой показатель — решение: "no_match".
3) При сравнении числовых значений учитывай ограничения из valueRaw: > < ≥ ≤, а также словесные формы "более/меньше", "не более/не менее", "от X", "до Y", "от X до Y". Считай совпадением только если ограничения согласуются.
4) Верни строго JSON без текста вокруг.
Никаких markdown-кодфенсов (тройных обратных кавычек), только чистый JSON-объект.
Пояснение (explanation) должно быть написано ТОЛЬКО на русском языке.
explanation НЕ может быть пустой строкой. Сделай 1-2 коротких предложения (до ~250 символов).
{
  "decision": "match" | "no_match",
  "confidence": number_from_0.0_to_1.0,
  "similarity": number_from_0.0_to_1.0,
  "explanation": string
}

Query file: ${fileNames?.query ?? 'query'}
Library file: ${fileNames?.library ?? 'library'}

Query rows (первые N):
${JSON.stringify(queryRows, null, 2)}

Library rows (первые N):
${JSON.stringify(libraryRows, null, 2)}
`;
}
async function judgeWithOpenAI(params) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey)
        return null;
    const openai = new OpenAI({
        apiKey,
        fetch: createProxiedOpenaiFetch(),
    });
    const openaiClient = openai;
    const model = process.env.OPENAI_JUDGE_MODEL ?? 'gpt-4o-mini';
    let resp;
    try {
        resp = await openaiClient.chat.completions.create({
            model,
            temperature: 0,
            max_tokens: Number(process.env.OPENAI_JUDGE_MAX_TOKENS ?? 300),
            messages: [
                { role: 'system', content: 'Ты отвечаешь строго по формату JSON.' },
                { role: 'user', content: params.prompt },
            ],
            response_format: { type: 'json_object' },
        });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.toLowerCase().includes('not supported') || msg.includes('403')) {
            const force = process.env.OPENAI_FORCE === 'true';
            if (force) {
                throw new Error(`OpenAI judge blocked (403/not supported). VPN/proxy to supported region required. Original error: ${msg}`);
            }
            // Region blocked: throw so caller can show original reason (helps debugging VPN/proxy).
            throw new Error(`OpenAI judge blocked (403/not supported). VPN/proxy to supported region required. Original error: ${msg}`);
        }
        throw e;
    }
    const content = resp.choices[0]?.message?.content;
    if (!content)
        return null;
    const parsed = JSON.parse(content);
    if (!parsed || (parsed.decision !== 'match' && parsed.decision !== 'no_match'))
        return null;
    return {
        decision: parsed.decision,
        confidence: clamp01(Number(parsed.confidence)),
        similarity: clamp01(Number(parsed.similarity)),
        explanation: typeof parsed.explanation === 'string' && parsed.explanation.trim().length > 0
            ? parsed.explanation
            : 'Нейросеть оценила соответствие по индикаторам и значениям и сформировала решение.',
    };
}
async function judgeWithOllama(params) {
    const url = process.env.OLLAMA_URL;
    if (!url)
        return null;
    const model = process.env.OLLAMA_MODEL ?? 'llama3';
    const numPredict = Number(process.env.OLLAMA_NUM_PREDICT ?? 80);
    const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS ?? 20000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: params.prompt }],
                stream: false,
                options: { temperature: 0, num_predict: numPredict },
            }),
        });
    }
    finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Ollama HTTP error ${response.status}: ${body.slice(0, 800)}`);
    }
    const data = await response.json().catch(() => null);
    const content = data?.message?.content ?? data?.response ?? data?.output;
    if (typeof content !== 'string') {
        throw new Error('Ollama returned unexpected payload (content is not a string).');
    }
    const cleaned = content
        .replace(/```(?:json)?/g, '')
        .replace(/```/g, '')
        .trim();
    let parsed = null;
    try {
        parsed = JSON.parse(cleaned);
    }
    catch (e1) {
        // Extract first {...} block if model wrapped JSON with text/markdown.
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start >= 0 && end > start) {
            const slice = cleaned.slice(start, end + 1);
            try {
                parsed = JSON.parse(slice);
            }
            catch (e2) {
                const eMsg = e2 instanceof Error ? e2.message : String(e2);
                throw new Error(`Ollama JSON parse failed: ${eMsg}. Content: ${cleaned.slice(0, 500)}`);
            }
        }
        else {
            const eMsg = e1 instanceof Error ? e1.message : String(e1);
            throw new Error(`Ollama output has no JSON object. Parse error: ${eMsg}. Content: ${cleaned.slice(0, 500)}`);
        }
    }
    if (!parsed || (parsed.decision !== 'match' && parsed.decision !== 'no_match')) {
        throw new Error(`Ollama returned JSON but with invalid decision: ${String(parsed?.decision)}`);
    }
    return {
        decision: parsed.decision,
        confidence: clamp01(Number(parsed.confidence)),
        similarity: clamp01(Number(parsed.similarity)),
        explanation: typeof parsed.explanation === 'string' && parsed.explanation.trim().length > 0
            ? parsed.explanation
            : 'Нейросеть оценила соответствие по индикаторам и значениям и сформировала решение.',
    };
}
function buildNameMatchPrompt(params) {
    return `Ты анализируешь названия одного и того же медицинского/лабораторного товара.
Нужно сравнить два списка названий по смыслу (синонимы, перестановка слов, технические уточнения).
Верни строго JSON без markdown:
{
  "match": boolean,
  "similarity": number_from_0.0_to_1.0,
  "confidence": number_from_0.0_to_1.0,
  "bestQueryName": string,
  "bestLibraryName": string,
  "explanation": string
}

queryNames:
${JSON.stringify(params.queryNames, null, 2)}

libraryNames:
${JSON.stringify(params.libraryNames, null, 2)}
`;
}
export async function compareProductNamesWithOllama(params) {
    if (!params.queryNames.length || !params.libraryNames.length)
        return null;
    const provider = String(process.env.JUDGE_PROVIDER ?? '').toLowerCase();
    if (provider !== 'ollama' && !process.env.OLLAMA_URL)
        return null;
    const prompt = buildNameMatchPrompt(params);
    const url = process.env.OLLAMA_URL;
    if (!url)
        return null;
    const model = process.env.OLLAMA_MODEL ?? 'llama3';
    const numPredict = Number(process.env.OLLAMA_NUM_PREDICT ?? 80);
    const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS ?? 12000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                stream: false,
                options: { temperature: 0, num_predict: numPredict },
            }),
        });
    }
    finally {
        clearTimeout(timer);
    }
    if (!response.ok)
        return null;
    const data = await response.json().catch(() => null);
    const content = data?.message?.content ?? data?.response ?? data?.output;
    if (typeof content !== 'string')
        return null;
    const cleaned = content.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start)
        return null;
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return {
        match: Boolean(parsed?.match),
        similarity: clamp01(Number(parsed?.similarity)),
        confidence: clamp01(Number(parsed?.confidence)),
        bestQueryName: typeof parsed?.bestQueryName === 'string' ? parsed.bestQueryName : null,
        bestLibraryName: typeof parsed?.bestLibraryName === 'string' ? parsed.bestLibraryName : null,
        explanation: typeof parsed?.explanation === 'string' ? parsed.explanation : '',
    };
}
export async function judgeMatch(params) {
    // We aim to include "whole file", but still keep a payload bound for speed.
    const queryRows = toCompactRows(params.queryRows, Number(process.env.JUDGE_MAX_ROWS ?? 80));
    const libraryRows = toCompactRows(params.libraryRows, Number(process.env.JUDGE_MAX_ROWS ?? 80));
    const prompt = buildPrompt({
        queryRows,
        libraryRows,
        fileNames: params.fileNames,
    });
    const provider = process.env.JUDGE_PROVIDER ?? '';
    // Priority: explicit provider, else try OpenAI, else Ollama.
    if (provider === 'openai') {
        return await judgeWithOpenAI({ prompt });
    }
    if (provider === 'ollama') {
        return await judgeWithOllama({ prompt });
    }
    const openaiRes = await judgeWithOpenAI({ prompt });
    if (openaiRes)
        return openaiRes;
    const ollamaRes = await judgeWithOllama({ prompt });
    if (ollamaRes)
        return ollamaRes;
    return null;
}

import { cosineSimilarity } from '../utils/cosine';
import { valuesMatch } from './valueCompare';
function normalize(s) {
    return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}
/** Not compared between query and library (business rule). */
export function isExcludedFromParameterMatch(indicator) {
    const n = normalize(indicator ?? '');
    return n.includes('код ктру');
}
/** «Количество тестов» в ТЗ закупки ↔ «комплектация / варианты определений» в ТХ поставщика (разные формулировки, эмбеддинги часто ниже порога). */
function queryLooksLikeExecutableTestCount(indicator) {
    const q = normalize(indicator ?? '');
    if (!q.includes('количество'))
        return false;
    return (q.includes('тест') ||
        q.includes('выполняем') ||
        q.includes('определен') /* «количество … определений» в ТЗ */);
}
function libLooksLikeKittingLine(indicator) {
    const l = normalize(indicator ?? '');
    // «комплектация», опечатки «комлектация», «комлектаця», блоки про варианты наборов
    if (/комплект|комлектац|комплектац/.test(l))
        return true;
    if (l.includes('различ') && (l.includes('комлекта') || l.includes('комплект')))
        return true;
    if (l.includes('различ') && l.includes('определен'))
        return true;
    return false;
}
export function tenderAliasesAllowValueCompare(queryIndicator, libIndicator) {
    const q = normalize(queryIndicator ?? '');
    const l = normalize(libIndicator ?? '');
    // Needle gauge can be named as "Игла" or "Размер иглы" in different templates.
    const qNeedle = q === 'игла' || q.endsWith(' игла') || q.includes('размер иглы');
    const lNeedle = l === 'игла' || l.endsWith(' игла') || l.includes('размер иглы');
    if (qNeedle && lNeedle)
        return true;
    return ((queryLooksLikeExecutableTestCount(queryIndicator) && libLooksLikeKittingLine(libIndicator)) ||
        (queryLooksLikeExecutableTestCount(libIndicator) && libLooksLikeKittingLine(queryIndicator)));
}
function unitTokensMatch(a, b) {
    const na = normalize(a);
    const nb = normalize(b);
    const aHasPercent = na.includes('%') || na.includes('percent') || na.includes('проц');
    const bHasPercent = nb.includes('%') || nb.includes('percent') || nb.includes('проц');
    if (aHasPercent || bHasPercent)
        return aHasPercent === bHasPercent;
    const aHasNgMl = /ng\/?ml|нг\/?мл/.test(na);
    const bHasNgMl = /ng\/?ml|нг\/?мл/.test(nb);
    if (aHasNgMl || bHasNgMl)
        return aHasNgMl === bHasNgMl;
    return true;
}
function valueLooksLikeConstraint(raw) {
    const n = normalize(raw);
    if (/[0-9]/.test(n))
        return true;
    // Also handle phrases with comparisons.
    return /(\bболее\b|\bменее\b|\bравно\b|\bдо\b|\bот\b|\bне более\b|\bне менее\b|>=|<=|≥|≤|<|>)/i.test(raw);
}
function indicatorLooksLikeTextCriterion(indicator) {
    const n = normalize(indicator ?? '');
    if (n.includes('выявляем') && n.includes('веществ'))
        return true;
    if (n.includes('перечень') && n.includes('выявляем'))
        return true;
    return false;
}
export function scoreKeyValueIndicators(params) {
    const keyQueryRowsAll = params.queryRows.filter((r) => {
        if (isExcludedFromParameterMatch(r.indicator))
            return false;
        return valueLooksLikeConstraint(r.valueRaw) || indicatorLooksLikeTextCriterion(r.indicator);
    });
    const keyQueryRows = params.maxKeyRows != null && Number.isFinite(params.maxKeyRows) && params.maxKeyRows > 0
        ? keyQueryRowsAll.slice(0, params.maxKeyRows)
        : keyQueryRowsAll;
    const totalPossible = keyQueryRows.length;
    if (totalPossible === 0)
        return { points: 0, totalPossible: 0, matchedIndicators: [] };
    const libraryRows = params.libraryRows.filter((r) => !isExcludedFromParameterMatch(r.indicator));
    let points = 0;
    const matchedIndicators = [];
    for (const qRow of keyQueryRows) {
        let matched = false;
        for (const lRow of libraryRows) {
            const s = cosineSimilarity(qRow.embedding, lRow.embedding);
            const aliasPair = tenderAliasesAllowValueCompare(qRow.indicator, lRow.indicator);
            if (s < params.indicatorSimilarityThreshold && !aliasPair)
                continue;
            if (!unitTokensMatch(qRow.valueRaw, lRow.valueRaw))
                continue;
            const m = valuesMatch({
                queryValueRaw: qRow.valueRaw,
                libraryValueRaw: lRow.valueRaw,
                toleranceRel: params.valueToleranceRel,
                toleranceAbs: params.valueToleranceAbs,
            });
            if (m.match) {
                matched = true;
                break;
            }
        }
        if (matched) {
            points += 1;
            matchedIndicators.push(qRow.indicator);
        }
    }
    return { points, totalPossible, matchedIndicators };
}

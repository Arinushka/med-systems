import { cosineSimilarity } from '../utils/cosine.js';
import { valuesMatch } from './valueCompare.js';
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
function looksLikeCompositionIndicator(indicator) {
    const s = normalize(indicator ?? '');
    return s.includes('состав') || s.includes('комплектац') || s.includes('описан');
}
function looksLikePurposeOrDescriptionIndicator(indicator) {
    const s = normalize(indicator ?? '');
    return s.includes('назначен') || s.includes('описан');
}
function looksLikeInfectionMarkersIndicator(indicator) {
    const s = normalize(indicator ?? '');
    const hasCore = s.includes('выявлен') || s.includes('маркер') || s.includes('антител') || s.includes('антиген');
    const hasDisease = s.includes('вич') || s.includes('hiv') || s.includes('гепат') || s.includes('hbsag') || s.includes('сифил') || s.includes('treponema');
    return hasCore && hasDisease;
}
export function compositionLongTextFallbackMatch(queryValueRaw, libValueRaw) {
    const q = normalize(queryValueRaw ?? '');
    const l = normalize(libValueRaw ?? '');
    return q.length >= 80 && l.length >= 80;
}
function looksLikePackQuantity(indicator) {
    const s = normalize(indicator ?? '');
    if (!s.includes('колич'))
        return false;
    return (s.includes('упаков') ||
        s.includes('упак') ||
        s.includes('устройств') ||
        s.includes('набор') ||
        s.includes('комплект'));
}
function looksLikePhRangeIndicator(indicator) {
    const s = normalize(indicator ?? '');
    const hasRange = s.includes('диапазон') || s.includes('предел');
    const hasPh = s.includes('ph') || s.includes('рн');
    const hasMeasured = s.includes('определя') || s.includes('концентрац') || s.includes('значен');
    return hasRange && hasPh && hasMeasured;
}
function looksLikePhColorScaleIndicator(indicator) {
    const s = normalize(indicator ?? '');
    const hasScale = s.includes('шкал') && (s.includes('цвет') || s.includes('пол'));
    const hasPh = s.includes('ph') || s.includes('рн');
    return hasScale && hasPh;
}
function looksLikeAnalyticalSensitivityIndicator(indicator) {
    const s = normalize(indicator ?? '');
    const hasConcentration = s.includes('концентрац') || s.includes('нг мл') || s.includes('ng ml');
    const hasSensitivity = s.includes('чувствител') || s.includes('аналитическ') || s.includes('минимальн');
    if (hasConcentration && hasSensitivity)
        return true;
    // Some TЗ/PDF rows are truncated to just "концентрация, нг/мл".
    if (hasConcentration && (s.includes('равно') || s.includes('больше') || s.includes('менее')))
        return true;
    return false;
}
function looksLikeResearchMaterialIndicator(indicator) {
    const s = normalize(indicator ?? '');
    if (s.includes('исследуем') && s.includes('материал'))
        return true;
    if (s.includes('материал') && s.includes('исследован'))
        return true;
    if (s.includes('биологическ') && s.includes('материал'))
        return true;
    return false;
}
export function tenderAliasesAllowValueCompare(queryIndicator, libIndicator) {
    return ((queryLooksLikeExecutableTestCount(queryIndicator) && libLooksLikeKittingLine(libIndicator)) ||
        (queryLooksLikeExecutableTestCount(libIndicator) && libLooksLikeKittingLine(queryIndicator)) ||
        (queryLooksLikeExecutableTestCount(queryIndicator) && looksLikePackQuantity(libIndicator)) ||
        (queryLooksLikeExecutableTestCount(libIndicator) && looksLikePackQuantity(queryIndicator)) ||
        (looksLikePackQuantity(queryIndicator) && looksLikePackQuantity(libIndicator)) ||
        (looksLikePhRangeIndicator(queryIndicator) && looksLikePhRangeIndicator(libIndicator)) ||
        (looksLikePhColorScaleIndicator(queryIndicator) && looksLikePhColorScaleIndicator(libIndicator)) ||
        (looksLikeAnalyticalSensitivityIndicator(queryIndicator) && looksLikeAnalyticalSensitivityIndicator(libIndicator)) ||
        (looksLikeResearchMaterialIndicator(queryIndicator) && looksLikeResearchMaterialIndicator(libIndicator)) ||
        (looksLikeCompositionIndicator(queryIndicator) && looksLikeCompositionIndicator(libIndicator)) ||
        (looksLikePurposeOrDescriptionIndicator(queryIndicator) && looksLikePurposeOrDescriptionIndicator(libIndicator)) ||
        (looksLikeInfectionMarkersIndicator(queryIndicator) && looksLikeInfectionMarkersIndicator(libIndicator)));
}
function unitTokensMatch(a, b) {
    const na = normalize(a);
    const nb = normalize(b);
    // Avoid matching "проц" inside unrelated words like "процедурами".
    const aHasPercent = na.includes('%') || /\bpercent\b/.test(na) || na.includes('процент');
    const bHasPercent = nb.includes('%') || /\bpercent\b/.test(nb) || nb.includes('процент');
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
    if (n.includes('состав'))
        return true;
    if (n.includes('назначен'))
        return true;
    if (n.includes('комплектац'))
        return true;
    if (n.includes('описан'))
        return true;
    if ((n.includes('выявлен') || n.includes('маркер')) && (n.includes('вич') || n.includes('гепат') || n.includes('сифил')))
        return true;
    if (n.includes('камера смешивания образца'))
        return true;
    if (looksLikeAnalyticalSensitivityIndicator(n))
        return true;
    if (looksLikeResearchMaterialIndicator(n))
        return true;
    if (n.includes('биологич') && n.includes('материал'))
        return true;
    if (n.includes('материал') && n.includes('исследован'))
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
            const compositionAliasPair = looksLikeCompositionIndicator(qRow.indicator) && looksLikeCompositionIndicator(lRow.indicator);
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
            if (m.match || (compositionAliasPair && compositionLongTextFallbackMatch(qRow.valueRaw, lRow.valueRaw))) {
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

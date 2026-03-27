import { cosineSimilarity } from '../utils/cosine';
import { valuesMatch } from './valueCompare';
const DEFAULT_WEIGHTS = {
    analytical_sensitivity_ng_ml: 3,
    sensitivity_percent: 3,
    relative_sensitivity_percent: 2,
    specificity_percent: 3,
    matrix_material: 1,
    whole_capillary_blood_finger: 2,
};
function normalize(s) {
    return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function containsAny(s, parts) {
    const ns = normalize(s);
    return parts.some((p) => ns.includes(p));
}
export function categorizeIndicator(indicator) {
    const s = normalize(indicator);
    // Whole capillary blood from finger
    if ((s.includes('капилляр') || s.includes('капиллярной')) &&
        (s.includes('палец') || s.includes('из пальца') || s.includes('с пальца')) &&
        (s.includes('кров') || s.includes('крови') || s.includes('цельной'))) {
        return 'whole_capillary_blood_finger';
    }
    if (containsAny(s, ['цельной крови', 'цельная кровь', 'цельной капиллярной крови', 'капиллярной крови']) && containsAny(s, ['палец', 'пальца', 'из пальца'])) {
        return 'whole_capillary_blood_finger';
    }
    // Matrix / material for testing
    if (containsAny(s, ['материал', 'материал для исследования', 'источник', 'тип образца'])) {
        return 'matrix_material';
    }
    // Specificity
    if (containsAny(s, ['специфичность', 'специфичн'])) {
        return 'specificity_percent';
    }
    // Relative sensitivity
    if (containsAny(s, ['относительная чувствительность', 'относит', 'относительн'])) {
        return 'relative_sensitivity_percent';
    }
    // Analytical sensitivity (ng/ml)
    // Often unit may be present in value rather than indicator name.
    if (containsAny(s, ['аналитическая чувствительность', 'аналитическ', 'предел обнаружения'])) {
        return 'analytical_sensitivity_ng_ml';
    }
    // Sensitivity percent
    if (containsAny(s, ['чувствительность', 'sensitivity']) && !containsAny(s, ['аналитическ', 'аналитическая']) && !containsAny(s, ['относительная', 'относительн'])) {
        return 'sensitivity_percent';
    }
    return 'other';
}
function unitTokensMatch(a, b) {
    const na = normalize(a);
    const nb = normalize(b);
    const aHasPercent = na.includes('%') || na.includes('percent') || na.includes('проц');
    const bHasPercent = nb.includes('%') || nb.includes('percent') || nb.includes('проц');
    if (aHasPercent || bHasPercent) {
        return aHasPercent === bHasPercent;
    }
    const aHasNgMl = /ng\/?ml|нг\/?мл/.test(na);
    const bHasNgMl = /ng\/?ml|нг\/?мл/.test(nb);
    if (aHasNgMl || bHasNgMl) {
        return aHasNgMl === bHasNgMl;
    }
    // If no unit markers, don't block.
    return true;
}
function hasPercent(raw) {
    const n = normalize(raw);
    return n.includes('%') || n.includes('percent') || n.includes('проц');
}
function hasNgMl(raw) {
    const n = normalize(raw);
    return /ng\/?ml|нг\/?мл/.test(n);
}
export function scoreProperties(params) {
    const weights = { ...DEFAULT_WEIGHTS, ...(params.weights ?? {}) };
    const queryByKey = new Map();
    for (const r of params.queryRows) {
        const key = categorizeIndicator(r.indicator);
        if (key === 'other')
            continue;
        if (!queryByKey.has(key))
            queryByKey.set(key, []);
        queryByKey.get(key).push(r);
    }
    const libByKey = new Map();
    for (const r of params.libraryRows) {
        const key = categorizeIndicator(r.indicator);
        if (key === 'other')
            continue;
        if (!libByKey.has(key))
            libByKey.set(key, []);
        libByKey.get(key).push(r);
    }
    const keysPresent = Array.from(queryByKey.keys());
    let totalPossible = 0;
    for (const k of keysPresent)
        totalPossible += weights[k];
    // If we can't detect any key properties, fall back to 0.
    if (totalPossible <= 0) {
        return { points: 0, totalPossible: 0, matchedKeys: [] };
    }
    const matchedKeys = [];
    let points = 0;
    for (const key of keysPresent) {
        const queryRs = queryByKey.get(key) ?? [];
        const libRs = libByKey.get(key) ?? [];
        if (libRs.length === 0 || queryRs.length === 0)
            continue;
        let matched = false;
        for (const qRow of queryRs) {
            // Best match attempt within this property category.
            let bestSim = -Infinity;
            let bestMatchFound = false;
            for (const lRow of libRs) {
                const s = cosineSimilarity(qRow.embedding, lRow.embedding);
                if (s < params.indicatorSimilarityThreshold)
                    continue;
                // Category-specific unit requirements.
                if ((key === 'sensitivity_percent' || key === 'relative_sensitivity_percent' || key === 'specificity_percent') &&
                    (!hasPercent(qRow.valueRaw) || !hasPercent(lRow.valueRaw))) {
                    continue;
                }
                if (key === 'analytical_sensitivity_ng_ml' && (!hasNgMl(qRow.valueRaw) || !hasNgMl(lRow.valueRaw))) {
                    continue;
                }
                if (!unitTokensMatch(qRow.valueRaw, lRow.valueRaw))
                    continue;
                const m = valuesMatch({
                    queryValueRaw: qRow.valueRaw,
                    libraryValueRaw: lRow.valueRaw,
                    toleranceRel: params.valueToleranceRel,
                    toleranceAbs: params.valueToleranceAbs,
                });
                if (m.match) {
                    bestMatchFound = true;
                    bestSim = s;
                    break;
                }
                if (s > bestSim)
                    bestSim = s;
            }
            if (bestMatchFound) {
                matched = true;
                break;
            }
        }
        if (matched) {
            matchedKeys.push(key);
            points += weights[key];
        }
    }
    return { points, totalPossible, matchedKeys };
}

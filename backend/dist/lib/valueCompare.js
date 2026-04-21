function normalizeNumberString(s) {
    return s.replace(',', '.').trim();
}
export function parseNumbers(raw) {
    const s = raw.replace(/\s/g, '');
    const matches = s.match(/-?\d+(?:[.,]\d+)?/g);
    if (!matches)
        return [];
    return matches.map((m) => Number(normalizeNumberString(m))).filter((n) => Number.isFinite(n));
}
export function extractRange(raw) {
    const s0 = raw.replace(/\s/g, '').toLowerCase();
    // 0) Combined bounds in one expression, e.g. ">=5и<=9", "не менее 5 и не более 9".
    const combinedA = s0.match(/(?:>=|≥|неменее|нениже|от)\D*(-?\d+(?:[.,]\d+)?)[\s\S]{0,20}?(?:<=|≤|неболее|довключительно|до)\D*(-?\d+(?:[.,]\d+)?)/i);
    if (combinedA) {
        const a = Number(normalizeNumberString(combinedA[1]));
        const b = Number(normalizeNumberString(combinedA[2]));
        if (Number.isFinite(a) && Number.isFinite(b))
            return a <= b ? { min: a, max: b } : { min: b, max: a };
    }
    const combinedB = s0.match(/(?:<=|≤|неболее|довключительно|до)\D*(-?\d+(?:[.,]\d+)?)[\s\S]{0,20}?(?:>=|≥|неменее|нениже|от)\D*(-?\d+(?:[.,]\d+)?)/i);
    if (combinedB) {
        const a = Number(normalizeNumberString(combinedB[1]));
        const b = Number(normalizeNumberString(combinedB[2]));
        if (Number.isFinite(a) && Number.isFinite(b))
            return a <= b ? { min: a, max: b } : { min: b, max: a };
    }
    // 1) Try ranges like "a - b", "a–b", "a—b"
    const rangeMatch = s0.match(/(-?\d+(?:[.,]\d+)?)\s*[-–—]\s*(-?\d+(?:[.,]\d+)?)/);
    if (rangeMatch) {
        const a = Number(normalizeNumberString(rangeMatch[1]));
        const b = Number(normalizeNumberString(rangeMatch[2]));
        if (Number.isFinite(a) && Number.isFinite(b)) {
            return a <= b ? { min: a, max: b } : { min: b, max: a };
        }
    }
    // 2) Patterns like "не более 5", "не выше 5", "не превышает 5", "≤5", "<=5", "до 5"
    const lessOrEqual = s0.match(/(?:<=|≤|<|неболее|невыше|непревышает|небольше|до|менее|меньше)\D*(-?\d+(?:[.,]\d+)?)/i) ??
        s0.match(/(-?\d+(?:[.,]\d+)?)\D*(?:<=|≤|<|менее|меньше)/i);
    if (lessOrEqual) {
        const max = Number(normalizeNumberString(lessOrEqual[1]));
        if (Number.isFinite(max))
            return { min: -Infinity, max };
    }
    // 3) Patterns like "не менее 3", "от 3", "≥3", "не ниже 3", "не меньше 3", "и более 3"
    const greaterOrEqual = s0.match(/(?:>=|≥|>|более|больше|неменее|нижене|неменее|неменьше|нениже|от)\D*(-?\d+(?:[.,]\d+)?)/i) ??
        s0.match(/(-?\d+(?:[.,]\d+)?)\D*(?:>=|≥|>)/i) ??
        s0.match(/(-?\d+(?:[.,]\d+)?)\D*(?:ивыше|более|больше|свыше)\D*/i);
    if (greaterOrEqual) {
        const min = Number(normalizeNumberString(greaterOrEqual[1]));
        if (Number.isFinite(min))
            return { min, max: Infinity };
    }
    // 4) Patterns like "от X до Y"
    const fromTo = s0.match(/от\D*(-?\d+(?:[.,]\d+)?)\D*(?:до|дo|до)\D*(-?\d+(?:[.,]\d+)?)/i);
    if (fromTo) {
        const min = Number(normalizeNumberString(fromTo[1]));
        const max = Number(normalizeNumberString(fromTo[2]));
        if (Number.isFinite(min) && Number.isFinite(max))
            return { min, max };
    }
    return null;
}
export function normalizeTextSimple(s) {
    return s.replace(/\s+/g, ' ').trim().toLowerCase();
}
function tokenizeText(s) {
    return normalizeTextSimple(s)
        .split(/[^a-z0-9а-яё]+/gi)
        .map((t) => t.trim())
        .filter(Boolean);
}
function textMatchFallback(q, l) {
    const qn = normalizeTextSimple(q);
    const ln = normalizeTextSimple(l);
    if (!qn || !ln)
        return { match: false, reason: 'empty values' };
    if (qn === ln)
        return { match: true, reason: 'exact text match' };
    const qTokens = tokenizeText(qn);
    const lTokens = tokenizeText(ln);
    if (qTokens.length === 0 || lTokens.length === 0)
        return { match: false, reason: 'no tokens' };
    // Biological material matching: tolerate list vs single item
    // (e.g. "кровь; сыворотка; плазма" vs "цельная кровь").
    const materialLexemes = ['кров', 'сыворот', 'плазм', 'цельн'];
    const qMaterial = new Set(materialLexemes.filter((x) => qn.includes(x)));
    const lMaterial = new Set(materialLexemes.filter((x) => ln.includes(x)));
    if (qMaterial.size > 0 && lMaterial.size > 0) {
        let interMat = 0;
        for (const m of qMaterial)
            if (lMaterial.has(m))
                interMat++;
        if (interMat > 0)
            return { match: true, reason: 'biological material overlap' };
    }
    const qSet = new Set(qTokens);
    const lSet = new Set(lTokens);
    let inter = 0;
    for (const t of qSet)
        if (lSet.has(t))
            inter++;
    const jaccard = inter / Math.max(1, qSet.size + lSet.size - inter);
    const bothLong = qn.length >= 80 && ln.length >= 80;
    const threshold = bothLong ? 0.12 : 0.85;
    const ok = jaccard >= threshold;
    return { match: ok, reason: ok ? `token overlap jaccard=${jaccard.toFixed(2)}` : `low token overlap jaccard=${jaccard.toFixed(2)}` };
}
function looksTextualWithIncidentalDigits(raw) {
    const s = (raw ?? '').toString();
    const tokens = tokenizeText(s);
    const longText = tokens.length >= 8;
    const letterCount = (s.match(/[a-zа-яё]/gi) ?? []).length;
    const digitCount = (s.match(/\d/g) ?? []).length;
    return longText && letterCount >= 20 && digitCount > 0 && letterCount >= digitCount * 3;
}
/**
 * When one side lists several numbers (e.g. kit sizes "1/10/20/25"), comparing only the first
 * number breaks tender logic: "≥ 25" should match if max(1,10,20,25) ≥ 25.
 * For an upper cap ("не более N"), the worst case is the largest stated value.
 */
function valueSatisfiesLowerBound(nums, min) {
    if (nums.length === 0)
        return false;
    return Math.max(...nums) >= min;
}
/** Upper cap on library/query side: the largest stated value must not exceed max. */
function valuesRespectUpperCap(nums, max) {
    if (nums.length === 0)
        return false;
    return Math.max(...nums) <= max;
}
export function valuesMatch(params) {
    const toleranceRel = params.toleranceRel ?? 0.1; // 10% default
    const toleranceAbs = params.toleranceAbs ?? 0; // optional absolute tolerance
    const q = params.queryValueRaw ?? '';
    const l = params.libraryValueRaw ?? '';
    const qRange = extractRange(q);
    const lRange = extractRange(l);
    const qNumbers = parseNumbers(q);
    const lNumbers = parseNumbers(l);
    const qHasDigits = qNumbers.length > 0 || /[0-9]/.test(q);
    const lHasDigits = lNumbers.length > 0 || /[0-9]/.test(l);
    // If library provides a range, check query first number inside.
    if (lRange && qRange) {
        // Both sides are constraints: query constraint must be fully inside library constraint.
        const ok = qRange.min >= lRange.min && qRange.max <= lRange.max;
        return {
            match: ok,
            reason: ok ? 'query range inside library range' : 'query range outside library range',
        };
    }
    if (lRange && qNumbers.length > 0) {
        // Library constraint vs numeric(s) from query (possibly several SKUs in one cell).
        let ok;
        if (lRange.max === Infinity && Number.isFinite(lRange.min)) {
            ok = valueSatisfiesLowerBound(qNumbers, lRange.min);
        }
        else if (lRange.min === -Infinity && Number.isFinite(lRange.max)) {
            ok = valuesRespectUpperCap(qNumbers, lRange.max);
        }
        else if (Number.isFinite(lRange.min) && Number.isFinite(lRange.max)) {
            const qmin = Math.min(...qNumbers);
            const qmax = Math.max(...qNumbers);
            ok = qmin >= lRange.min && qmax <= lRange.max;
        }
        else {
            const v = qNumbers[0];
            ok = v >= lRange.min && v <= lRange.max;
        }
        return {
            match: ok,
            reason: ok ? 'query within library range' : 'query outside library range',
        };
    }
    // Symmetric case: query constraint with numeric(s) from library.
    // Example: query="≤10", library="10" should match; query="≥25", library="1/10/20/25" uses max.
    if (qRange && lNumbers.length > 0) {
        let ok;
        if (qRange.max === Infinity && Number.isFinite(qRange.min)) {
            ok = valueSatisfiesLowerBound(lNumbers, qRange.min);
        }
        else if (qRange.min === -Infinity && Number.isFinite(qRange.max)) {
            ok = valuesRespectUpperCap(lNumbers, qRange.max);
        }
        else if (Number.isFinite(qRange.min) && Number.isFinite(qRange.max)) {
            const lmin = Math.min(...lNumbers);
            const lmax = Math.max(...lNumbers);
            ok = lmin >= qRange.min && lmax <= qRange.max;
        }
        else {
            const v = lNumbers[0];
            ok = v >= qRange.min && v <= qRange.max;
        }
        return {
            match: ok,
            reason: ok ? 'library within query range' : 'library outside query range',
        };
    }
    // Long textual criteria can include incidental digits (e.g. "ВИЧ 1/2", "HIV1/HIV2").
    // In such cases use text overlap, not strict numeric comparison.
    if (qHasDigits && lHasDigits && looksTextualWithIncidentalDigits(q) && looksTextualWithIncidentalDigits(l)) {
        return textMatchFallback(q, l);
    }
    // If both contain digits, compare numerically (numbers/ranges) only.
    if ((qHasDigits || qRange) && (lHasDigits || lRange) && !qRange && !lRange && qNumbers.length > 0 && lNumbers.length > 0) {
        const qv = qNumbers[0];
        const lv = lNumbers[0];
        const diff = Math.abs(qv - lv);
        const rel = lv !== 0 ? diff / Math.abs(lv) : diff;
        const ok = diff <= toleranceAbs || rel <= toleranceRel;
        return {
            match: ok,
            reason: ok ? 'numbers within tolerance' : `numbers differ (diff=${diff})`,
        };
    }
    // If one side has digits and the other doesn't, treat as mismatch.
    if (qHasDigits !== lHasDigits) {
        return { match: false, reason: 'digits mismatch' };
    }
    // If there are digits but we couldn't parse a number/range match, it's not a match.
    if (qHasDigits && lHasDigits) {
        return { match: false, reason: 'no numeric/range match' };
    }
    // No digits on both sides => compare normalized tokens with strict overlap.
    return textMatchFallback(q, l);
}

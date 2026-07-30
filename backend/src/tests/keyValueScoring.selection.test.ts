import test from 'node:test'
import assert from 'node:assert/strict'
import { matchKeyValueRowPair, scoreKeyValueIndicators } from '../lib/keyValueScoring.js'

type TestRow = {
  indicator: string
  valueRaw: string
  embedding: number[]
}

const medicalLibraryRows: TestRow[] = [
  {
    indicator: 'Исследуемый материал',
    valueRaw: 'сыворотка крови',
    embedding: [1, 0, 0],
  },
  {
    indicator: 'Количество выполняемых тестов',
    valueRaw: 'не менее 20',
    embedding: [0, 1, 0],
  },
]

test('selects deduplicated medical criteria ahead of noisy leading rows', () => {
  const leadingEligibleNumericNoise: TestRow[] = Array.from({ length: 24 }, (_, index) => ({
    indicator: `Дополнительный показатель ${index + 1}`,
    valueRaw: `${index + 1}`,
    embedding: [0, 0, 1],
  }))
  const queryRows: TestRow[] = [
    { indicator: '№', valueRaw: '1', embedding: [0, 0, 1] },
    {
      indicator: 'Наименование показателя',
      valueRaw: 'Значение показателя',
      embedding: [0, 0, 1],
    },
    {
      indicator: 'Обоснование включения характеристики',
      valueRaw: 'В соответствии со статьёй 33 44-ФЗ',
      embedding: [0, 0, 1],
    },
    {
      indicator: '<tr><td>Характеристика</td></tr>',
      valueRaw: '<td>10</td>',
      embedding: [0, 0, 1],
    },
    { indicator: 'Код ОКПД2', valueRaw: '21.20.23.110', embedding: [0, 0, 1] },
    ...leadingEligibleNumericNoise,
    { indicator: 'Ширина транспортной упаковки', valueRaw: '10 мм', embedding: [0, 0, 1] },
    { indicator: 'Высота транспортной упаковки', valueRaw: '20 мм', embedding: [0, 0, 1] },
    {
      indicator: 'Исследуемый материал',
      valueRaw: 'сыворотка крови',
      embedding: [1, 0, 0],
    },
    {
      indicator: '  ИССЛЕДУЕМЫЙ   МАТЕРИАЛ ',
      valueRaw: ' Сыворотка   крови ',
      embedding: [1, 0, 0],
    },
    {
      indicator: 'Количество выполняемых тестов',
      valueRaw: 'не менее 20',
      embedding: [0, 1, 0],
    },
  ]

  const result = scoreKeyValueIndicators({
    queryRows,
    libraryRows: medicalLibraryRows,
    indicatorSimilarityThreshold: 0.95,
    valueToleranceRel: 0,
    valueToleranceAbs: 0,
    maxKeyRows: 2,
  })

  assert.equal(result.totalPossible, 2)
  assert.equal(result.points, 2)
  assert.deepEqual(result.matchedIndicators, ['Исследуемый материал', 'Количество выполняемых тестов'])
})

test('excludes transport packaging dimensions from medical criteria', () => {
  const packagingRows: TestRow[] = [
    { indicator: 'Ширина транспортной упаковки', valueRaw: '10 мм', embedding: [0, 1] },
    { indicator: 'Высота упаковки', valueRaw: '20 мм', embedding: [0, 1] },
    { indicator: 'Габариты транспортной упаковки', valueRaw: '10 x 20 x 30 см', embedding: [0, 1] },
  ]
  const sensitivity: TestRow = {
    indicator: 'Аналитическая чувствительность',
    valueRaw: '99 нг/мл',
    embedding: [1, 0],
  }

  const result = scoreKeyValueIndicators({
    queryRows: [...packagingRows, sensitivity],
    libraryRows: [...packagingRows, sensitivity],
    indicatorSimilarityThreshold: 0.95,
    valueToleranceRel: 0,
    valueToleranceAbs: 0,
  })

  assert.equal(result.totalPossible, 1)
  assert.equal(result.points, 1)
  assert.deepEqual(result.matchedIndicators, ['Аналитическая чувствительность'])
})

test('prioritizes medical result time over earlier generic numeric criteria', () => {
  const result = scoreKeyValueIndicators({
    queryRows: [
      { indicator: 'Дополнительный показатель', valueRaw: '10', embedding: [0, 1] },
      { indicator: 'Время получения результата', valueRaw: 'не более 20 минут', embedding: [1, 0] },
    ],
    libraryRows: [
      { indicator: 'Дополнительный показатель', valueRaw: '10', embedding: [0, 1] },
      { indicator: 'Время получения результата', valueRaw: '20 минут', embedding: [1, 0] },
    ],
    indicatorSimilarityThreshold: 0.95,
    valueToleranceRel: 0,
    valueToleranceAbs: 0,
    maxKeyRows: 1,
  })

  assert.equal(result.totalPossible, 1)
  assert.equal(result.points, 1)
  assert.deepEqual(result.matchedIndicators, ['Время получения результата'])
})

test('counts a normalized duplicate only once', () => {
  const queryRows: TestRow[] = [
    {
      indicator: 'Аналитическая чувствительность',
      valueRaw: 'не менее 99 нг/мл',
      embedding: [1, 0],
    },
    {
      indicator: '  аналитическая   ЧУВСТВИТЕЛЬНОСТЬ ',
      valueRaw: ' НЕ МЕНЕЕ 99   НГ/МЛ ',
      embedding: [1, 0],
    },
  ]
  const libraryRows: TestRow[] = [
    {
      indicator: 'Аналитическая чувствительность',
      valueRaw: '99 нг/мл',
      embedding: [1, 0],
    },
  ]

  const result = scoreKeyValueIndicators({
    queryRows,
    libraryRows,
    indicatorSimilarityThreshold: 0.95,
    valueToleranceRel: 0,
    valueToleranceAbs: 0,
  })

  assert.equal(result.totalPossible, 1)
  assert.equal(result.points, 1)
  assert.equal(result.matchedIndicators.length, 1)
  assert.ok(result.points / result.totalPossible <= 1)
})

test('keeps an incompatible medical parameter unmatched when criteria are limited', () => {
  const queryRows: TestRow[] = [
    { indicator: 'Ширина транспортной упаковки', valueRaw: '10 мм', embedding: [0, 1] },
    {
      indicator: 'Аналитическая чувствительность',
      valueRaw: '≥ 99 нг/мл',
      embedding: [1, 0],
    },
  ]
  const libraryRows: TestRow[] = [
    { indicator: 'Ширина транспортной упаковки', valueRaw: '10 мм', embedding: [0, 1] },
    {
      indicator: 'Аналитическая чувствительность',
      valueRaw: '80 нг/мл',
      embedding: [1, 0],
    },
  ]

  const result = scoreKeyValueIndicators({
    queryRows,
    libraryRows,
    indicatorSimilarityThreshold: 0.95,
    valueToleranceRel: 0,
    valueToleranceAbs: 0,
    maxKeyRows: 1,
  })

  assert.equal(result.totalPossible, 1)
  assert.equal(result.points, 0)
  assert.deepEqual(result.matchedIndicators, [])
})

test('keeps incompatible units unmatched in coarse and refinement summary', async () => {
  const scoringModule = await import('../lib/keyValueScoring.js')
  const matchKeyValueRowPair = (
    scoringModule as unknown as {
      matchKeyValueRowPair?: (params: {
        queryRow: TestRow
        libraryRow: TestRow
        indicatorSimilarityThreshold: number
        valueToleranceRel: number
        valueToleranceAbs: number
      }) => {
        indicatorOk: boolean
        valueMatch: boolean
        rowMatched: boolean
      }
    }
  ).matchKeyValueRowPair

  assert.equal(typeof matchKeyValueRowPair, 'function')
  if (!matchKeyValueRowPair) return

  const queryRow: TestRow = {
    indicator: 'Аналитическая чувствительность',
    valueRaw: '99 нг/мл',
    embedding: [1, 0],
  }
  const libraryRow: TestRow = {
    indicator: 'Аналитическая чувствительность',
    valueRaw: '99%',
    embedding: [1, 0],
  }
  const pairResult = matchKeyValueRowPair({
    queryRow,
    libraryRow,
    indicatorSimilarityThreshold: 0.95,
    valueToleranceRel: 0,
    valueToleranceAbs: 0,
  })
  const coarseResult = scoreKeyValueIndicators({
    queryRows: [queryRow],
    libraryRows: [libraryRow],
    indicatorSimilarityThreshold: 0.95,
    valueToleranceRel: 0,
    valueToleranceAbs: 0,
  })
  const summary = scoringModule.calculateCappedMatchSummary({
    scoredMatchedCount: coarseResult.points,
    refinedMatchedCount: pairResult.rowMatched ? 1 : 0,
    totalCount: coarseResult.totalPossible,
  })

  assert.equal(pairResult.indicatorOk, true)
  assert.equal(pairResult.valueMatch, false)
  assert.equal(pairResult.rowMatched, false)
  assert.equal(coarseResult.points, 0)
  assert.deepEqual(summary, { matchedCount: 0, matchPercent: 0 })
})

test('does not match identical result time numbers expressed in different unit families', () => {
  const incompatibleUnits = [
    ['10 секунд', '10 мин.'],
    ['10 минут', '10 часов'],
    ['10 ч.', '10 дн.'],
    ['10 часов', '10 дней'],
  ]

  for (const [queryValueRaw, libraryValueRaw] of incompatibleUnits) {
    const queryRow: TestRow = {
      indicator: 'Время получения результата',
      valueRaw: queryValueRaw,
      embedding: [1, 0],
    }
    const libraryRow: TestRow = {
      indicator: 'Время получения результата',
      valueRaw: libraryValueRaw,
      embedding: [1, 0],
    }
    const pairResult = matchKeyValueRowPair({
      queryRow,
      libraryRow,
      indicatorSimilarityThreshold: 0.95,
      valueToleranceRel: 0,
      valueToleranceAbs: 0,
    })
    const coarseResult = scoreKeyValueIndicators({
      queryRows: [queryRow],
      libraryRows: [libraryRow],
      indicatorSimilarityThreshold: 0.95,
      valueToleranceRel: 0,
      valueToleranceAbs: 0,
    })

    assert.equal(pairResult.unitsMatch, false, `${queryValueRaw} must not match ${libraryValueRaw}`)
    assert.equal(pairResult.rowMatched, false)
    assert.equal(coarseResult.totalPossible, 1)
    assert.equal(coarseResult.points, 0)
  }
})

test('keeps meaningful non-numeric medical text criteria', () => {
  const methodRow: TestRow = {
    indicator: 'Метод исследования',
    valueRaw: 'иммуноферментный',
    embedding: [1, 0],
  }
  const result = scoreKeyValueIndicators({
    queryRows: [methodRow],
    libraryRows: [methodRow],
    indicatorSimilarityThreshold: 0.95,
    valueToleranceRel: 0,
    valueToleranceAbs: 0,
  })

  assert.equal(result.totalPossible, 1)
  assert.equal(result.points, 1)
  assert.deepEqual(result.matchedIndicators, ['Метод исследования'])
})

test('caps final matched count and percent at total criteria', async () => {
  const scoringModule = await import('../lib/keyValueScoring.js')
  const calculateCappedMatchSummary = (
    scoringModule as unknown as {
      calculateCappedMatchSummary?: (params: {
        scoredMatchedCount: number
        refinedMatchedCount: number
        totalCount: number
      }) => { matchedCount: number; matchPercent: number }
    }
  ).calculateCappedMatchSummary

  assert.equal(typeof calculateCappedMatchSummary, 'function')
  if (!calculateCappedMatchSummary) return

  assert.deepEqual(
    calculateCappedMatchSummary({
      scoredMatchedCount: 2,
      refinedMatchedCount: 5,
      totalCount: 2,
    }),
    { matchedCount: 2, matchPercent: 100 },
  )
})

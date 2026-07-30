import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractDiseaseMarkerLabelsFromText,
  extractDiseaseMarkersFromRows,
  extractDiseaseMarkersFromText,
} from '../lib/diseaseMarkers.js'
import { extractInfectionMarkerRowsFromText } from '../lib/rows.js'

test('extracts canonical disease markers from diagnostic text', () => {
  const text = [
    'Антитела к Treponema pallidum (сифилис).',
    'Антитела к ВИЧ-1 и ВИЧ-2.',
    'Поверхностный антиген HBsAg вируса гепатита B (HBV).',
    'Антитела к вирусу гепатита C (HCV).',
  ].join('\n')

  assert.deepEqual(extractDiseaseMarkersFromText(text), [
    'treponema',
    'hiv',
    'hbv',
    'hcv',
  ])
})

test('ignores markers listed only in a negative cross-reactivity context', () => {
  const text =
    'Отсутствие перекрестной реактивности: HBV, HCV, HSV, Treponema pallidum.'

  assert.deepEqual(extractDiseaseMarkersFromText(text), [])
})

test('ignores pathogen abbreviations in an absent cross-reactivity clause', () => {
  assert.deepEqual(
    extractDiseaseMarkersFromText(
      'Отсутствие перекрестной реактивности с возбудителями HBV и HCV',
    ),
    [],
  )
})

test('ignores HBsAg in a negative antigen cross-reactivity clause', () => {
  assert.deepEqual(
    extractDiseaseMarkersFromText(
      'Перекрестная реактивность с антигеном HBsAg не обнаружена',
    ),
    [],
  )
})

test('ignores an explicit hepatitis type in a negative antibody cross-reactivity clause', () => {
  assert.deepEqual(
    extractDiseaseMarkersFromText(
      'Перекрестная реактивность с антителами к вирусу гепатита B отсутствует',
    ),
    [],
  )
})

test('does not treat Russian prepositions after hepatitis as B or C disease letters', () => {
  const text = [
    'Исследование вируса гепатита в крови пациента.',
    'Определение вируса гепатита с помощью ИФА.',
  ].join('\n')

  assert.deepEqual(extractDiseaseMarkersFromText(text), [])
})

test('keeps unambiguous Russian and Latin hepatitis disease letters and abbreviations', () => {
  assert.deepEqual(
    extractDiseaseMarkersFromText([
      'Диагностика вирусного гепатита В.',
      'Диагностика вирусного гепатита B.',
      'Диагностика вирусного гепатита С.',
      'Диагностика вирусного гепатита C.',
    ].join('\n')),
    ['hbv', 'hcv'],
  )
  assert.deepEqual(extractDiseaseMarkersFromText('HBV, HBsAg, HCV'), ['hbv', 'hcv'])
})

test('keeps a diagnostic HIV target while ignoring HBV and HCV cross-reactivity mentions', () => {
  const text = [
    'Набор предназначен для выявления антител к ВИЧ-1 и ВИЧ-2.',
    'Отсутствие перекрестной реактивности: HBV, HCV, HSV и другие инфекции.',
  ].join('\n')

  assert.deepEqual(extractDiseaseMarkersFromText(text), ['hiv'])
})

test('keeps a genuine target after a non-target phrase in the same punctuation segment', () => {
  const text =
    'Перекрестная реактивность отсутствует, набор предназначен для выявления антител к ВИЧ-1'

  assert.deepEqual(extractDiseaseMarkersFromText(text), ['hiv'])
})

test('keeps an HIV product target before a cross-reactivity clause using the short for-purpose form', () => {
  const text =
    'Набор для выявления антител к ВИЧ-1 и ВИЧ-2, перекрестная реактивность с HBV отсутствует'

  assert.deepEqual(extractDiseaseMarkersFromText(text), ['hiv'])
})

test('keeps an HBsAg product target before an HCV cross-reactivity clause', () => {
  const text =
    'Тест-система для определения HBsAg, перекрестная реактивность с HCV отсутствует'

  assert.deepEqual(extractDiseaseMarkersFromText(text), ['hbv'])
})

test('keeps an HIV product target after cross-reactivity using the short for-purpose form', () => {
  const text =
    'Перекрестная реактивность отсутствует, набор для выявления антител к ВИЧ-1 и ВИЧ-2'

  assert.deepEqual(extractDiseaseMarkersFromText(text), ['hiv'])
})

test('extracts markers from rows using each row context', () => {
  const rows = [
    {
      indicator: 'Назначение',
      valueRaw: 'Выявление антител к ВИЧ-1 и ВИЧ-2',
    },
    {
      indicator: 'Специфичность',
      valueRaw: 'Отсутствие перекрестной реактивности: HBV, HCV',
    },
  ]

  assert.deepEqual(extractDiseaseMarkersFromRows(rows), ['hiv'])
})

test('does not build a combined infection marker row for an HIV-1-only target', () => {
  const text = 'Набор только для выявления антител к ВИЧ-1'
  const rows = extractInfectionMarkerRowsFromText(text)

  assert.deepEqual(extractDiseaseMarkerLabelsFromText(text), ['ВИЧ 1'])
  assert.deepEqual(rows, [])
})

test('does not build a combined infection marker row for an HIV-2-only target', () => {
  const text = 'Набор только для выявления антител к ВИЧ-2'
  const rows = extractInfectionMarkerRowsFromText(text)

  assert.deepEqual(extractDiseaseMarkerLabelsFromText(text), ['ВИЧ 2'])
  assert.deepEqual(rows, [])
})

test('builds the combined infection marker row when both HIV subtypes are targets', () => {
  const text = 'Набор для выявления антител к ВИЧ-1 и ВИЧ-2.'
  const rows = extractInfectionMarkerRowsFromText(text)

  assert.deepEqual(extractDiseaseMarkerLabelsFromText(text), ['ВИЧ 1', 'ВИЧ 2'])
  assert.deepEqual(rows, [
    {
      indicator: 'Выявление маркеров инфекционных заболеваний',
      valueRaw: 'ВИЧ 1; ВИЧ 2',
    },
  ])
})

test('builds legacy HIV labels without cross-reactivity markers', () => {
  const text = [
    'Набор для выявления антител к ВИЧ-1 и ВИЧ-2.',
    'Отсутствие перекрестной реактивности: HBV, HCV.',
  ].join('\n')
  const rows = extractInfectionMarkerRowsFromText(text)

  assert.deepEqual(extractDiseaseMarkerLabelsFromText(text), ['ВИЧ 1', 'ВИЧ 2'])
  assert.deepEqual(rows, [
    {
      indicator: 'Выявление маркеров инфекционных заболеваний',
      valueRaw: 'ВИЧ 1; ВИЧ 2',
    },
  ])
})

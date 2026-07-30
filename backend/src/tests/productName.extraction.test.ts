import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractNormalizedProductNamesFromRows,
  normalizeText,
} from '../lib/productName.js'

test('extracts product text paired with an OKPD2 code after rejecting table headers', () => {
  const productName =
    'Набор реагентов для выявления антител к вирусу иммунодефицита человека типов 1 и 2 (ВИЧ-1, ВИЧ-2) методом иммунохроматографии'
  const headerValues = [
    'Характеристики товара',
    'Кол-во товара',
    'Примечание',
    'Наименование характеристики',
    'Инструкция по заполнению характеристик в заявке',
    'Обоснование дополнительных характеристик',
    'ОКПД2/ Код позиции КТРУ',
    'Наименование товара',
    '21.20.23.111',
  ]
  const rows = [
    ...headerValues.map((valueRaw) => ({
      indicator: 'Наименование товара',
      valueRaw,
    })),
    {
      indicator: '21.20.23.111',
      valueRaw: productName,
    },
  ]

  const result = extractNormalizedProductNamesFromRows(rows)

  assert.equal(result[0], normalizeText(productName))
  for (const header of headerValues) {
    assert.ok(!result.includes(normalizeText(header)))
  }
})

test('rejects annotated and combined product table headers', () => {
  const productName =
    'Набор реагентов для выявления антител к ВИЧ-1 и ВИЧ-2 методом иммунохроматографии'
  const rows = [
    {
      indicator: 'Наименование товара',
      valueRaw: 'Кол-во товара, шт.',
    },
    {
      indicator: 'Наименование товара',
      valueRaw: 'Наименование товара / характеристики',
    },
    {
      indicator: 'Наименование товара',
      valueRaw: 'Примечание (заполняется участником закупки)',
    },
    {
      indicator: '21.20.23.111',
      valueRaw: productName,
    },
  ]

  const result = extractNormalizedProductNamesFromRows(rows)

  assert.deepEqual(result, [normalizeText(productName)])
})

test('rejects the optional-service annotation before an OKPD2 product row', () => {
  const productName =
    'Набор реагентов для выявления антител к вирусу иммунодефицита человека типов 1 и 2 (ВИЧ-1, ВИЧ-2) методом иммунохроматографии'
  const rows = [
    {
      indicator: 'Наименование товара',
      valueRaw: '(при необходимости)',
    },
    {
      indicator: '21.20.23.111',
      valueRaw: productName,
    },
  ]

  const result = extractNormalizedProductNamesFromRows(rows)

  assert.deepEqual(result, [normalizeText(productName)])
})

test('keeps extracting a product from a regular product-name row', () => {
  const productName = 'Набор реагентов для определения антител к ВИЧ-1 и ВИЧ-2'

  const result = extractNormalizedProductNamesFromRows([
    {
      indicator: 'Наименование товара',
      valueRaw: productName,
    },
  ])

  assert.equal(result[0], normalizeText(productName))
})

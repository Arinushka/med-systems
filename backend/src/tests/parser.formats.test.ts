import test from 'node:test'
import assert from 'node:assert/strict'
import { extractTextFromFile } from '../lib/extract.js'
import { extractRowsFromFile } from '../lib/rows.js'

const cases: Array<{ filename: string; content: string }> = [
  { filename: 'sample.txt', content: 'Наименование товара: Тест\nАртикул: PCT-100' },
  { filename: 'sample.csv', content: 'indicator,value\nНаименование товара,Тест\nАртикул,PCT-100' },
  { filename: 'sample.html', content: '<h1>Описание</h1><p>Наименование товара: Тест</p><p>Артикул: PCT-100</p>' },
  { filename: 'sample.json', content: '{"name":"Тест","article":"PCT-100","meta":{"section":"Описание"}}' },
  { filename: 'sample.xml', content: '<?xml version="1.0"?><root><name>Тест</name><article>PCT-100</article></root>' },
]

for (const c of cases) {
  test(`extract supports ${c.filename}`, async () => {
    const buffer = Buffer.from(c.content, 'utf8')
    const text = await extractTextFromFile({ buffer, filename: c.filename })
    assert.ok(text.length > 0)
    const rows = await extractRowsFromFile({ buffer, filename: c.filename })
    assert.ok(rows.length > 0)
  })
}

import { readFileSync } from 'node:fs'
import { extractRowsFromFile } from './src/lib/rows.ts'
import { extractNormalizedProductNamesFromRows } from './src/lib/productName.ts'

for (const f of ['c:/Users/User/Downloads/-TREPO~1.DOC','c:/Users/User/Downloads/260504~2.DOC']) {
  const rows = await extractRowsFromFile({ buffer: readFileSync(f), filename: f })
  const names = extractNormalizedProductNamesFromRows(rows as any)
  console.log('\n===', f, 'rows=', rows.length)
  console.log('names=', names)
  for (const r of rows.filter(x => /treponema|syph|сифил|наименование|упаков|isyp/i.test((x.indicator||'')+' '+(x.valueRaw||''))).slice(0,60)) {
    console.log('-', r.indicator, '=>', r.valueRaw)
  }
}

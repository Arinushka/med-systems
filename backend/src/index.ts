import dotenv from 'dotenv'
import nodemailer from 'nodemailer'

import express from 'express'
import cors from 'cors'
import multer from 'multer'
import crypto from 'node:crypto'
import path from 'node:path'
import https from 'node:https'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'

import { embedTexts } from './lib/openaiEmbeddings.js'
import { centroid } from './lib/centroid.js'
import { cosineSimilarity } from './utils/cosine.js'
import { extractRowsFromFile } from './lib/rows.js'
import { extractTextFromFile } from './lib/extract.js'
import { loadIndex, saveIndex, type LibraryDoc, type LibraryFolder } from './lib/indexStore.js'
import { valuesMatch } from './lib/valueCompare.js'
import { compareProductNamesWithOllama, judgeMatch, type RowForJudge, type JudgeDecision } from './lib/judge.js'
import {
  compositionLongTextFallbackMatch,
  indicatorsLookKeywordSimilar,
  isExcludedFromParameterMatch,
  scoreKeyValueIndicators,
  tenderAliasesAllowValueCompare,
} from './lib/keyValueScoring.js'
import { extractNormalizedProductNamesFromRows } from './lib/productName.js'
import { createMatchingRuntime } from './matching/factory.js'

const app = express()
const MATCH_NOTIFY_EMAIL = 'arina.mykhova@yandex.ru'
const matchingRuntime = createMatchingRuntime()

type TenderKeyEnrichment = {
  Text: string[]
  Exclude: string[]
}

const TENDER_KEY_ENRICHMENTS: Record<string, TenderKeyEnrichment> = {
  'прокальцитонин общий': {
    Text: ['прокальцитонин*', 'сепсис*', 'brahms pct'],
    Exclude: [
      'посуд*',
      'антигололедн*',
      'диски',
      'оказан* услуг*',
      'монтаж*',
      'ремонт*',
      'канцтовар*',
      'канцелярск*',
      'канц-товар*',
      'вакцин',
      'продукт* питан*',
      'тестер',
      'наконечник*',
      'пробирки',
      'ПЦР',
      'литератур*',
      'противогололедн*',
      'стоматолог*',
      'выполнен* услуг*',
      'RAMP',
      '(easy reader)',
      'getein',
      '(иммунофлуоресцентн* анализ*)~2',
      'иммунохемилюминесцентн*',
      '(ам 770)',
      'ам770',
      'maglumi',
    ],
  },
  'фобы общий': {
    Text: [
      'скрыт* кров*',
      'кров* кал*',
      'определен* гемоглобин*',
      'выявлен* гемоглобин*',
      'fob',
      'кров* фекал*',
      'кров* в кал* ИВД',
      'кров* ИВД',
    ],
    Exclude: [
      'посуд*',
      'антигололедн*',
      'диски',
      'услуг*',
      'монтаж*',
      'ремонт*',
      'канцтовар*',
      'канцелярск*',
      'канц-товар*',
      'вакцин',
      'продукт* питан*',
      'тестер',
      'наконечник*',
      'пробирки',
      'ПЦР',
      'литератур*',
      'противогололедн*',
      'стоматолог*',
      'таблетки*',
      'раствор* инфуз*',
      'крупа',
      'раствор* инъекц*',
      'чип-сенсор*',
      'fob порт',
      'благоустроенная квартира',
      'щебня',
      '(язык* говя*)',
      '(анализатор* bs)~1',
      '(мебел* офис*)~2',
      '(лекарствен* препарат*)~1',
      '(мяс* птиц*)~1',
      'цитофлуориметр*',
      '(getein 1100)',
      'getein',
      '(easy reader)',
      '(иммунофлуоресцентн* анализ*)~2',
      'i-stat',
      '(Gem Premier)',
      'furuno',
      '(ABL 800)~1',
      'easyreader',
      'vitaline',
      'NS-PRIME',
      '(кабельн* продукц*)~2',
      'РЕФЛЕКОМ',
      'АМ900',
      '(ам-900)',
      '(кроват* металл*)~2',
      '(Mindray BS)~2',
      '(Mindray BC)~2',
    ],
  },
  'тесты для кдл': {
    Text: [
      'реагент* "КДЛ"',
      'Прокальцитон*',
      'тест* "КДЛ"',
      'Регаен* для КДЛ',
      'тест* для КДЛ',
      'реактив* для КДЛ',
      'азур-эозин',
      'реактив* для лаборатор*',
    ],
    Exclude: [
      'scangel',
      'alinity',
      '(cobas 6000)~1',
      '(иммунохемилюминесцент* анализ*)~1',
      '(easy reader)',
      '(лабораторн* мебел*)~1',
      '(определ* иммун* статус*)~3',
      '(анализатор* AQT90)',
      '(иммунофлуоресцентн* анализ*)~2',
      '(Gem Premier)',
      '(анализ* ACL)~2',
      '(анализатор* электролит*)~5',
      '(поставк* пцр исследован*)~5',
      '(оказание услуг)',
      'access',
      '(Sysmex XN-1000)',
      'ramp',
      'fus-2000',
      '(fus 2000)~1',
      '(Mindray BS)~2',
      '(Mindray BC)~2',
      'MAGLUMI',
      'Radiometr*',
      'услуг*',
      'охран*',
      'бенз*',
      'работ*',
      'молоко',
      'услуг*',
      'работ*',
      'услуги',
    ],
  },
  'ковид общий': {
    Text: [
      'ковид*',
      'sars-cov-2',
      'sars-cov',
      'covid',
      'антиген* ковид*',
      'covid-19',
      'коронавирус*',
    ],
    Exclude: [
      'посуд*',
      'антигололедн*',
      'диски',
      'услуг*',
      'монтаж*',
      'ремонт*',
      'канцтовар*',
      'канцелярск*',
      'канц-товар*',
      'вакцин',
      'продукт* питан*',
      'тестер',
      'наконечник*',
      'пробирки',
      'ПЦР',
      'литератур*',
      'противогололедн*',
      'стоматолог*',
      'таблетки*',
      'раствор* инфуз*',
      'крупа',
      'раствор* инъекц*',
      'полиграфическ*',
      '(getein 1100)',
      'getein',
      'MAGLUMI',
    ],
  },
  'инфекции общий': {
    Text: [
      'вирус* гепатит*',
      'антиген* гепатит*',
      'антител* гепатит*',
      'ВИЧ1/ВИЧ2',
      'иммунохром* ВИЧ',
      'иммунохром* гепатит*',
      'антител* ВИЧ',
      'HIV1',
      'вирус* спид*',
      'вирус* иммунодефицит*',
      'Treponema pallidum иммухром*',
      'иммунохром* сифилис*',
      'иммунохром* пса',
      'антиген* пса',
      'антиген* psa',
      'иммунохром* psa',
      'антител* спид*',
      'Общ* простатическ* специфическ* антиген* (ПСА)',
      'Вирус* гепатит* В поверхностн* антиген* "ИВД"',
      'Вирус* гепатит* С общи* антител* "ИВД"',
      'Treponema pallidum общ* антител* "ИВД"',
      'ВИЧ2 антител* "ИВД"',
      'Общ* простатическ* специфическ* антиген* (ПСА) "ИВД"',
      'Общ* простатическ* специфическ* антиген* "ПСА"',
      'ВИЧ1 антител* "ИВД"',
      '"ВИЧ 1" антител* "ИВД"',
      '"ВИЧ-1" антител* "ИВД"',
      '"ВИЧ 2" антител* "ИВД"',
      '"ВИЧ-2" антител* "ИВД"',
      'Общ* простатическ* специфическ* антиген* "ПСА" "ИВД"',
    ],
    Exclude: [
      'посуд*',
      'антигололедн*',
      'диски',
      'оказан* услуг*',
      'монтаж*',
      'ремонт*',
      'канцтовар*',
      'канцелярск*',
      'канц-товар*',
      'вакцин',
      'продукт* питан*',
      'тестер',
      'наконечник*',
      'пробирки',
      'ПЦР',
      'литератур*',
      'противогололедн*',
      'стоматолог*',
      'таблетки*',
      'раствор* инфуз*',
      'крупа',
      'раствор* инъекц*',
      'полиграфическая продукция',
      'лекарствен* препарат*',
      'бланк*',
      'груз* автомобил*',
      'грузов* транспорт*',
      'запасн* част*',
      'выполнен* услуг*',
      'ARCHITECT*',
      'alinity',
      '(иммунофлуоресцентн* анализ*)~2',
      '(иммунохемилюминесцент* анализ*)~2',
      '(Cobas TaqMan)',
      '(easy reader)',
    ],
  },
  'кардио и наркотики общий': {
    Text: [
      'кардиотест*',
      'кардиопанел*',
      'кардиомаркер*',
      'наркот* анализ*',
      'наркопанел*',
      'наркотест*',
      'наркот* тест*',
      'наркотическ* соединен*',
      'множественн* наркот*',
      'наркот* веществ*',
      'мультитест*',
      'иммунохром* наркот*',
      'тропонин*',
      'тропонинп*',
      'иммунохром* Тропонин I',
      'Тропонин I ИВД',
      'инфаркт* миокард*',
      'Множествен* маркер* сердечно-сосудист* заболеван* "ИВД"',
      'D-димер* "ИВД"',
      'D-димер*',
      'Д-димер*',
      'иммунохром* D-димер*',
      'D-dimer*',
      'Множествен* маркер* сердечнососудист* заболеван* "ИВД"',
      'Множествен* маркер* сердечн* сосудист* заболеван* "ИВД"',
      '("D" димер* "ИВД")~5',
      '("Д" димер* "ИВД")~5',
      '("Д" димер*)~2',
      '("D" димер*)~2',
      'бензодиаз* иммунохром*',
      'метадон* иммунохром*',
      'амфетамин* иммунохром*',
      'метамфетам* иммунохром*',
      'кокаин* иммунохром*',
      'морфин* иммунохром*',
      'Тропонин I ИВД',
      'вид* наркот*',
      'инфаркт* миокард*',
      'синтетическ* наркот*',
    ],
    Exclude: [
      'посуд*',
      'антигололедн*',
      'оказан* услуг*',
      'монтаж*',
      'ремонт*',
      'канцтовар*',
      'канцелярск*',
      'канц-товар*',
      'вакцин',
      'продукт* питан*',
      'тестер',
      'наконечник*',
      'пробирки',
      'ПЦР',
      'литератур*',
      'противогололедн*',
      'стоматолог*',
      'таблетки*',
      'раствор* инфуз*',
      'крупа',
      'раствор* инъекц*',
      'полиграфическая продукция',
      'лекарствен* препарат*',
      'бланк*',
      'запасн* част*',
      'выполнен* услуг*',
      'благоустройств*',
      'pathfast',
      '(сармат СВ)',
      '(easy reader)',
      '(АМ-900)',
      '(getein 1100)',
      'getein',
      '(иммунофлуоресцентн* анализ*)~2',
      'рефлеком',
      '(иммунохемилюминесцент* анализ*)~2',
      '(Technology Solution)',
      '(анализ* ACL)',
      'сармат',
      'ramp',
      '(ам 770)',
      'ам770',
      '(Mindray BS)~2',
      '(Mindray BC)~2',
      '(CL-1200i)',
    ],
  },
  'кишечные вирусы': {
    Text: [
      'аденовирус*',
      'ротавирус*',
      'ротовирус*',
      'анализ* кал*',
      'скрининг* кал*',
      'Ротавирус антигены ИВД',
      'иммухром* фекал*',
      'аденавирус',
      'Множественн* вирус* желудочно-кишечн* тракт*',
      'энтеровирус',
    ],
    Exclude: [
      'посуд*',
      'антигололедн*',
      'диски',
      'оказан* услуг*',
      'монтаж*',
      'ремонт*',
      'канцтовар*',
      'канцелярск*',
      'канц-товар*',
      'вакцин',
      'продукт* питан*',
      'тестер',
      'наконечник*',
      'пробирки',
      'ПЦР',
      'литератур*',
      'противогололедн*',
      'стоматолог*',
      'таблетки*',
      'раствор* инфуз*',
      'крупа',
      'раствор* инъекц*',
      'полиграфическая продукция',
      'лекарствен* препарат*',
      'бланк*',
      'груз* автомобил*',
      'грузов* транспорт*',
      'запасн* част*',
      'выполнен* услуг*',
      'скрыт* кров*',
      'калибровк*',
      'поверк*',
      'Architect',
      'вод* бутилированн*',
      'вода* питьев*',
      '(лакокрасочн* продукц*)',
      '(поставк* утеплител*)',
      '(поставк* топлив*)',
      '(Beckman Coulter)',
      '(cobas 8000)',
      '(vitaray 150)',
      '(иммунохемилюминесцентн* анализ*)~2',
      'easylite',
      '(поставк* угл*)~1',
      '(cobas e 411)',
      '(cobas e411)',
      'alinity',
      '(Mindray ВS-800)',
      'humastar',
      '(Gem Premier)',
      'furuno',
      '(анализ* ACL)~2',
      '(ABL 800)~1',
      '(immulite-2000)',
      '(sta compact)',
      '(super GL)',
      '(Technology Solution)',
      '(DIRUI CS-300B)',
      'lifotronic',
      'рефлеком',
      'ам900',
      '(ам-900)',
      'accent',
      '(Mindray BS)~2',
      '(Mindray BC)~2',
      '(ba-400)~2',
      '(destiny plus)',
      'fus-2000',
      '(fus 2000)~1',
      '(AU 480)',
      'MAGLUMI',
      '(CL-1200i)',
      '(Коа Тест-4)',
      '(КоаТест-4)',
      'Radiometr',
      '(easy reader)',
    ],
  },
  тесты: {
    Text: [
      'экспресс-тест*',
      'экспресс тест*',
      'тест* лабораторн*',
      'тест* лаборатор*',
      'тест-систем*',
      'тест* систем*',
      'ручн* тест*',
      'ручн* методик*',
      'ручн* определен*',
      'визуальн* тест*',
      'визуальн* определен*',
      'визуальн* метод*',
      'тест* клиническ*',
      'тест* клиник*',
      'экспресс* определен*',
      'экспресс* метод*',
      'тест* иммунохром*',
      'иммунохром* анализ*',
      'ИХА',
      'иммунохром* тест*',
      'иммунохром* определен*',
      'инфекц* определен*',
      'инфекц* тест*',
      'тест-картридж*',
      'тест* картридж*',
      'тест* кассет*',
      'тест-кассет*',
      'онкомаркаркер*',
      'тест-полос*',
      'тест* полос*',
      'реагент* лаборатор*',
      'набор* реагент*',
      'расходн* лаборатор*',
      'расходн* материал* лаборатор*',
      'материал* клинико-диагностическ*',
      'расходн* материал* клинико-диагностическ*',
      'КДЛ',
      'иммунологическ* исследован*',
      'иммунологическ* определен*',
      '21-20-23-110',
      '20-59-52-199',
      'реагент* клинико-диагностическ*',
      'реагент* диагностическ*',
      'экспресс-диагност*',
      'экспресс диагност*',
      'реагент* КДЛ',
      'материал* КДЛ',
      'лабораторн* диагност*',
      'лабораторн* диагност*',
      'бесприборн* исследован*',
      'бесприборн* определен*',
      'бесприборн* тест*',
      'реагент* медицинск* применен*',
      'материал* медицинск* применен*',
      'реагент* клиническ* исследован*',
      'материал* клиническ* исследован*',
      'расходн* лаборатор* материал*',
      'тест* заболеван*',
      'реактив* клиническ* исследован*',
      'издел* медицинск* лаборатор*',
      'издел* медицин* лаборатор*',
      'клинико-диагностическ*',
      'клинико-диагностическ* лаборатор*',
      'клинико-диагностическ* отделен*',
      'общеклиническ* исследован*',
      'общеклиническ* определен*',
      'множественн* аналит* моч*',
      'колориметрическ* тест-полоск*',
      'clinitek',
      'клинитек*',
      'анализатор* моч*',
      'экспресс - тест*',
      'мочев* анализ*',
      'реагент* диагност*',
      'иммухром* метод*',
      'Уриполиан*  или эквивален*',
      'Уринополиан*',
      'экспрес* анализ* мочи',
      'для качественн* и полуколичественн*',
      'Тест-полоск* индикаторн*',
      'тест',
      'теста',
      'тестов',
      'тесты',
      '(тест-полос*)~0',
      '(с-реактивн* бел*)~1',
      'сифилис*',
      'стрептокок*',
      'Кетон* моч* ИВД',
      'кетон*',
      'глюкоз*',
      'уробилиноген*',
      'альбумин*',
      'Диагностическ* полоск* для качественн* и полуколичественн* определен*',
      'Множественн* аналит* мочи ИВД',
      'Микроальбумин*',
    ],
    Exclude: [
      'посуд*',
      'антигололедн*',
      'диски',
      'услуг*',
      'монтаж*',
      'ремонт*',
      'канцтовар*',
      'канцелярск*',
      'канц-товар*',
      'вакцин',
      'продукт* питан*',
      'тестер',
      'наконечник*',
      'пробирки',
      'ПЦР',
      'литератур*',
      'противогололедн*',
      'стоматолог*',
      'электрод',
      'ARHITECT*',
      'качества молока',
      '(иммунохемилюминесцент* анализатор*)~2',
      '(иммунохемилюминесцент* метод*)~2',
      'alisei',
      'sysmex',
      'hemalit',
      '(cobas 8000)',
      '(аграрн* групп*)~1',
      'scangel',
      '(анализатор* bs-6800)~1',
      'architect',
      'alinity',
      '(cobas 6000)~1',
      '(сармат СВ)',
      '(электрохемилюминесцент* анализ*)~1',
      '(getein 1100)~1',
      '(easy reader)',
      'getein',
      '(Quo-Lab Analyzer)',
      '(sta compact)',
      'vitek',
      '(анализатор* BS-)~1',
      '(анализатор* BC-)~2',
      '(поставк* дезинфицир*)~2',
      '(getein1100)',
      '(furuno CA)~2',
      'гемадифф',
      '(Technology Solution)',
      'Dymind',
      'цитофлуориметр*',
      '(Ilab Taurus)',
      '(АМ-900)',
      '(выявлен* ДНК)',
      '(анализатор* ACL)~2',
      'easystat',
      '(анализатор* AQT90)',
      '(АU 480)',
      '(автодельфи*)',
      '(иммунофлуоресцентн* анализ*)~2',
      '(cl-500)',
      '(cl-50)',
      '(Beckman Coulter)',
      '(access)',
      'рефлеком',
      'i-stat',
      '(для коагуломет* ACL)~2',
      '(Gem Premier)',
      'furuno',
      '(хемилюминесцент* анализ*)~2',
      '(анализатор* электролит*)~5',
      '(ABL 800)~1',
      '(иммунохемилюминесцент* анализ*)~2',
      'alegria',
      '(easy reader)',
      'easyreader',
      '(immulite-2000)',
      '(super GL)',
      '(ВС-3600)',
      '(Стресс-тест систем*)',
      '(Cobas TaqMan)',
      '(Galileo Neo)',
      'accent',
      'сармат',
      'fus-2000',
      '(fus 2000)~1',
      'ramp',
      'рефлеком',
      'ам900',
      '(ам-900)',
      '(зуботехническ* лаборатор*)~2',
      '(зуботехническ* инструмент*)~2',
      '(ам 770)',
      'ам770',
      '(Mindray BS)~2',
      'ventana',
      '(Mindray BC)~2',
      '(AU 480)',
      '(ABL 90)',
      'MAGLUMI',
      '(easy stat)',
      '(CL-1200i)',
      '(Коа Тест-4)',
      '(КоаТест-4)',
      'Radiometr',
      '(CELL-DYN)',
      'easylyte',
      'бензин',
      'работ*',
      'услуги',
    ],
  },
  документация: {
    Text: [
      'тест-кассет*',
      'тест" кассет"',
      'тест-картридж*',
      'тест* картридж*',
      'тест-полос*',
      'тест* полос*',
      'множественн* аналит* моч*',
      'колориметрическ* тест-полос*',
      'колориметрическ* тест*',
    ],
    Exclude: [
      'посуд*',
      'антигололед*',
      'диски',
      'услуг*',
      'монтаж*',
      'ремонт*',
      'канцтовар*',
      'канцелярск*',
      'канц-товар*',
      'лекарственн*',
      'лекарств*',
      'вакцин*',
      'продукт* питан*',
      'тестер*',
      'ПЦР',
      'литератур*',
      'противогололедн*',
      'выполнен* работ*',
      'изолятор*',
      'строительств*',
      'выполнен* ПИР',
      'комбинезон*',
      'офис* крес*',
      'техническ* сопровожден*',
      'демонтаж*',
      'питан* дет*',
      'бакалейн* продукц*',
      'печат* оборудован*',
      'лакокрасочн*',
      'охрана',
      'овощ*',
      'фрукт*',
      'арматур*',
      'поверочн* установ*',
      'полиграф* продукц*',
      'реконструк*',
      'порт-систем*',
      'протез*',
      'обеспеч* безопасност*',
      'постав* дезинф*',
      'двигател*',
      'мясопродукт*',
      'размораживат*',
      'твердосплав*',
      'гиря',
      'неизолированн* провод',
      'рыбн* продукц*',
      'осушител* воздух*',
      'поставк* масок',
      'мультимедийн* оборудован*',
      'предоставлен* труд*',
      'постав* перчаток',
      'вод* питьев*',
      'лабораторн* животн*',
      'благоустройств*',
      'ткан* материал*',
      'строительн* товар*',
      'строительн* материал*',
      'металлическ*',
      'поликарбонат*',
      'автоматизиров* станц*',
      'сигнальн* огонь',
      'электротехническ*',
      'насос',
      'крепежн*',
      'костюм*',
      'плазмаферез*',
      'холодильн* установ*',
      'противогаз*',
      'ремкомплект*',
      'организац* питан*',
      'содержан* чистот*',
      'транспортерн* лент*',
      'люк-лаз*',
      'аварийн* обслуживан*',
      'газов* баллон*',
      'топлив*',
      'электромонтажн* работ*',
      'систем* вентиляц*',
      'мяс* продукц*',
      'благоустроенн* квартир*',
      'приобретен* жилого',
      'электронн* книг*',
      'книжн* продук*',
      'цветочн* продук*',
      'пищеблок*',
      'пиломатериал*',
      'проведен* курс*',
      'проектирован*',
      'ветеринарн*',
      'моющи* средств*',
      '(АМ-900)',
      'humastar',
      '(иммунофлуоресцентн* анализ*)~2',
      '(ba-400)',
      'рефлеком',
      'ам900',
      '(ам 770)',
      'ам770',
      '(AU 480)',
    ],
  },
  'гбуз "гкб им. ф.и. иноземцева дзм"': {
    Text: ['ГБУЗ "ГКБ ИМ. Ф.И. ИНОЗЕМЦЕВА ДЗМ"'],
    Exclude: [],
  },
  'ооо "виджимедик"': {
    Text: ['ООО "ВИДЖИМЕДИК"'],
    Exclude: [],
  },
  'ооо "атлантика"': {
    Text: ['ООО "АТЛАНТИКА"'],
    Exclude: [],
  },
  'ип чеботнов михаил. александрович.': {
    Text: ['ИП ЧЕБОТНОВ МИХАИЛ. АЛЕКСАНДРОВИЧ.'],
    Exclude: [],
  },
  'ип мандрыгин михаил. ефимович.': {
    Text: ['ИП МАНДРЫГИН МИХАИЛ. ЕФИМОВИЧ.'],
    Exclude: [],
  },
  'ооо гк "медес"': {
    Text: ['ООО ГК "МЕДЕС"'],
    Exclude: [],
  },
  'ип качкин роман. вячеславович.': {
    Text: ['ИП КАЧКИН РОМАН. ВЯЧЕСЛАВОВИЧ.'],
    Exclude: [],
  },
  'ооо "парамед"': {
    Text: ['ООО "ПАРАМЕД"'],
    Exclude: [],
  },
  'ооо "диалан"': {
    Text: ['ООО "ДИАЛАН"'],
    Exclude: [],
  },
  'ип шевцова екатерина. сергеевна.': {
    Text: ['ИП ШЕВЦОВА ЕКАТЕРИНА. СЕРГЕЕВНА.'],
    Exclude: [],
  },
  'ип ткачев андрей. владимирович.': {
    Text: ['ИП ТКАЧЕВ АНДРЕЙ. ВЛАДИМИРОВИЧ.'],
    Exclude: [],
  },
  'ооо "терция"': {
    Text: ['ООО "ТЕРЦИЯ"'],
    Exclude: [],
  },
  'ип подоляцкий николай. сергеевич.': {
    Text: ['ИП ПОДОЛЯЦКИЙ НИКОЛАЙ. СЕРГЕЕВИЧ.'],
    Exclude: [],
  },
  'ооо "медконто"': {
    Text: ['ООО "МЕДКОНТО"'],
    Exclude: [],
  },
  'ооо "имбиан трейд"': {
    Text: ['ООО "ИМБИАН ТРЕЙД"'],
    Exclude: [],
  },
  'ооо "гем"': {
    Text: ['ООО "ГЕМ"'],
    Exclude: [],
  },
  'ооо "альфа трейд"': {
    Text: ['ООО "АЛЬФА ТРЕЙД"'],
    Exclude: [],
  },
  'гбузрк "евпаторийская гб"': {
    Text: ['ГБУЗРК "ЕВПАТОРИЙСКАЯ ГБ"'],
    Exclude: [],
  },
  'ооо "нарколаб"': {
    Text: ['ООО "НАРКОЛАБ"'],
    Exclude: [],
  },
  'гбуз "ммкц "коммунарка" дзм"': {
    Text: ['ГБУЗ "ММКЦ "КОММУНАРКА" ДЗМ"'],
    Exclude: [],
  },
  'ао "север-юг"': {
    Text: ['АО "СЕВЕР-ЮГ"'],
    Exclude: [],
  },
  'ип вахрушева наталья. владимировна.': {
    Text: ['ИП ВАХРУШЕВА НАТАЛЬЯ. ВЛАДИМИРОВНА.'],
    Exclude: [],
  },
  'огбуз "костромской областной госпиталь для ветеранов войн"': {
    Text: ['ОГБУЗ "КОСТРОМСКОЙ ОБЛАСТНОЙ ГОСПИТАЛЬ ДЛЯ ВЕТЕРАНОВ ВОЙН"'],
    Exclude: [],
  },
  'ип лиманов артем. александрович.': {
    Text: ['ИП ЛИМАНОВ АРТЕМ. АЛЕКСАНДРОВИЧ.'],
    Exclude: [],
  },
  'ооо "медикал ресурс"': {
    Text: ['ООО "МЕДИКАЛ РЕСУРС"'],
    Exclude: [],
  },
  'гбуз "дкц № 1 дзм"': {
    Text: ['ГБУЗ "ДКЦ № 1 ДЗМ"'],
    Exclude: [],
  },
  'ип перцев дмитрий. сергеевич.': {
    Text: ['ИП ПЕРЦЕВ ДМИТРИЙ. СЕРГЕЕВИЧ.'],
    Exclude: [],
  },
  'гуз "липецкая гб № 4 "липецк- мед"': {
    Text: ['ГУЗ "ЛИПЕЦКАЯ ГБ № 4 "ЛИПЕЦК- МЕД"'],
    Exclude: [],
  },
  'ооо "фармпост"': {
    Text: ['ООО "ФАРМПОСТ"'],
    Exclude: [],
  },
  'ооо "лабмединвест"': {
    Text: ['ООО "ЛАБМЕДИНВЕСТ"'],
    Exclude: [],
  },
  'ооо "никлаб"': {
    Text: ['ООО "НИКЛАБ"'],
    Exclude: [],
  },
  'ооо "лаб-сервис"': {
    Text: ['ООО "ЛАБ-СЕРВИС"'],
    Exclude: [],
  },
  'ооо "харди"': {
    Text: ['ООО "ХАРДИ"'],
    Exclude: [],
  },
  нарколаб: {
    Text: ['Множественные наркотики ИВД', 'Сармат*', 'Нарколаб*'],
    Exclude: [],
  },
  'ип сысеева анна. сергеевна.': {
    Text: ['ИП СЫСОЕВА АННА. СЕРГЕЕВНА.'],
    Exclude: [],
  },
  'ип тужина светлана. васильевна.': {
    Text: ['ИП ТУЖИНА СВЕТЛАНА. ВАСИЛЬЕВНА.'],
    Exclude: [],
  },
  'ооо "алектест"': {
    Text: ['ООО "АЛЕКТЕСТ"'],
    Exclude: [],
  },
  бахилы: {
    Text: ['Бахилы', 'бахил*'],
    Exclude: [
      'услуг*',
      'ремонт*',
      'посуд*',
      'Ластик*',
      'Метл*',
      'уборк*',
      'аппарат*',
      'костыл*',
      'гамаш*',
      'уборк*',
    ],
  },
  '=перчатки все=': {
    Text: [
      'стерильн* перчат*',
      'нестерильн* перчат*',
      'хиругич* перчат*',
      'неопудрен* перчат*',
      'латекс* перчат*',
      'резин* перчат*',
      'Перчатк* смотро*',
      'из латекса гевеи',
    ],
    Exclude: [
      'х/б',
      'чистящ*',
      'моющ*',
      'бытов*',
      'ремонт*',
      'обслуж*',
      'продукт* питан*',
      'Техническом* обслуживан*',
      'ламп*',
      'спецо*',
      'диэлектри*',
      'очки',
      'хозяйств*',
      'подгуз*',
      'сапог*',
      'ботинк*',
      'Перчатк* резин* техническ*',
      'посуд*',
      'респират*',
      'для волос',
      'Шампунь',
      'Кондиционер',
      'трикотажн*',
      'Вакцин*',
      'ветеринар*',
      'Пеленк*',
      'общего назначен*',
    ],
  },
  'перчатки юфо + кемерово + пфо': {
    Text: [
      'стерильн* перчат*',
      'нестерильн* перчат*',
      'хиругич* перчат*',
      'неопудрен* перчат*',
      'латекс* перчат*',
      'резин* перчат*',
      'Перчатк* смотро*',
      'из латекса гевеи',
    ],
    Exclude: [
      'х/б',
      'чистящ*',
      'моющ*',
      'бытов*',
      'ремонт*',
      'обслуж*',
      'продукт* питан*',
      'Техническом* обслуживан*',
      'ламп*',
      'спецо*',
      'диэлектри*',
      'очки',
      'хозяйств*',
      'подгуз*',
      'сапог*',
      'ботинк*',
      'Перчатк* резин* техническ*',
      'посуд*',
      'респират*',
      'для волос',
      'Шампунь',
      'Кондиционер',
      'трикотажн*',
      'Вакцин*',
      'ветеринар*',
      'Пеленк*',
      'общего назначен*',
    ],
  },
  'ланцеты+stix': {
    Text: [
      'Ланцет для ручного прокалывания',
      'ланцет*',
      'скарификатор*',
      'Clinitek Status',
      'Клинитек*',
      'Клинитэк Статус',
      'Клинитек Статус',
      'тест-полоск* для анализатор* мочи Clinitek',
    ],
    Exclude: [
      'х/б',
      'чистящ*',
      'моющ*',
      'бытов*',
      'ремонт*',
      'обслуж*',
      'продукт* питан*',
      'Техническом* обслуживан*',
      'ламп*',
      'Лекарственн* препарат*',
      'Лекарственн* средств*',
      'Стетофонендоскоп*',
      'Носилк* мягки*',
      'Поставк* сельскохозяйственн* оборудован*',
      'борон* дисков*',
      'Вакуумн* матрас*',
      'Ведр* с педальн* крышк*',
      'Пиридоксин*',
      'Корцанг*',
      'КАЛЬЦИ* ГЛЮКОНАТ*',
      'АМИНОФИЛЛИН*',
      'ТИАМИН8',
      'АКТИВИРОВАН* УГОЛ*',
      'МЕТИЛПРЕДНИЗОЛОН*',
      'ДОКСОРУБИЦИН*',
      'ЦЕФТАЗИДИМ*',
      'Дождевател* качающи*',
      'Оборудование для обработки почвы',
    ],
  },
  'гбуз "мнпц наркологии дзм"': {
    Text: ['ГБУЗ "МНПЦ НАРКОЛОГИИ ДЗМ"'],
    Exclude: [],
  },
  'ип краснощек ольга валентиновна': {
    Text: ['ИП КРАСНОЩЕК ОЛЬГА ВАЛЕНТИНОВНА'],
    Exclude: [],
  },
}

function enrichTenderKey(key: { _id: string; name: string }): { _id: string; name: string; Text: string[]; Exclude: string[] } {
  const enrichment = TENDER_KEY_ENRICHMENTS[key.name.trim().toLowerCase()]
  return {
    ...key,
    Text: enrichment?.Text ?? [],
    Exclude: enrichment?.Exclude ?? [],
  }
}

function findLocalTenderKeyByIdOrName(keyId: string): TenderKeyEnrichment | null {
  const normalized = keyId.trim().toLowerCase()
  if (!normalized) return null
  return TENDER_KEY_ENRICHMENTS[normalized] ?? null
}

function buildLocalTenderKeysFallback(): Array<{ _id: string; name: string; Text: string[]; Exclude: string[] }> {
  return Object.keys(TENDER_KEY_ENRICHMENTS)
    .sort((a, b) => a.localeCompare(b, 'ru'))
    .map((name) =>
      enrichTenderKey({
        // Keep _id in plain form so frontend sends ?key=<value> in legacy-like format.
        _id: name,
        name,
      }),
    )
}

type TenderKeyItem = { _id: string; name: string; Text: string[]; Exclude: string[] }

function getTenderKeysCacheCandidates(): string[] {
  return [
    path.join(process.cwd(), 'data', 'tender-keys-cache.json'),
    path.join(process.cwd(), 'backend', 'data', 'tender-keys-cache.json'),
    path.join(process.cwd(), '..', 'backend', 'data', 'tender-keys-cache.json'),
  ]
}

function normalizeTenderKeyItems(raw: unknown): TenderKeyItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((x: any) => typeof x?._id === 'string' && typeof x?.name === 'string')
    .map((x: any) =>
      enrichTenderKey({
        _id: String(x._id),
        name: String(x.name),
      }),
    )
}

async function readCachedTenderKeys(): Promise<TenderKeyItem[] | null> {
  for (const cachePath of getTenderKeysCacheCandidates()) {
    try {
      const text = await fs.readFile(cachePath, 'utf8')
      const json = JSON.parse(text)
      const keys = normalizeTenderKeyItems(json)
      if (keys.length > 0) return keys
    } catch {
      // ignore and try next candidate
    }
  }
  return null
}

async function writeCachedTenderKeys(keys: TenderKeyItem[]): Promise<void> {
  if (keys.length === 0) return
  const cachePath = getTenderKeysCacheCandidates()[0]
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.writeFile(cachePath, JSON.stringify(keys), 'utf8')
  } catch {
    // cache persistence is best-effort
  }
}

function parseStringArrayQuery(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((x) => String(x).trim()).filter((x) => x.length > 0)
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value.trim()]
  }
  return []
}

function normalizeTextForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s*.-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenizeForWordMatch(value: string): string[] {
  return normalizeTextForMatch(value)
    .replace(/[._-]+/g, ' ')
    .split(/\s+/g)
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
}

function wildcardPatternToRegex(pattern: string): RegExp | null {
  const normalized = normalizeTextForMatch(pattern)
  if (!normalized) return null
  const escaped = normalized
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[\\p{L}\\p{N}_-]*')
  try {
    // Require token boundaries to prevent partial word matches
    // (e.g. "covid" must not match "covidien").
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu')
  } catch {
    return null
  }
}

function keywordLooksMatched(haystack: string, keyword: string): boolean {
  const hs = normalizeTextForMatch(haystack)
  if (!hs) return false

  const normalizedKeyword = normalizeTextForMatch(keyword)
  if (!normalizedKeyword) return false

  const regex = wildcardPatternToRegex(normalizedKeyword)
  if (regex && regex.test(hs)) return true

  // Strict token matching for non-wildcard words.
  if (!normalizedKeyword.includes('*')) {
    const keyTokens = tokenizeForWordMatch(normalizedKeyword)
    if (keyTokens.length === 0) return false
    const hayTokens = new Set(tokenizeForWordMatch(hs))
    return keyTokens.every((token) => hayTokens.has(token))
  }

  return false
}

function konturItemSearchText(item: any): string {
  const fields = [
    item?.OrderName,
    item?.orderName,
    item?.ObjectName,
    item?.objectName,
    item?.Description,
    item?.description,
    item?.Name,
    item?.name,
  ]
  return fields.filter((x) => typeof x === 'string').join(' ')
}

function semanticPreScore(searchText: string, queryTerms: string[]): number {
  const hayTokens = tokenizeForWordMatch(searchText)
  if (hayTokens.length === 0) return 0

  const haySet = new Set(hayTokens)
  const hayRoots = new Set(hayTokens.filter((t) => t.length >= 5).map((t) => t.slice(0, 5)))
  let score = 0

  for (const queryTerm of queryTerms) {
    const qTokens = tokenizeForWordMatch(queryTerm)
    for (const qt of qTokens) {
      if (haySet.has(qt)) {
        score += 3
        continue
      }
      // Morphology-like root fallback only for Cyrillic terms, otherwise
      // we'd get false positives like "covid" vs "covidien".
      if (qt.length >= 5 && /[\u0400-\u04FF]/.test(qt) && hayRoots.has(qt.slice(0, 5))) {
        score += 1
      }
    }
  }

  return score
}

async function filterKonturItemsByAi(params: {
  items: unknown[]
  text: string[]
  exclude: string[]
}): Promise<unknown[]> {
  const queryTerms = params.text.map((x) => x.trim()).filter((x) => x.length > 0)
  if (queryTerms.length === 0) return params.items

  const aiEnabled = String(process.env.KONTUR_AI_FILTER_ENABLED ?? 'true') !== 'false'
  const maxAiChecksRaw = Number(process.env.KONTUR_AI_FILTER_MAX_CHECKS ?? 0)
  const maxAiChecks = Number.isFinite(maxAiChecksRaw) && maxAiChecksRaw > 0 ? Math.floor(maxAiChecksRaw) : null
  const aiBatchSizeRaw = Number(process.env.KONTUR_AI_FILTER_BATCH_SIZE ?? 12)
  const aiBatchSize = Number.isFinite(aiBatchSizeRaw) && aiBatchSizeRaw > 0 ? Math.floor(aiBatchSizeRaw) : 12
  const aiTimeoutMs = Number(process.env.KONTUR_AI_FILTER_AI_TIMEOUT_MS ?? 2500)
  const minSimilarity = Number(process.env.KONTUR_AI_FILTER_MIN_SIMILARITY ?? 0.35)
  const minConfidence = Number(process.env.KONTUR_AI_FILTER_MIN_CONFIDENCE ?? 0.35)

  const out: unknown[] = []
  const uncertain: Array<{ item: unknown; searchText: string; preScore: number }> = []

  for (const rawItem of params.items) {
    const item = rawItem as any
    const searchText = konturItemSearchText(item)
    const normalizedSearchText = normalizeTextForMatch(searchText)
    if (!normalizedSearchText) continue

    const hasExcluded = params.exclude.some((kw) => keywordLooksMatched(normalizedSearchText, kw))
    const directMatch = queryTerms.some((kw) => keywordLooksMatched(normalizedSearchText, kw))

    // Keep clear direct matches when they don't conflict with exclusion terms.
    if (directMatch && !hasExcluded) {
      out.push(item)
      continue
    }

    // Ambiguous items (direct+excluded, or semantic-only candidates) go to AI stage.
    // This avoids hard-cutting potentially relevant positions.
    if (!directMatch && hasExcluded) {
      // Clear exclusion without any positive evidence -> skip.
      continue
    }

    uncertain.push({
      item,
      searchText,
      preScore: semanticPreScore(normalizedSearchText, queryTerms) + (directMatch ? 2 : 0),
    })
  }

  // AI stage for uncertain candidates: bounded and timeout-protected.
  if (!aiEnabled || uncertain.length === 0) return out

  const sorted = uncertain.sort((a, b) => b.preScore - a.preScore)
  const candidates = maxAiChecks ? sorted.slice(0, maxAiChecks) : sorted

  for (let i = 0; i < candidates.length; i += aiBatchSize) {
    const batch = candidates.slice(i, i + aiBatchSize)
    const aiResults = await Promise.allSettled(
      batch.map(async (candidate) => {
        const aiPromise = compareProductNamesWithOllama({
          queryNames: queryTerms,
          libraryNames: [candidate.searchText],
        })
        const timed = await Promise.race([
          aiPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), aiTimeoutMs)),
        ])
        return { candidate, ai: timed }
      }),
    )

    for (const result of aiResults) {
      if (result.status !== 'fulfilled') continue
      const ai = result.value.ai
      if (!ai) {
        // If AI is unavailable/timeout, keep strong semantic candidates to avoid
        // dropping relevant tenders due model/network instability.
        if (result.value.candidate.preScore >= 2) {
          out.push(result.value.candidate.item)
        }
        continue
      }
      if (ai.match && ai.similarity >= minSimilarity && ai.confidence >= minConfidence) {
        out.push(result.value.candidate.item)
      }
    }
  }

  return out
}

function formatDateYmd(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function konturSearchDateRange(days = 20): { DateTimeFrom: string; DateTimeTo: string } {
  const to = new Date()
  const from = new Date()
  from.setDate(to.getDate() - (days - 1))
  return { DateTimeFrom: formatDateYmd(from), DateTimeTo: formatDateYmd(to) }
}

type KonturSearchParams = {
  apiKey: string
  dateTimeFrom: string
  dateTimeTo: string
  text: string[]
  exclude: string[]
  attachments: boolean
}

function isKonturTransientNetworkError(message: string): boolean {
  const m = String(message ?? '').toLowerCase()
  return (
    m.includes('fetch failed') ||
    m.includes('aborted') ||
    m.includes('timeout') ||
    m.includes('econnreset') ||
    m.includes('enotfound') ||
    m.includes('eai_again') ||
    m.includes('socket hang up')
  )
}

async function fetchKonturSearchAllPages(params: KonturSearchParams): Promise<{
  TotalCount: number
  Items: unknown[]
  PageNumber: number
}> {
  const url = new URL('https://api-zakupki.kontur.ru/external/v1/search')
  url.searchParams.set('DateTimeFrom', params.dateTimeFrom)
  url.searchParams.set('DateTimeTo', params.dateTimeTo)

  const baseBody = {
    DateTimeFrom: params.dateTimeFrom,
    DateTimeTo: params.dateTimeTo,
    Text: params.text,
    Exclude: params.exclude,
    Attachments: params.attachments,
  }

  const allItems: unknown[] = []
  let totalCount = 0
  let pageNumber = 0
  const retries = Math.max(0, Number(process.env.KONTUR_SEARCH_RETRIES ?? 2))
  const retryBaseDelayMs = Math.max(100, Number(process.env.KONTUR_SEARCH_RETRY_BASE_DELAY_MS ?? 1200))

  while (true) {
    let upstream: Response
    let lastNetworkError: string | null = null
    let attempt = 0
    while (true) {
      try {
        upstream = await fetch(url.toString(), {
          method: 'POST',
          headers: {
            'X-Kontur-Apikey': params.apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ ...baseBody, PageNumber: pageNumber }),
          signal: AbortSignal.timeout(30000),
        })
        break
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        lastNetworkError = message
        if (!isKonturTransientNetworkError(message) || attempt >= retries) {
          throw e
        }
        await new Promise((resolve) => setTimeout(resolve, retryBaseDelayMs * Math.pow(2, attempt)))
        attempt += 1
      }
    }

    const json = (await upstream!.json().catch(() => null)) as Record<string, unknown> | null
    if (!upstream!.ok) {
      const err = new Error(`Kontur API error: ${upstream!.status}`) as Error & { details?: unknown }
      err.details = json
      throw err
    }
    if (lastNetworkError) {
      // Network recovered after retries; continue with successful response.
    }

    totalCount = Number(json?.TotalCount ?? 0)
    const pageItems = Array.isArray(json?.Items) ? json.Items : []
    allItems.push(...pageItems)

    if (pageItems.length === 0 || allItems.length >= totalCount) break
    pageNumber += 1
  }

  return { TotalCount: totalCount, Items: allItems, PageNumber: pageNumber }
}

async function fetchKonturPurchaseById(apiKey: string, purchaseId: string): Promise<Record<string, unknown>> {
  const upstream = await fetch(`https://api-zakupki.kontur.ru/external/v1/purchases/${encodeURIComponent(purchaseId)}`, {
    headers: {
      'X-Kontur-Apikey': apiKey,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(60000),
  })

  const json = (await upstream.json().catch(() => null)) as Record<string, unknown> | null
  if (!upstream.ok) {
    const err = new Error(`Kontur API error: ${upstream.status}`) as Error & { details?: unknown }
    err.details = json
    throw err
  }

  return json ?? {}
}

async function resolveTenderKeyEnrichmentById(keyId: string): Promise<{ Text: string[]; Exclude: string[] }> {
  const local = findLocalTenderKeyByIdOrName(keyId)
  if (local) {
    return { Text: local?.Text ?? [], Exclude: local?.Exclude ?? [] }
  }

  const cached = await readCachedTenderKeys()
  if (cached) {
    const cachedKey = cached.find((x) => x._id === keyId)
    if (cachedKey) return { Text: cachedKey.Text ?? [], Exclude: cachedKey.Exclude ?? [] }
  }

  const token =
    process.env.TENDERPLAN_API_TOKEN ??
    'f6cf879e0113dc709cb929e4281a9f54b21a5ef6b3e4190523837650d2c1e0995ad31d17524739a5c011c7b0255e33e994daee02249d6eb4a530e22132bc2116'

  const upstream = await fetch('https://tenderplan.ru/api/keys/getall', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(15000),
  })

  const json = await upstream.json().catch(() => null)
  if (!upstream.ok) {
    return { Text: [], Exclude: [] }
  }

  const rawList = Array.isArray(json) ? json : Array.isArray((json as any)?.data) ? (json as any).data : []
  const key = rawList.find((x: any) => String(x?._id ?? '') === keyId)
  if (!key || typeof key?.name !== 'string') {
    return { Text: [], Exclude: [] }
  }

  const enriched = enrichTenderKey({ _id: String(key._id), name: String(key.name) })
  return { Text: enriched.Text, Exclude: enriched.Exclude }
}

type MatchNotificationPayload = {
  recipientEmail: string
  auctionNumber: string | null
  customerName: string | null
  customerInn: string | null
  auctionPrice: number | null
  sourceUrl: string | null
  decision: JudgeDecision
  uploadedFilename: string
  bestMatchFilename: string | null
  matchedCount: number
  totalCount: number
  matchPercent: number
}

type MatchNotificationResult = {
  sent: boolean
  reason?: string
}

type CrmFingerprintStore = {
  fingerprints: string[]
}

function autoDataPath(filename: string): string {
  return path.join(process.cwd(), 'data', filename)
}

function stableFingerprint(parts: Array<string | number | null | undefined>): string {
  const payload = parts.map((x) => String(x ?? '').trim()).join('|')
  return crypto.createHash('sha256').update(payload).digest('hex')
}

function normalizeUrlForDedupe(value: string | null | undefined): string | null {
  const raw = asNonEmptyString(value)
  if (!raw) return null
  try {
    const u = new URL(raw)
    u.hash = ''
    // Keep query (uid is often inside query), normalize only pathname tail.
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '')
    return u.toString()
  } catch {
    return raw.trim()
  }
}

function crmPrimaryDedupeKey(payload: MatchNotificationPayload): string {
  const normalizedSourceUrl = normalizeUrlForDedupe(payload.sourceUrl)
  if (normalizedSourceUrl) return `url:${normalizedSourceUrl}`
  const auctionNumber = asNonEmptyString(payload.auctionNumber)
  if (auctionNumber) return `auction:${auctionNumber}`
  return `file:${payload.uploadedFilename}`
}

function matchFingerprint(payload: MatchNotificationPayload): string {
  // Use stable tender identity only; do not include volatile matching fields.
  return stableFingerprint([crmPrimaryDedupeKey(payload)])
}

async function readCrmFingerprintStore(): Promise<Set<string>> {
  const p = autoDataPath('crm-sent-fingerprints.json')
  try {
    const raw = await fs.readFile(p, 'utf8')
    const parsed = JSON.parse(raw) as CrmFingerprintStore
    if (!parsed || !Array.isArray(parsed.fingerprints)) return new Set<string>()
    return new Set(parsed.fingerprints.map((x) => String(x)).filter((x) => x.length > 0))
  } catch {
    return new Set<string>()
  }
}

async function writeCrmFingerprintStore(values: Set<string>): Promise<void> {
  const p = autoDataPath('crm-sent-fingerprints.json')
  await fs.mkdir(path.dirname(p), { recursive: true })
  const payload: CrmFingerprintStore = { fingerprints: [...values].slice(-5000) }
  await fs.writeFile(p, JSON.stringify(payload), 'utf8')
}

function buildMatchNotificationText(payload: MatchNotificationPayload): string {
  const auctionPriceText =
    typeof payload.auctionPrice === 'number' && Number.isFinite(payload.auctionPrice)
      ? `${new Intl.NumberFormat('ru-RU').format(payload.auctionPrice)} ₽`
      : 'не указана'

  const lines = [
    'Сопоставление файлов завершено.',
    '',
    `Статус: ${payload.decision === 'match' ? 'соответствует' : 'не соответствует'}`,
    `Файл аукциона: ${payload.uploadedFilename}`,
    `Лучшее совпадение: ${payload.bestMatchFilename ?? 'не найдено'}`,
    `Процент совпадения: ${payload.matchPercent.toFixed(1)}%`,
    `Совпавших критериев: ${payload.matchedCount}/${payload.totalCount}`,
    '',
    `Номер аукциона: ${payload.auctionNumber ?? 'не указан'}`,
    `Заказчик: ${payload.customerName ?? 'не указан'}`,
    `ИНН заказчика: ${payload.customerInn ?? 'не указан'}`,
    `Цена аукциона: ${auctionPriceText}`,
    `Ссылка: ${payload.sourceUrl ?? 'не указана'}`,
  ]

  return lines.join('\n')
}

function stripAutoMatchFingerprintMarker(text: string): string {
  return text.replace(/\s*\[AUTO_MATCH_FP:[a-f0-9]{64}\]/gi, '').trim()
}

function parseWireCrmList(json: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(json)) return json.filter((x) => x && typeof x === 'object') as Array<Record<string, unknown>>
  if (json && typeof json === 'object') {
    const j = json as Record<string, unknown>
    const data = j.data
    if (Array.isArray(data)) return data.filter((x) => x && typeof x === 'object') as Array<Record<string, unknown>>
    const items = j.items
    if (Array.isArray(items)) return items.filter((x) => x && typeof x === 'object') as Array<Record<string, unknown>>
  }
  return []
}

async function wireCrmHasFingerprint(params: {
  apiKey: string
  baseUrl: string
  fingerprint: string
  payload: MatchNotificationPayload
}): Promise<{ found: boolean; searchUnavailable: boolean; reason?: string }> {
  const name = params.payload.auctionNumber ?? params.payload.uploadedFilename
  const sourceUrlNormalized = normalizeUrlForDedupe(params.payload.sourceUrl)
  const requestUrls: URL[] = []
  const baseListUrl = new URL(`${params.baseUrl.replace(/\/+$/, '')}/tenders`)
  baseListUrl.searchParams.set('limit', '100')
  if (name) {
    const byName = new URL(baseListUrl.toString())
    byName.searchParams.set('name', name)
    requestUrls.push(byName)
  }
  // Additional scan without `name` catches records where CRM stored another title.
  requestUrls.push(baseListUrl)

  try {
    let anySearchSucceeded = false
    const marker = `[AUTO_MATCH_FP:${params.fingerprint}]`
    for (const url of requestUrls) {
      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'X-API-KEY': params.apiKey,
        },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) continue
      anySearchSucceeded = true
      const json = await response.json().catch(() => null)
      const rows = parseWireCrmList(json)
      const byMarker = rows.some((row) => String(row.description ?? '').includes(marker))
      if (byMarker) return { found: true, searchUnavailable: false }
      const bySite = sourceUrlNormalized
        ? rows.some((row) => normalizeUrlForDedupe(String(row.site ?? '')) === sourceUrlNormalized)
        : false
      if (bySite) return { found: true, searchUnavailable: false }
      const byName = name
        ? rows.some((row) => asNonEmptyString(row.name) === asNonEmptyString(name))
        : false
      if (!sourceUrlNormalized && byName) return { found: true, searchUnavailable: false }
    }
    if (!anySearchSucceeded) {
      return { found: false, searchUnavailable: true, reason: 'search unavailable' }
    }
    return { found: false, searchUnavailable: false }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { found: false, searchUnavailable: true, reason: message }
  }
}

async function sendMatchNotificationToCrm(payload: MatchNotificationPayload): Promise<MatchNotificationResult> {
  const apiKey = asNonEmptyString(process.env.WIRECRM_API_KEY)
  if (!apiKey) return { sent: false, reason: 'Skipped: WIRECRM_API_KEY is not configured' }

  const baseUrl = asNonEmptyString(process.env.WIRECRM_API_BASE_URL) ?? 'https://wirecrm.com/api/v1'
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/tenders`
  const fingerprint = matchFingerprint(payload)
  const localSent = await readCrmFingerprintStore()
  if (localSent.has(fingerprint)) return { sent: false, reason: 'Skipped: already sent (local cache)' }

  const search = await wireCrmHasFingerprint({
    apiKey,
    baseUrl,
    fingerprint,
    payload,
  })
  if (search.found) {
    localSent.add(fingerprint)
    await writeCrmFingerprintStore(localSent)
    return { sent: false, reason: 'Skipped: already sent (CRM search)' }
  }
  if (search.searchUnavailable && localSent.has(fingerprint)) {
    return { sent: false, reason: 'Skipped: already sent (local fallback)' }
  }

  const name = payload.auctionNumber ?? payload.uploadedFilename ?? 'Тендер без номера'
  const linkFieldName = asNonEmptyString(process.env.WIRECRM_TENDER_LINK_FIELD_NAME) ?? 'Ссылка'
  const finalPriceFieldName = asNonEmptyString(process.env.WIRECRM_TENDER_FINAL_PRICE_FIELD_NAME) ?? 'Итоговая цена'
  const defaultStatusId = asNullableNumber(process.env.WIRECRM_TENDER_STATUS_ID) ?? 240391
  const description = stripAutoMatchFingerprintMarker(buildMatchNotificationText(payload))
  const crmPayload: Record<string, unknown> = {
    name,
    description,
    // WireCRM custom tender status set to "AI" by default.
    status: defaultStatusId,
    status_id: defaultStatusId,
  }
  if (payload.sourceUrl) {
    // WireCRM standard tender field for link.
    crmPayload.site = payload.sourceUrl
    // Explicitly map tender source URL into CRM "Ссылка" field.
    crmPayload[linkFieldName] = payload.sourceUrl
  }
  if (typeof payload.auctionPrice === 'number' && Number.isFinite(payload.auctionPrice)) {
    // WireCRM standard tender field for final price.
    crmPayload.price_final = payload.auctionPrice
    // Explicitly map auction price into CRM "Итоговая цена" field.
    crmPayload[finalPriceFieldName] = payload.auctionPrice
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-API-KEY': apiKey,
      },
      body: JSON.stringify(crmPayload),
      signal: AbortSignal.timeout(15000),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return {
        sent: false,
        reason: `WireCRM error ${response.status}${body ? `: ${body.slice(0, 250)}` : ''}`,
      }
    }

    localSent.add(fingerprint)
    await writeCrmFingerprintStore(localSent)
    return { sent: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { sent: false, reason: message }
  }
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function clampPercent(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

function parseBooleanField(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function parsePositiveLimit(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  if (parsed <= 0) return Number.POSITIVE_INFINITY
  return Math.floor(parsed)
}

function extractTenderMetaFromResponse(json: any): {
  auctionNumber: string | null
  customerName: string | null
  customerInn: string | null
} {
  const auctionNumber =
    asNonEmptyString(json?.auctionNumber) ??
    asNonEmptyString(json?.purchaseNumber) ??
    asNonEmptyString(json?.number) ??
    asNonEmptyString(json?.registryNumber) ??
    asNonEmptyString(json?.data?.auctionNumber) ??
    asNonEmptyString(json?.data?.purchaseNumber) ??
    asNonEmptyString(json?.data?.number) ??
    asNonEmptyString(json?.data?.registryNumber)

  const customerName =
    asNonEmptyString(json?.customerName) ??
    asNonEmptyString(json?.customer?.name) ??
    asNonEmptyString(json?.customer?.fullName) ??
    asNonEmptyString(json?.customer?.shortName) ??
    asNonEmptyString(json?.customer?.title) ??
    asNonEmptyString(json?.customers?.[0]?.name) ??
    asNonEmptyString(json?.customers?.[0]?.fullName) ??
    asNonEmptyString(json?.customers?.[0]?.shortName) ??
    asNonEmptyString(json?.customers?.[0]?.title) ??
    asNonEmptyString(json?.organization?.name) ??
    asNonEmptyString(json?.organization?.fullName) ??
    asNonEmptyString(json?.organization?.shortName) ??
    asNonEmptyString(json?.data?.customerName) ??
    asNonEmptyString(json?.data?.customer?.name) ??
    asNonEmptyString(json?.data?.customer?.fullName) ??
    asNonEmptyString(json?.data?.customer?.shortName) ??
    asNonEmptyString(json?.data?.customers?.[0]?.name) ??
    asNonEmptyString(json?.data?.customers?.[0]?.fullName) ??
    asNonEmptyString(json?.data?.customers?.[0]?.shortName) ??
    asNonEmptyString(json?.data?.customers?.[0]?.title) ??
    asNonEmptyString(json?.data?.organization?.name) ??
    asNonEmptyString(json?.data?.organization?.fullName) ??
    asNonEmptyString(json?.data?.organization?.shortName) ??
    asNonEmptyString(json?.data?.customer?.title)

  const customerInn =
    asNonEmptyString(json?.customerInn) ??
    asNonEmptyString(json?.customer?.inn) ??
    asNonEmptyString(json?.customers?.[0]?.inn) ??
    asNonEmptyString(json?.organization?.inn) ??
    asNonEmptyString(json?.inn) ??
    asNonEmptyString(json?.data?.customerInn) ??
    asNonEmptyString(json?.data?.customer?.inn) ??
    asNonEmptyString(json?.data?.customers?.[0]?.inn) ??
    asNonEmptyString(json?.data?.organization?.inn) ??
    asNonEmptyString(json?.data?.inn)

  return { auctionNumber, customerName, customerInn }
}

async function sendMatchNotificationEmail(payload: MatchNotificationPayload): Promise<{
  sent: boolean
  reason?: string
  messageId?: string
  accepted?: string[]
  rejected?: string[]
  response?: string
}> {
  const smtpHost = asNonEmptyString(process.env.SMTP_HOST)
  const smtpPort = asNullableNumber(process.env.SMTP_PORT)
  const smtpUser = asNonEmptyString(process.env.SMTP_USER)
  const smtpPass = asNonEmptyString(process.env.SMTP_PASS)
  const smtpFrom = asNonEmptyString(process.env.SMTP_FROM) ?? smtpUser

  if (!smtpHost || !smtpPort || !smtpUser || !smtpPass || !smtpFrom) {
    return { sent: false, reason: 'SMTP is not configured' }
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    })

    const info = await transporter.sendMail({
      from: smtpFrom,
      to: payload.recipientEmail,
      subject: `${payload.auctionNumber ?? 'Без номера аукциона'}`,
      text: buildMatchNotificationText(payload),
    })
    return {
      sent: true,
      messageId: info.messageId,
      accepted: Array.isArray(info.accepted) ? info.accepted.map((x) => String(x)) : [],
      rejected: Array.isArray(info.rejected) ? info.rejected.map((x) => String(x)) : [],
      response: typeof info.response === 'string' ? info.response : undefined,
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { sent: false, reason: message }
  }
}

app.post('/api/test-email', async (_req, res) => {
  try {
    const result = await sendMatchNotificationEmail({
      recipientEmail: MATCH_NOTIFY_EMAIL,
      auctionNumber: 'TEST-0001',
      customerName: 'Тестовый заказчик',
      customerInn: '0000000000',
      auctionPrice: 123456,
      sourceUrl: 'https://example.com/test',
      decision: 'match',
      uploadedFilename: 'test-file.docx',
      bestMatchFilename: 'library-test.docx',
      matchedCount: 3,
      totalCount: 5,
      matchPercent: 60,
    })
    if (!result.sent) {
      return res.status(500).json({ ok: false, ...result })
    }
    res.json({ ok: true, ...result })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(500).json({ ok: false, sent: false, reason: message })
  }
})

function productNameHintFromFilename(filename: string): string | null {
  const base = path.basename(filename, path.extname(filename))
  let s = base
    .toLowerCase()
    .replace(/[–—-]+/g, ' ')
    .replace(/[_]+/g, ' ')
    .replace(/[()]/g, ' ')

  // Remove common template words that carry no product meaning.
  // Note: JS \\w does not match Cyrillic reliably for these forms, so keep explicit patterns.
  s = s
    .replace(/тех(?:ническ[а-яё]*)?\s*задан[а-яё]*/gi, ' ')
    .replace(/техническ[а-яё]*/gi, ' ')
    .replace(/тз/gi, ' ')
    .replace(/тх/gi, ' ')
    .replace(/поставщик[а-яё]*/gi, ' ')
    .replace(/аукцион[а-яё]*/gi, ' ')
    .replace(/закупк[а-яё]*/gi, ' ')
    .replace(/сайте/gi, ' ')
    .replace(/zakupki/gi, ' ')
    .replace(/gov/gi, ' ')
    .replace(/ru/gi, ' ')
    .replace(/docx/gi, ' ')
    .replace(/pdf/gi, ' ')
    .replace(/xlsx/gi, ' ')
    .replace(/xls/gi, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  if (!s || s.length < 3) return null
  return s
}

function tokenizeName(s: string): string[] {
  return (s ?? '')
    .toLowerCase()
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
}

function namesContainmentMatch(a: string, b: string): boolean {
  const x = (a ?? '').trim()
  const y = (b ?? '').trim()
  if (!x || !y) return false

  // Direct containment for long enough phrases.
  const minLen = 14
  if ((x.length >= minLen && y.includes(x)) || (y.length >= minLen && x.includes(y))) return true

  // Token-coverage containment (shorter name should mostly be present in longer one).
  const ta = tokenizeName(x)
  const tb = tokenizeName(y)
  if (ta.length < 3 || tb.length < 3) return false
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  const longSet = new Set(longer)
  let hit = 0
  for (const t of shorter) if (longSet.has(t)) hit++
  if (hit / shorter.length >= 0.75) return true

  // Semantic-root fallback: tolerate inflection/word-form differences
  // (e.g. "наркотики" vs "наркотических") in procurement naming.
  const roots = (arr: string[]) =>
    arr
      .filter((t) => t.length >= 5)
      .map((t) => t.slice(0, 5))
  const ra = new Set(roots(ta))
  const rb = new Set(roots(tb))
  let commonRoots = 0
  for (const r of ra) if (rb.has(r)) commonRoots++
  if (commonRoots > 0) {
    const text = `${x} ${y}`
    if (/(ивд|тест|анализ|диагност|кассет|панел|контейнер|полоск)/.test(text)) return true
  }
  return false
}

function productNameListsContainmentMatch(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (namesContainmentMatch(x, y)) return true
    }
  }
  return false
}

function toKeywordTokenSet(values: string[]): Set<string> {
  const stop = new Set([
    'для',
    'при',
    'или',
    'это',
    'как',
    'что',
    'with',
    'from',
    'that',
    'this',
    'indicator',
    'value',
  ])
  const out = new Set<string>()
  for (const value of values) {
    for (const token of tokenizeForWordMatch(value ?? '')) {
      if (token.length < 4) continue
      if (stop.has(token)) continue
      out.add(token)
    }
  }
  return out
}

function keywordTokenRecall(queryTokens: Set<string>, docTokens: Set<string>): number {
  if (queryTokens.size === 0 || docTokens.size === 0) return 0
  let hit = 0
  for (const t of queryTokens) {
    if (docTokens.has(t)) hit++
  }
  return hit / queryTokens.size
}

function extractProductCodesFromText(text: string): string[] {
  const s = (text ?? '').toString().toLowerCase()
  const out = new Set<string>()
  // Typical assay/catalog codes: ISYP-C41, IHIV-C41, H10-800, etc.
  const rx = /\b[a-zа-яё]{1,8}[-_ ]?[a-zа-яё]?\d{2,5}(?:[-_ ]?\d{1,5})?\b/gi
  for (const m of s.matchAll(rx)) {
    const code = String(m[0] ?? '').replace(/[\s_]+/g, '-').trim()
    if (!code) continue
    // Skip very generic short forms like "тх-1".
    if (code.replace(/-/g, '').length < 4) continue
    out.add(code)
  }
  return [...out]
}

function extractProductCodesFromRows(rows: Array<{ indicator: string; valueRaw: string }>): string[] {
  const out = new Set<string>()
  for (const r of rows) {
    for (const c of extractProductCodesFromText(`${r.indicator ?? ''} ${r.valueRaw ?? ''}`)) out.add(c)
  }
  return [...out]
}

function extractDiseaseMarkersFromText(text: string): string[] {
  const s = (text ?? '').toString().toLowerCase()
  const out = new Set<string>()
  if (/(treponema|сифил)/i.test(s)) out.add('treponema')
  if (/(вич|hiv)/i.test(s)) out.add('hiv')
  if (/(hbsag|hbv|гепатит\s*в)/i.test(s)) out.add('hbv')
  if (/(hcv|гепатит\s*с)/i.test(s)) out.add('hcv')
  return [...out]
}

function extractDiseaseMarkersFromRows(rows: Array<{ indicator: string; valueRaw: string }>): string[] {
  const out = new Set<string>()
  for (const r of rows) {
    for (const m of extractDiseaseMarkersFromText(`${r.indicator ?? ''} ${r.valueRaw ?? ''}`)) out.add(m)
  }
  return [...out]
}

function indicatorLooksComposition(indicator: string): boolean {
  const s = (indicator ?? '').toLowerCase()
  return s.includes('состав') || s.includes('комплектац') || s.includes('описан')
}

function indicatorLooksPurposeOrDescription(indicator: string): boolean {
  const s = (indicator ?? '').toLowerCase()
  return s.includes('назначен') || s.includes('описан')
}

function detectAnalyzerInfoFromRows(
  rows: Array<{ indicator: string; valueRaw: string }>,
): { hasAnalyzer: boolean; analyzers: string[] } {
  const joined = rows
    .map((r) => `${r.indicator ?? ''} ${r.valueRaw ?? ''}`)
    .join(' \n ')
    .replace(/\s+/g, ' ')
    .trim()
  const s = joined.toLowerCase()
  if (!s.includes('анализатор')) return { hasAnalyzer: false, analyzers: [] }

  const out = new Set<string>()
  const rx = /(?:для|к)\s+анализатор[а-яё]*\s+([^.;,\n]{2,120})/gi
  for (const m of joined.matchAll(rx)) {
    const raw = String(m[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!raw) continue
    // Stop at common trailing phrases.
    const cleaned = raw
      .replace(/\b(или|и\/или)\b.*/i, '')
      .replace(/\b(методом|метод|ивд|in vitro)\b.*/i, '')
      .trim()
    if (cleaned.length >= 2) out.add(cleaned)
  }

  return { hasAnalyzer: true, analyzers: [...out] }
}

function detectContractLikeDocument(params: {
  filename: string
  rows: Array<{ indicator: string; valueRaw: string }>
}): { isContractLike: boolean; score: number; matchedMarkers: string[] } {
  const filename = String(params.filename ?? '').toLowerCase()
  const text = params.rows
    .map((r) => `${r.indicator ?? ''} ${r.valueRaw ?? ''}`)
    .join('\n')
    .toLowerCase()

  const markerRules: Array<{ label: string; regex: RegExp; weight: number }> = [
    { label: 'проект контракта', regex: /\bпроект\s+контракт[а-яё]*/i, weight: 4 },
    { label: 'контракт', regex: /\bконтракт[а-яё]*/i, weight: 2 },
    { label: 'статья', regex: /\bстатья\s*\d+/i, weight: 2 },
    { label: 'стороны', regex: /\bсторон[аы]\b/i, weight: 1 },
    { label: 'поставщик', regex: /\bпоставщик[а-яё]*/i, weight: 2 },
    { label: 'заказчик', regex: /\bзаказчик[а-яё]*/i, weight: 2 },
    { label: 'цена контракта', regex: /\bцена\s+контракт[а-яё]*/i, weight: 3 },
    { label: 'порядок расчетов', regex: /\bпорядок\s+расчет[а-яё]*/i, weight: 2 },
    { label: 'оплата по контракту', regex: /\bоплат[а-яё\s]+контракт[а-яё]*/i, weight: 2 },
    { label: 'ответственность сторон', regex: /\bответственност[а-яё\s]+сторон/i, weight: 2 },
    { label: 'неустойка', regex: /\bнеустойк[аи]\b/i, weight: 1 },
    { label: 'пеня', regex: /\bпен[яи]\b/i, weight: 1 },
    { label: 'срок поставки', regex: /\bсрок[а-яё\s]+поставк[аи]\b/i, weight: 2 },
  ]

  let score = 0
  const matchedMarkers: string[] = []
  for (const rule of markerRules) {
    if (rule.regex.test(text)) {
      score += rule.weight
      matchedMarkers.push(rule.label)
    }
  }

  const filenameLooksContract = /\b(проект[_\s-]*контракт|контракт)\b/i.test(filename)
  if (filenameLooksContract) {
    score += 4
    matchedMarkers.push('filename:contract')
  }

  const legalRowsCount = params.rows.filter((r) => {
    const rowText = `${r.indicator ?? ''} ${r.valueRaw ?? ''}`.toLowerCase()
    return /(контракт|заказчик|поставщик|цена контракта|порядок расчетов|статья)/i.test(rowText)
  }).length
  if (legalRowsCount >= 6) score += 4

  const isContractLike =
    score >= 8 || (filenameLooksContract && score >= 6) || (legalRowsCount >= 10 && matchedMarkers.length >= 3)
  return { isContractLike, score, matchedMarkers }
}

// Load environment variables for local dev.
// We try multiple locations because backend can be started from different working directories.
const envCandidates = [
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), '..', '.env'),
  path.join(process.cwd(), 'backend', '.env'),
  path.join(process.cwd(), '..', 'backend', '.env'),
]
const envPath = envCandidates.find((p) => existsSync(p))
if (envPath) {
  dotenv.config({ path: envPath, override: true })
} else {
  console.warn(
    'No .env file found for OpenAI credentials. Create `backend/.env` with `OPENAI_API_KEY=...`.',
  )
}

app.use(cors())
app.use(express.json())

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB per file
  },
})

const LIB_DIR = path.join(process.cwd(), 'data', 'library')
let libraryIndexLock: Promise<unknown> = Promise.resolve()

async function withLibraryIndexLock<T>(task: () => Promise<T>): Promise<T> {
  const run = libraryIndexLock.then(task, task)
  libraryIndexLock = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function restoreUtf8FromLatin1(maybeMojibake: string): string {
  // If browser sent UTF-8 bytes but headers were decoded as latin1,
  // we'd see patterns like `ÐŸÑ€...`. Converting latin1 -> utf8 restores the original.
  // We'll only apply conversion when it looks like mojibake.
  const looksMojibake = /[ÐÑÒÓÖ×ØÙÚÛÜÝÞßà-ÿ]/.test(maybeMojibake)
  if (!looksMojibake) return maybeMojibake

  const restored = Buffer.from(maybeMojibake, 'latin1').toString('utf8')
  // If the restored string contains Cyrillic, assume it was correct.
  if (/[\u0400-\u04FF]/.test(restored)) return restored
  return maybeMojibake
}

function safeExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  if (!ext) return ''
  return ext
}

function libraryContentHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function sanitizeFolderName(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

async function findLibraryDuplicate(params: {
  docs: LibraryDoc[]
  buffer: Buffer
}): Promise<{ id: string; originalFilename: string } | null> {
  const incomingHash = libraryContentHash(params.buffer)

  for (const doc of params.docs) {
    if (doc.contentHash && doc.contentHash === incomingHash) {
      return { id: doc.id, originalFilename: doc.originalFilename }
    }
  }

  for (const doc of params.docs) {
    if (doc.contentHash) continue
    try {
      const existing = await fs.readFile(doc.storedPath)
      if (libraryContentHash(existing) === incomingHash) {
        return { id: doc.id, originalFilename: doc.originalFilename }
      }
    } catch {
      // Ignore missing/unreadable files during duplicate check.
    }
  }

  return null
}

app.get('/api/health', (_req, res) => {
  const openaiConfigured = Boolean(process.env.OPENAI_API_KEY)
  const judgeProvider = String(process.env.JUDGE_PROVIDER ?? '').toLowerCase()
  const embeddingsProvider = String(process.env.EMBEDDINGS_PROVIDER ?? '').toLowerCase()
  const embeddingMode = embeddingsProvider === 'local' ? 'local' : openaiConfigured ? 'openai' : 'local'
  res.json({
    ok: true,
    openaiConfigured,
    embeddingMode,
    judgeProvider: judgeProvider || null,
  })
})

app.get('/api/tender-keys', async (_req, res) => {
  try {
    const token =
      process.env.TENDERPLAN_API_TOKEN ??
      'f6cf879e0113dc709cb929e4281a9f54b21a5ef6b3e4190523837650d2c1e0995ad31d17524739a5c011c7b0255e33e994daee02249d6eb4a530e22132bc2116'

    const upstream = await fetch('https://tenderplan.ru/api/keys/getall', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(15000),
    })

    const json = await upstream.json().catch(() => null)
    if (!upstream.ok) {
      const cachedKeys = await readCachedTenderKeys()
      if (cachedKeys) {
        return res.json({
          ok: true,
          keys: cachedKeys,
          source: 'cache',
          warning: `TenderPlan API error: ${upstream.status}`,
          details: json,
        })
      }
      const fallbackKeys = buildLocalTenderKeysFallback()
      return res.json({
        ok: true,
        keys: fallbackKeys,
        source: 'fallback',
        warning: `TenderPlan API error: ${upstream.status}`,
        details: json,
      })
    }

    const rawList = Array.isArray(json) ? json : Array.isArray((json as any)?.data) ? (json as any).data : []
    const list = normalizeTenderKeyItems(rawList)
    await writeCachedTenderKeys(list)

    res.json({ ok: true, keys: list })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const cachedKeys = await readCachedTenderKeys()
    if (cachedKeys) {
      return res.json({
        ok: true,
        keys: cachedKeys,
        source: 'cache',
        warning: message,
      })
    }
    const fallbackKeys = buildLocalTenderKeysFallback()
    res.json({
      ok: true,
      keys: fallbackKeys,
      source: 'fallback',
      warning: message,
    })
  }
})

app.get('/api/tender-tenders', async (req, res) => {
  try {
    const keyIds = Array.from(
      new Set(
        [
          ...parseStringArrayQuery(req.query.keyId),
          ...parseStringArrayQuery(req.query.key),
          ...parseStringArrayQuery(req.query._id),
        ]
          .map((x) => x.trim())
          .filter((x) => x.length > 0),
      ),
    )
    if (keyIds.length === 0) return res.status(400).json({ error: 'Missing keyId query param' })

    const upstreamKeyIds = keyIds.filter((keyId) => !findLocalTenderKeyByIdOrName(keyId))
    if (upstreamKeyIds.length === 0) {
      return res.json({ ok: true, tenders: [], source: 'fallback' })
    }

    const token =
      process.env.TENDERPLAN_API_TOKEN ??
      'f6cf879e0113dc709cb929e4281a9f54b21a5ef6b3e4190523837650d2c1e0995ad31d17524739a5c011c7b0255e33e994daee02249d6eb4a530e22132bc2116'

    const url = new URL('https://tenderplan.ru/api/tenders/getlist')
    // Support selecting multiple keys by repeating the `key` query param.
    for (const keyId of upstreamKeyIds) {
      url.searchParams.append('key', keyId)
    }

    const upstream = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(20000),
    })

    const json = await upstream.json().catch(() => null)
    if (!upstream.ok) {
      return res.status(502).json({
        error: `TenderPlan API error: ${upstream.status}`,
        details: json,
      })
    }

    const rawTenders = Array.isArray((json as any)?.tenders)
      ? (json as any).tenders
      : Array.isArray(json)
        ? json
        : []
    const tenders = rawTenders
      .filter((x: any) => typeof x?._id === 'string' || typeof x?.orderName === 'string')
      .map((x: any) => ({
        _id: String(x?._id ?? ''),
        orderName: String(x?.orderName ?? ''),
      }))
    const uniqueTenders = Array.from(
      new Map(tenders.map((x: { _id: string; orderName: string }) => [x._id, x])).values(),
    )

    res.json({ ok: true, tenders: uniqueTenders })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: message })
  }
})

app.get('/api/kontur/search', async (req, res) => {
  try {
    const apiKey = asNonEmptyString(process.env.KONTUR_API_KEY)
    if (!apiKey) return res.status(500).json({ error: 'KONTUR_API_KEY is not configured' })

    const defaultDates = konturSearchDateRange()
    const dateTimeFrom = String(req.query.DateTimeFrom ?? defaultDates.DateTimeFrom)
    const dateTimeTo = String(req.query.DateTimeTo ?? defaultDates.DateTimeTo)
    let text = parseStringArrayQuery(req.query.Text)
    let exclude = parseStringArrayQuery(req.query.Exclude)

    const keyId = asNonEmptyString(req.query.keyId ?? req.query.key)
    if (keyId && text.length === 0 && exclude.length === 0) {
      const enrichment = await resolveTenderKeyEnrichmentById(keyId)
      text = enrichment.Text
      exclude = enrichment.Exclude
    }

    const attachments = req.query.Attachments !== 'false'

    const json = await fetchKonturSearchAllPages({
      apiKey,
      dateTimeFrom,
      dateTimeTo,
      text,
      exclude,
      attachments,
    })

    const filteredItems = await filterKonturItemsByAi({
      items: Array.isArray((json as any)?.Items) ? (json as any).Items : [],
      text,
      exclude,
    })
    ;(json as any).Items = filteredItems
    ;(json as any).TotalCount = filteredItems.length

    res.json({ ok: true, result: json, Text: text, Exclude: exclude, Attachments: attachments })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const details = e && typeof e === 'object' && 'details' in e ? (e as { details?: unknown }).details : undefined
    if (isKonturTransientNetworkError(message)) {
      return res.json({
        ok: true,
        warning: `Kontur API temporary network issue: ${message}`,
        details,
        result: {
          TotalCount: 0,
          Items: [],
          PageNumber: 0,
        },
      })
    }
    if (message.startsWith('Kontur API error:')) {
      const status = typeof (details as any)?.status === 'number' ? Number((details as any).status) : null
      const title = typeof (details as any)?.title === 'string' ? String((details as any).title) : ''
      if (status === 403 && /invalid subscription period/i.test(title)) {
        return res.json({
          ok: true,
          warning: 'Kontur API subscription period is invalid',
          details,
          result: {
            TotalCount: 0,
            Items: [],
            PageNumber: 0,
          },
        })
      }
      return res.status(502).json({ error: message, details })
    }
    res.status(500).json({ error: message })
  }
})

app.get('/api/kontur/purchases/get', async (req, res) => {
  try {
    const apiKey = asNonEmptyString(process.env.KONTUR_API_KEY)
    if (!apiKey) return res.status(500).json({ error: 'KONTUR_API_KEY is not configured' })

    const purchaseId = String(req.query.id ?? req.query.purchaseId ?? '').trim()
    if (!purchaseId) return res.status(400).json({ error: 'Missing id query param' })

    const result = await fetchKonturPurchaseById(apiKey, purchaseId)
    res.json({ ok: true, result })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const details = e && typeof e === 'object' && 'details' in e ? (e as { details?: unknown }).details : undefined
    if (message.startsWith('Kontur API error:')) {
      return res.status(502).json({ error: message, details })
    }
    res.status(500).json({ error: message })
  }
})

app.get('/api/bicotender/tenders/get', async (_req, res) => {
  res.status(410).json({ error: 'Bicotender API integration is disabled' })
})

app.get('/api/bicotender/tenders', async (_req, res) => {
  res.status(410).json({ error: 'Bicotender API integration is disabled' })
})

async function proxyKonturAttachment(req: express.Request, res: express.Response): Promise<void> {
  try {
    const href = String(req.query.href ?? '').trim()
    const realName = String(req.query.realName ?? 'attachment').trim() || 'attachment'
    if (!href) {
      res.status(400).json({ error: 'Missing href query param' })
      return
    }

    // Kontur can return both absolute and relative links in Docs.Url.
    const downloadUrl = new URL(href, 'https://zakupki.kontur.ru')
    if (!/^https?:$/.test(downloadUrl.protocol)) {
      res.status(400).json({ error: 'Invalid href protocol' })
      return
    }

    let upstream: Response
    try {
      upstream = await fetch(downloadUrl.toString(), {
        headers: {
          Accept: '*/*',
          'User-Agent': 'med-systems/1.0',
        },
        signal: AbortSignal.timeout(60000),
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const isZakupki = /(^|\.)zakupki\.gov\.ru$/i.test(downloadUrl.hostname)
      // Some zakupki.gov.ru documents fail TLS chain validation in certain
      // server environments. Fallback is scoped only to this host.
      if (isZakupki) {
        const insecure = await downloadWithInsecureTls(downloadUrl.toString(), 60000)
        if (insecure.ok) {
          res.setHeader('Content-Type', insecure.contentType)
          res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(realName)}`)
          res.send(insecure.data)
          return
        }
        res.status(502).json({
          error: `Attachment download failed: ${message}`,
          details: insecure.error,
        })
        return
      }
      res.status(502).json({ error: `Attachment download failed: ${message}` })
      return
    }

    if (!upstream.ok) {
      res.status(502).json({ error: `Attachment download failed: ${upstream.status}` })
      return
    }

    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
    const data = Buffer.from(await upstream.arrayBuffer())
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(realName)}`)
    res.send(data)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: message })
  }
}

async function downloadWithInsecureTls(
  url: string,
  timeoutMs: number,
): Promise<{ ok: true; data: Buffer; contentType: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          Accept: '*/*',
          'User-Agent': 'med-systems/1.0',
        },
        rejectUnauthorized: false,
      },
      (resp) => {
        const statusCode = Number(resp.statusCode ?? 0)
        if (statusCode < 200 || statusCode >= 300) {
          resolve({ ok: false, error: `Upstream status: ${statusCode || 'unknown'}` })
          resp.resume()
          return
        }
        const chunks: Buffer[] = []
        resp.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
        resp.on('end', () => {
          resolve({
            ok: true,
            data: Buffer.concat(chunks),
            contentType: resp.headers['content-type'] ?? 'application/octet-stream',
          })
        })
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
    })
    req.end()
  })
}

// Keep legacy path for compatibility.
app.get('/api/bicotender/attachment', async (req, res) => {
  await proxyKonturAttachment(req, res)
})

app.get('/api/kontur/attachment', async (req, res) => {
  await proxyKonturAttachment(req, res)
})

app.get('/api/tenders/get', async (req, res) => {
  try {
    const id = String(req.query.id ?? '').trim()
    if (!id) return res.status(400).json({ error: 'Missing id query param' })

    const token =
      process.env.TENDERPLAN_API_TOKEN ??
      'f6cf879e0113dc709cb929e4281a9f54b21a5ef6b3e4190523837650d2c1e0995ad31d17524739a5c011c7b0255e33e994daee02249d6eb4a530e22132bc2116'

    const url = new URL('https://tenderplan.ru/api/tenders/get')
    url.searchParams.set('id', id)

    const upstream = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(20000),
    })

    const json = await upstream.json().catch(() => null)
    if (!upstream.ok) {
      return res.status(502).json({
        error: `TenderPlan API error: ${upstream.status}`,
        details: json,
      })
    }

    const rawAttachments = Array.isArray((json as any)?.attachments)
      ? (json as any).attachments
      : Array.isArray((json as any)?.data?.attachments)
        ? (json as any).data.attachments
        : []
    const maxPriceRaw = (json as any)?.maxPrice ?? (json as any)?.data?.maxPrice ?? null
    const hrefRaw = (json as any)?.href ?? (json as any)?.data?.href ?? null

    const tenderMeta = extractTenderMetaFromResponse(json)
    const attachments = rawAttachments
      .filter((x: any) => typeof x?.href === 'string' || typeof x?.realName === 'string')
      .map((x: any) => ({
        realName: String(x?.realName ?? ''),
        href: String(x?.href ?? ''),
      }))

    const upstreamObject = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
    res.json({
      ...upstreamObject,
      ok: true,
      href: typeof hrefRaw === 'string' ? hrefRaw : null,
      maxPrice: typeof maxPriceRaw === 'number' ? maxPriceRaw : Number.isFinite(Number(maxPriceRaw)) ? Number(maxPriceRaw) : null,
      auctionNumber: tenderMeta.auctionNumber,
      customerName: tenderMeta.customerName,
      customerInn: tenderMeta.customerInn,
      attachments,
      rawUpstream: json,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: message })
  }
})

app.get('/api/organizations/get', async (req, res) => {
  try {
    const id = String(req.query.id ?? '').trim()
    if (!id) return res.status(400).json({ error: 'Missing id query param' })

    const token =
      process.env.TENDERPLAN_API_TOKEN ??
      'f6cf879e0113dc709cb929e4281a9f54b21a5ef6b3e4190523837650d2c1e0995ad31d17524739a5c011c7b0255e33e994daee02249d6eb4a530e22132bc2116'

    const url = new URL('https://tenderplan.ru/api/organizations/get')
    url.searchParams.set('id', id)

    const upstream = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(20000),
    })

    const json = await upstream.json().catch(() => null)
    if (!upstream.ok) {
      return res.status(502).json({
        error: `TenderPlan API error: ${upstream.status}`,
        details: json,
      })
    }

    const upstreamObject = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
    res.json({
      ...upstreamObject,
      ok: true,
      rawUpstream: json,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: message })
  }
})

app.get('/api/tender-attachment', async (req, res) => {
  try {
    const href = String(req.query.href ?? '').trim()
    const realName = String(req.query.realName ?? 'attachment').trim() || 'attachment'
    if (!href) return res.status(400).json({ error: 'Missing href query param' })

    const token =
      process.env.TENDERPLAN_API_TOKEN ??
      'f6cf879e0113dc709cb929e4281a9f54b21a5ef6b3e4190523837650d2c1e0995ad31d17524739a5c011c7b0255e33e994daee02249d6eb4a530e22132bc2116'

    const downloadUrl = new URL(href, 'https://tenderplan.ru')
    if (!/^https?:$/.test(downloadUrl.protocol)) {
      return res.status(400).json({ error: 'Invalid href protocol' })
    }

    const isTenderPlanHost = /(^|\.)tenderplan\.ru$/i.test(downloadUrl.hostname)
    const isZakupkiHost = /(^|\.)zakupki\.gov\.ru$/i.test(downloadUrl.hostname)
    let upstream: Response
    try {
      upstream = await fetch(downloadUrl.toString(), {
        headers: {
          ...(isTenderPlanHost ? { Authorization: `Bearer ${token}` } : {}),
          Accept: '*/*',
          'User-Agent': 'med-systems/1.0',
        },
        signal: AbortSignal.timeout(60000),
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // zakupki.gov.ru frequently fails TLS chain validation on some servers.
      // Use the same host-scoped insecure fallback as Kontur attachments.
      if (isZakupkiHost) {
        const insecure = await downloadWithInsecureTls(downloadUrl.toString(), 60000)
        if (insecure.ok) {
          res.setHeader('Content-Type', insecure.contentType)
          res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(realName)}`)
          res.send(insecure.data)
          return
        }
        return res.status(502).json({
          error: `Attachment download failed: ${message}`,
          details: insecure.error,
        })
      }
      return res.status(502).json({ error: `Attachment download failed: ${message}` })
    }

    if (!upstream.ok) {
      const details = await upstream.text().catch(() => '')
      return res.status(502).json({
        error: `Attachment download failed: ${upstream.status}`,
        details: details.slice(0, 250),
      })
    }

    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
    const data = Buffer.from(await upstream.arrayBuffer())

    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(realName)}`)
    res.send(data)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: message })
  }
})

app.post('/api/library/add', upload.single('file'), async (req, res) => {
  try {
    const f = req.file
    if (!f) return res.status(400).json({ error: 'Missing file (field "file")' })

    const clientFilename = typeof req.body?.clientFilename === 'string' ? req.body.clientFilename : null
    const originalFilename = clientFilename ?? f.originalname
    const fixedFilename = restoreUtf8FromLatin1(originalFilename)
    const extension = safeExtension(fixedFilename)
    if (!['.pdf', '.doc', '.docx', '.xlsx', '.xls', '.txt', '.csv', '.html', '.htm', '.json', '.xml'].includes(extension)) {
      return res.status(400).json({ error: 'Unsupported file type' })
    }

    const rows = await extractRowsFromFile({ buffer: f.buffer, filename: fixedFilename })
    if (rows.length === 0) {
      return res.status(400).json({ error: 'No rows detected in file (indicator/value)' })
    }
    const extractedText = await extractTextFromFile({ buffer: f.buffer, filename: fixedFilename }).catch(() => '')
    const normalizedTextHash = crypto
      .createHash('sha256')
      .update(String(extractedText).toLowerCase().replace(/\s+/g, ' ').trim())
      .digest('hex')

    const indicatorEmbeddings = await embedTexts(rows.map((r) => r.indicator))
    for (let i = 0; i < rows.length; i++) {
      rows[i] = { ...rows[i], embedding: indicatorEmbeddings[i] }
    }

    // Store a doc embedding as fallback/ranking.
    const docEmbedding = centroid(indicatorEmbeddings)

    const committed = await withLibraryIndexLock(async () => {
      const index = await loadIndex()
      const duplicate = await findLibraryDuplicate({
        docs: index.docs,
        buffer: f.buffer,
      })
      if (duplicate) return { duplicate } as const

      await fs.mkdir(LIB_DIR, { recursive: true })
      const id = crypto.randomUUID()
      const storedPath = path.join(LIB_DIR, `${id}-${fixedFilename}`)
      await fs.writeFile(storedPath, f.buffer)

      const doc: LibraryDoc = {
        id,
        originalFilename: fixedFilename,
        extension,
        storedPath,
        folderId: null,
        contentHash: libraryContentHash(f.buffer),
        normalizedTextHash,
        extractedText,
        docEmbedding,
        embeddingModel:
          String(process.env.EMBEDDINGS_PROVIDER ?? '').toLowerCase() === 'ollama'
            ? `ollama:${process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text'}`
            : String(process.env.EMBEDDINGS_PROVIDER ?? '').toLowerCase() === 'openai'
              ? `openai:${process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small'}`
              : `local:${process.env.LOCAL_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2'}`,
        pipelineVersion: 'match-pipeline-v2',
        rowsCount: rows.length,
        rows,
        indexedAt: new Date().toISOString(),
      }

      index.docs.push(doc)
      await saveIndex(index)
      return { id, duplicate: null as null } as const
    })

    if (committed.duplicate) {
      const duplicate = committed.duplicate
      const message = `Такой же файл уже есть в библиотеке (id: ${duplicate.id.slice(0, 8)}…, «${duplicate.originalFilename}»)`
      return res.status(409).json({
        error: message,
        duplicate,
      })
    }

    res.json({
      ok: true,
      id: committed.id,
      originalFilename,
      rows: rows.length,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: message })
  }
})

app.get('/api/library/list', async (_req, res) => {
  try {
    const index = await loadIndex()
    res.json({
      ok: true,
      folders: Array.isArray(index.folders) ? index.folders : [],
      docs: index.docs.map((d) => ({
        id: d.id,
        originalFilename: d.originalFilename,
        extension: d.extension,
        storedPath: d.storedPath,
        folderId: d.folderId ?? null,
        contentHash: d.contentHash ?? null,
        normalizedTextHash: d.normalizedTextHash ?? null,
        embeddingModel: d.embeddingModel ?? null,
        pipelineVersion: d.pipelineVersion ?? null,
        rowsCount: d.rowsCount ?? (Array.isArray((d as any).rows) ? (d as any).rows.length : null),
        indexedAt: d.indexedAt,
      })),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: message })
  }
})

app.post('/api/library/folders', async (req, res) => {
  try {
    const name = sanitizeFolderName(req.body?.name)
    if (!name) return res.status(400).json({ error: 'Folder name is required' })

    const folder = await withLibraryIndexLock(async () => {
      const index = await loadIndex()
      const folders = Array.isArray(index.folders) ? index.folders : []
      const duplicate = folders.find((f) => f.name.toLowerCase() === name.toLowerCase())
      if (duplicate) return duplicate
      const created: LibraryFolder = {
        id: crypto.randomUUID(),
        name,
        createdAt: new Date().toISOString(),
      }
      index.folders = [...folders, created]
      await saveIndex(index)
      return created
    })

    res.json({ ok: true, folder })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: message })
  }
})

app.post('/api/library/move', async (req, res) => {
  try {
    const docId = String(req.body?.docId ?? '').trim()
    const folderIdRaw = req.body?.folderId
    const folderId = folderIdRaw == null || String(folderIdRaw).trim() === '' ? null : String(folderIdRaw).trim()
    if (!docId) return res.status(400).json({ error: 'docId is required' })

    const moved = await withLibraryIndexLock(async () => {
      const index = await loadIndex()
      const doc = index.docs.find((d) => d.id === docId)
      if (!doc) return { ok: false as const, error: 'Document not found' }

      if (folderId) {
        const folders = Array.isArray(index.folders) ? index.folders : []
        const exists = folders.some((f) => f.id === folderId)
        if (!exists) return { ok: false as const, error: 'Folder not found' }
      }

      doc.folderId = folderId
      await saveIndex(index)
      return { ok: true as const, doc }
    })

    if (!moved.ok) return res.status(404).json({ error: moved.error })
    res.json({ ok: true, doc: moved.doc })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: message })
  }
})

app.delete('/api/library/:id', async (req, res) => {
  try {
    const id = String(req.params.id ?? '').trim()
    if (!id) return res.status(400).json({ error: 'Missing document id' })

    const removed = await withLibraryIndexLock(async () => {
      const index = await loadIndex()
      const doc = index.docs.find((d) => d.id === id)
      if (!doc) return false

      // Remove physical file if present (best effort).
      if (doc.storedPath && doc.storedPath.startsWith(LIB_DIR)) {
        await fs.rm(doc.storedPath, { force: true })
      }

      index.docs = index.docs.filter((d) => d.id !== id)
      await saveIndex(index)
      return true
    })
    if (!removed) return res.status(404).json({ error: 'Document not found' })
    res.json({ ok: true, removedId: id })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: message })
  }
})

app.post('/api/library/clear', async (_req, res) => {
  try {
    await withLibraryIndexLock(async () => {
      const indexPath = path.join(process.cwd(), 'data', 'library-index.json')
      await fs.rm(LIB_DIR, { recursive: true, force: true })
      await fs.rm(indexPath, { force: true })
    })
    res.json({ ok: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: message })
  }
})

app.post('/api/library/reindexStored', async (_req, res) => {
  try {
    const docsIndexed = await withLibraryIndexLock(async () => {
      await fs.mkdir(LIB_DIR, { recursive: true })
      const allFiles = await fs.readdir(LIB_DIR)
      const supported = new Set(['.pdf', '.doc', '.docx', '.xlsx', '.xls', '.txt', '.csv', '.html', '.htm', '.json', '.xml'])
      const libraryFiles = allFiles
        .map((name) => path.join(LIB_DIR, name))
        .filter((p) => supported.has(path.extname(p).toLowerCase()))

      // Clear existing index; keep physical files.
      const indexPath = path.join(process.cwd(), 'data', 'library-index.json')
      await fs.rm(indexPath, { force: true })

      const docs: LibraryDoc[] = []

      for (const storedPath of libraryFiles) {
        const name = path.basename(storedPath)
        // Try to parse stored format: <uuid>-<originalFilename>
        const m = name.match(/^([0-9a-fA-F-]{36})-(.+)$/)
        const id = m?.[1] ?? crypto.randomUUID()
        const originalFilenameRaw = m?.[2] ?? name
        const fixedFilename = restoreUtf8FromLatin1(originalFilenameRaw)
        const extension = safeExtension(fixedFilename)

        const buffer = await fs.readFile(storedPath)
        const rows = await extractRowsFromFile({ buffer, filename: fixedFilename })
        if (rows.length === 0) continue
        const extractedText = await extractTextFromFile({ buffer, filename: fixedFilename }).catch(() => '')
        const normalizedTextHash = crypto
          .createHash('sha256')
          .update(String(extractedText).toLowerCase().replace(/\s+/g, ' ').trim())
          .digest('hex')

        const indicatorEmbeddings = await embedTexts(rows.map((r) => r.indicator))
        for (let i = 0; i < rows.length; i++) {
          ;(rows as any)[i] = { ...rows[i], embedding: indicatorEmbeddings[i] }
        }

        const docEmbedding = centroid(indicatorEmbeddings)

        docs.push({
          id,
          originalFilename: fixedFilename,
          extension,
          storedPath,
          folderId: null,
          contentHash: libraryContentHash(buffer),
          normalizedTextHash,
          extractedText,
          docEmbedding,
          embeddingModel:
            String(process.env.EMBEDDINGS_PROVIDER ?? '').toLowerCase() === 'ollama'
              ? `ollama:${process.env.OLLAMA_EMBEDDING_MODEL ?? 'nomic-embed-text'}`
              : String(process.env.EMBEDDINGS_PROVIDER ?? '').toLowerCase() === 'openai'
                ? `openai:${process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small'}`
                : `local:${process.env.LOCAL_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2'}`,
          pipelineVersion: 'match-pipeline-v2',
          rowsCount: rows.length,
          rows: rows as any,
          indexedAt: new Date().toISOString(),
        })
      }

      await saveIndex({
        version: 1,
        createdAt: new Date().toISOString(),
        docs,
      })
      return docs.length
    })

    res.json({ ok: true, docsIndexed })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: message })
  }
})

app.post('/api/match', upload.single('file'), async (req, res) => {
  try {
    const f = req.file
    if (!f) return res.status(400).json({ error: 'Missing file (field "file")' })

    const clientFilename = typeof req.body?.clientFilename === 'string' ? req.body.clientFilename : null
    const originalFilename = clientFilename ?? f.originalname
    const fixedFilename = restoreUtf8FromLatin1(originalFilename)
    const auctionNumber = asNonEmptyString(req.body?.auctionNumber)
    const customerName = asNonEmptyString(req.body?.customerName)
    const customerInn = asNonEmptyString(req.body?.customerInn)
    const auctionPrice = asNullableNumber(req.body?.auctionPrice)
    const minMatchPercentForComplianceByRequest = asNullableNumber(req.body?.minMatchPercentForCompliance)
    const sourceUrl = asNonEmptyString(req.body?.sourceUrl)
    const sendEmail = parseBooleanField(req.body?.sendEmail, true)
    const sendCrm = parseBooleanField(req.body?.sendCrm, true)
    const disableLlmByRequest = parseBooleanField(req.body?.disableLlm, false)
    const forceAllLibraryCandidates = parseBooleanField(req.body?.forceAllLibraryCandidates, false)
    const autoMode = parseBooleanField(req.body?.autoMode, false)
    const notifyEmailRaw = asNonEmptyString(req.body?.notifyEmail)
    if (notifyEmailRaw && !isValidEmail(notifyEmailRaw)) {
      return res.status(400).json({ error: 'Invalid notifyEmail' })
    }
    const notifyEmail = notifyEmailRaw ?? MATCH_NOTIFY_EMAIL
    const extension = safeExtension(fixedFilename)
    if (!['.pdf', '.doc', '.docx', '.xlsx', '.xls', '.txt', '.csv', '.html', '.htm', '.json', '.xml'].includes(extension)) {
      return res.status(400).json({ error: 'Unsupported file type' })
    }

    const index = await loadIndex()
    if (index.docs.length === 0) {
      return res.status(400).json({ error: 'Library is empty. Add tech specification files first.' })
    }

    const queryRows = await extractRowsFromFile({ buffer: f.buffer, filename: fixedFilename })
    if (queryRows.length === 0) {
      return res.status(400).json({ error: 'No rows detected in uploaded file (indicator/value)' })
    }
    const analyzerInfo = detectAnalyzerInfoFromRows(queryRows as any)
    const contractSignal = detectContractLikeDocument({ filename: fixedFilename, rows: queryRows as any })
    if (contractSignal.isContractLike) {
      return res.json({
        ok: true,
        embeddingMode:
          String(process.env.EMBEDDINGS_PROVIDER ?? '').toLowerCase() === 'local'
            ? 'local'
            : process.env.OPENAI_API_KEY
              ? 'openai'
              : 'local',
        thresholdUsed: Number(process.env.MATCH_PASS_PERCENT ?? 82),
        indicatorSimilarityThresholdUsed: Number(process.env.MATCH_INDICATOR_SIM_THRESHOLD ?? 0.75),
        decision: 'no_match',
        bestScore: 0,
        matchPercent: 0,
        matchedCount: 0,
        totalCount: 0,
        bestMatchFilename: null,
        rowResults: [],
        llmDecision: null,
        llmConfidence: null,
        llmExplanation:
          `Документ похож на проект контракта/юридический текст (contract-signal=${contractSignal.score}). ` +
          'Сопоставление с библиотекой техописаний пропущено, чтобы избежать ложных совпадений.',
        analyzerInfo,
        crmNotification: { sent: false, reason: 'Skipped: contract-like document' },
        emailNotification: { sent: false, reason: 'Skipped: contract-like document', recipient: notifyEmail },
        matches: [],
      })
    }

    // First gate: product name must match between query file and library document (any of several parsed titles).
    const queryProductNames = extractNormalizedProductNamesFromRows(queryRows as any)
    const queryCodes = extractProductCodesFromRows(queryRows as any)
    const queryMarkers = extractDiseaseMarkersFromRows(queryRows as any)
    const queryFileHint = productNameHintFromFilename(fixedFilename)
    for (const c of extractProductCodesFromText(fixedFilename)) queryCodes.push(c)
    for (const m of extractDiseaseMarkersFromText(fixedFilename)) queryMarkers.push(m)
    const queryNamesForGate = [...queryProductNames]
    if (queryFileHint && !queryNamesForGate.includes(queryFileHint)) queryNamesForGate.push(queryFileHint)

    const indicatorEmbeddings = await embedTexts(queryRows.map((r) => r.indicator))
    for (let i = 0; i < queryRows.length; i++) {
      queryRows[i] = { ...queryRows[i], embedding: indicatorEmbeddings[i] }
    }

    const indicatorSimilarityThreshold = Number(process.env.MATCH_INDICATOR_SIM_THRESHOLD ?? 0.75)
    const passThresholdPercent = Number(process.env.MATCH_PASS_PERCENT ?? 82)
    const minCriteriaIfNameMatched = Number(process.env.MATCH_MIN_CRITERIA_IF_NAME_MATCH ?? 1)
    const maxCandidateDocs = forceAllLibraryCandidates
      ? Number.POSITIVE_INFINITY
      : autoMode
        ? Math.max(1, Number(process.env.AUTO_MATCH_CANDIDATE_DOCS ?? 3))
        : Math.max(1, Number(process.env.MATCH_CANDIDATE_DOCS ?? 8))
    const maxKeyRows = autoMode
      ? Math.max(1, Number(process.env.AUTO_MATCH_KEYVALUE_MAX_QUERY_ROWS ?? 20))
      : Number(process.env.MATCH_KEYVALUE_MAX_QUERY_ROWS ?? 40)
    const maxLibraryRows = autoMode
      ? Math.max(1, Number(process.env.AUTO_MATCH_KEYVALUE_MAX_LIBRARY_ROWS ?? 120))
      : Number(process.env.MATCH_KEYVALUE_MAX_LIBRARY_ROWS ?? 300)

    // Row-based decision; global centroid ranking is not used currently.

    const candidateDocs = index.docs.filter((doc) => Array.isArray(doc.rows) && doc.rows.length > 0)
    if (candidateDocs.length === 0) {
      return res.status(400).json({ error: 'Library contains no structured rows. Re-index the library.' })
    }

    if (queryNamesForGate.length === 0) {
      return res.json({
        ok: true,
        embeddingMode:
          String(process.env.EMBEDDINGS_PROVIDER ?? '').toLowerCase() === 'local'
            ? 'local'
            : process.env.OPENAI_API_KEY
              ? 'openai'
              : 'local',
        thresholdUsed: Number(process.env.MATCH_PASS_PERCENT ?? 82),
        indicatorSimilarityThresholdUsed: Number(process.env.MATCH_INDICATOR_SIM_THRESHOLD ?? 0.75),
        decision: 'no_match',
        bestScore: 0,
        matchPercent: 0,
        matchedCount: 0,
        totalCount: 0,
        bestMatchFilename: null,
        rowResults: [],
        llmDecision: null,
        llmConfidence: null,
        llmExplanation:
          'В загруженном файле не найдено значение в колонке "Наименование товара". Сравнение по параметрам не выполнялось.',
        matches: [],
        productNameGate: { query: [], queryRows: queryProductNames, queryFileHint, library: [] },
      })
    }

    const productNameSimilarityThreshold = Number(process.env.MATCH_PRODUCT_NAME_SIM_THRESHOLD ?? 0.82)

    const libDocNames = candidateDocs.map((doc) => {
      const names = extractNormalizedProductNamesFromRows((doc.rows as any) ?? [])
      const codes = extractProductCodesFromRows((doc.rows as any) ?? [])
      const markers = extractDiseaseMarkersFromRows((doc.rows as any) ?? [])
      const fileHint = productNameHintFromFilename(doc.originalFilename)
      const namesForGate = [...names]
      if (fileHint && !namesForGate.includes(fileHint)) namesForGate.push(fileHint)
      for (const c of extractProductCodesFromText(doc.originalFilename)) codes.push(c)
      for (const m of extractDiseaseMarkersFromText(doc.originalFilename)) markers.push(m)
      return {
      doc,
      names,
      codes: [...new Set(codes)],
      markers: [...new Set(markers)],
      fileHint,
      namesForGate,
    }})

    const allNames = new Set<string>(queryNamesForGate)
    for (const x of libDocNames) {
      for (const n of x.namesForGate) allNames.add(n)
    }

    const allNamesList = [...allNames]
    const allNameEmbeddings = allNamesList.length > 0 ? await embedTexts(allNamesList) : []
    const nameEmbeddingMap = new Map<string, number[]>()
    for (let i = 0; i < allNamesList.length; i++) {
      if (Array.isArray(allNameEmbeddings[i])) nameEmbeddingMap.set(allNamesList[i], allNameEmbeddings[i])
    }

    const queryNameSet = new Set(queryNamesForGate)
    let gatedWithNameDiagnostics = libDocNames
      .map(({ doc, names, codes, markers, fileHint, namesForGate }) => {
        if (namesForGate.length === 0) {
          return {
            doc,
            names,
            fileHint,
            exactMatch: false,
            semanticMatch: false,
            bestSimilarity: -1,
            bestPair: null as null | { query: string; library: string },
          }
        }

        const queryCodeSet = new Set(queryCodes)
        const queryMarkerSet = new Set(queryMarkers)
        const codeMatch = (codes ?? []).some((c: string) => queryCodeSet.has(c))
        const markerArr = Array.isArray(markers) ? markers : []
        const markerInter = markerArr.filter((m: string) => queryMarkerSet.has(m)).length
        const markerExtra = markerArr.filter((m: string) => !queryMarkerSet.has(m)).length
        const markerRecall = queryMarkerSet.size > 0 ? markerInter / queryMarkerSet.size : 0
        const markerPrecision = markerArr.length > 0 ? markerInter / markerArr.length : 0
        const markerMatch = markerInter > 0 && queryMarkerSet.size > 0
        const exactMatch =
          codeMatch ||
          markerMatch ||
          namesForGate.some((n) => queryNameSet.has(n)) ||
          productNameListsContainmentMatch(queryNamesForGate, namesForGate)
        let bestSimilarity = -1
        let bestPair: null | { query: string; library: string } = null

        for (const qn of queryNamesForGate) {
          const qEmb = nameEmbeddingMap.get(qn)
          if (!qEmb) continue
          for (const ln of namesForGate) {
            const lEmb = nameEmbeddingMap.get(ln)
            if (!lEmb) continue
            const s = cosineSimilarity(qEmb, lEmb)
            if (s > bestSimilarity) {
              bestSimilarity = s
              bestPair = { query: qn, library: ln }
            }
          }
        }

        const semanticMatch = Number.isFinite(bestSimilarity) && bestSimilarity >= productNameSimilarityThreshold
        return {
          doc,
          names,
          codes,
          markers: markerArr,
          fileHint,
          namesForGate,
          codeMatch,
          markerMatch,
          markerRecall,
          markerPrecision,
          markerExtra,
          exactMatch,
          semanticMatch,
          bestSimilarity,
          bestPair,
        }
      })

    // Optional Ollama semantic gate for product names (meaning-based matching).
    if (!autoMode && String(process.env.JUDGE_PROVIDER ?? '').toLowerCase() === 'ollama') {
      // Ollama roundtrips are expensive; call it only for best unresolved candidates.
      const maxDocsForOllamaNameGate = Number(process.env.MATCH_OLLAMA_NAME_GATE_MAX_DOCS ?? 3)
      const unresolved = (gatedWithNameDiagnostics as any[])
        .filter(
          (x) => !x.exactMatch && !x.semanticMatch && Array.isArray(x.namesForGate) && x.namesForGate.length > 0,
        )
        .sort((a, b) => Number(b.bestSimilarity ?? -1) - Number(a.bestSimilarity ?? -1))
        .slice(0, Math.max(0, maxDocsForOllamaNameGate))

      for (const x of unresolved) {
        try {
          const ollamaName = await compareProductNamesWithOllama({
            queryNames: queryNamesForGate,
            libraryNames: x.namesForGate,
          })
          if (ollamaName) {
            ;(x as any).ollamaNameMatch = ollamaName
            if (ollamaName.match) {
              x.semanticMatch = true
              if (Number.isFinite(ollamaName.similarity)) {
                x.bestSimilarity = Math.max(Number(x.bestSimilarity ?? -1), Number(ollamaName.similarity))
              }
              if (ollamaName.bestQueryName && ollamaName.bestLibraryName) {
                x.bestPair = { query: ollamaName.bestQueryName, library: ollamaName.bestLibraryName }
              }
            }
          }
        } catch (_e) {
          // Ignore single-doc Ollama errors; fallback gate remains active.
        }
      }
    }
    const nameDiagnosticsBeforeGate = [...gatedWithNameDiagnostics]
    gatedWithNameDiagnostics = gatedWithNameDiagnostics.filter((x) => x.exactMatch || x.semanticMatch)
    // If query has explicit product codes and any candidates match by code,
    // keep only code-matched candidates.
    const codeMatchedDocs = gatedWithNameDiagnostics.filter((x: any) => Boolean(x?.codeMatch))
    if (queryCodes.length > 0 && codeMatchedDocs.length > 0) gatedWithNameDiagnostics = codeMatchedDocs
    // If query has disease markers, prioritize candidates covering the same marker set.
    if (queryMarkers.length > 0 && gatedWithNameDiagnostics.length > 0) {
      const maxRecall = Math.max(...gatedWithNameDiagnostics.map((x: any) => Number(x?.markerRecall ?? 0)))
      if (Number.isFinite(maxRecall) && maxRecall > 0) {
        gatedWithNameDiagnostics = gatedWithNameDiagnostics.filter(
          (x: any) => Number(x?.markerRecall ?? 0) >= maxRecall - 1e-9,
        )
        const maxPrecision = Math.max(...gatedWithNameDiagnostics.map((x: any) => Number(x?.markerPrecision ?? 0)))
        if (Number.isFinite(maxPrecision) && maxPrecision > 0) {
          gatedWithNameDiagnostics = gatedWithNameDiagnostics.filter(
            (x: any) => Number(x?.markerPrecision ?? 0) >= maxPrecision - 1e-9,
          )
        }
        const minExtra = Math.min(...gatedWithNameDiagnostics.map((x: any) => Number(x?.markerExtra ?? 999)))
        if (Number.isFinite(minExtra)) {
          gatedWithNameDiagnostics = gatedWithNameDiagnostics.filter(
            (x: any) => Number(x?.markerExtra ?? 999) <= minExtra,
          )
        }
      }
    }
    // If there are exact name matches, keep only them.
    // This prevents cross-matching with semantically similar but different products.
    const exactNameDocs = gatedWithNameDiagnostics.filter((x: any) => Boolean(x?.exactMatch))
    if (exactNameDocs.length > 0) gatedWithNameDiagnostics = exactNameDocs
    const allNameDiagByDocId = new Map(
      libDocNames.map((x: any) => [
        String(x?.doc?.id ?? ''),
        {
          exactMatch: false,
          semanticMatch: false,
          bestSimilarity: -1,
        },
      ]),
    )
    for (const x of nameDiagnosticsBeforeGate as any[]) {
      const docId = String(x?.doc?.id ?? '')
      if (!docId) continue
      allNameDiagByDocId.set(docId, {
        exactMatch: Boolean(x?.exactMatch),
        semanticMatch: Boolean(x?.semanticMatch),
        bestSimilarity: Number.isFinite(Number(x?.bestSimilarity)) ? Number(x?.bestSimilarity) : -1,
      })
    }

    const nameDiagByDocId = new Map(
      gatedWithNameDiagnostics.map((x: any) => [
        String(x?.doc?.id ?? ''),
        {
          exactMatch: Boolean(x?.exactMatch),
          semanticMatch: Boolean(x?.semanticMatch),
          bestSimilarity: Number.isFinite(Number(x?.bestSimilarity)) ? Number(x?.bestSimilarity) : -1,
        },
      ]),
    )

    let gatedCandidateDocs = gatedWithNameDiagnostics.map((x) => x.doc)
    if (gatedCandidateDocs.length === 0) {
      // Fallback: do not fail hard on product-name gate.
      // Some tender files have noisy/partial names, while key parameters still match.
      const byNameSimilarity = candidateDocs
        .map((doc) => ({
          doc,
          bestSimilarity: Number(allNameDiagByDocId.get(String((doc as any)?.id ?? ''))?.bestSimilarity ?? -1),
        }))
        .sort((a, b) => b.bestSimilarity - a.bestSimilarity)
      const topSimilarity = Number(byNameSimilarity[0]?.bestSimilarity ?? -1)
      const similarityFloor = Number.isFinite(topSimilarity) && topSimilarity > 0 ? Math.max(0.45, topSimilarity - 0.08) : -1
      const narrowed = byNameSimilarity.filter((x) => x.bestSimilarity >= similarityFloor).map((x) => x.doc)
      gatedCandidateDocs = narrowed.length > 0 ? narrowed : byNameSimilarity.map((x) => x.doc)
    }
    if (gatedCandidateDocs.length === 0) {
      const libraryNameSamples = libDocNames.slice(0, 12).map(({ doc, names, fileHint, namesForGate }) => {
        let bestSimilarity = -1
        let bestPair: null | { query: string; library: string } = null
        for (const qn of queryNamesForGate) {
          const qEmb = nameEmbeddingMap.get(qn)
          if (!qEmb) continue
          for (const ln of namesForGate) {
            const lEmb = nameEmbeddingMap.get(ln)
            if (!lEmb) continue
            const s = cosineSimilarity(qEmb, lEmb)
            if (s > bestSimilarity) {
              bestSimilarity = s
              bestPair = { query: qn, library: ln }
            }
          }
        }
        const diag = gatedWithNameDiagnostics.find((x) => x.doc.id === doc.id) as any
        return {
          id: doc.id,
          originalFilename: doc.originalFilename,
          normalizedNames: names,
          fileHint,
          namesForGate,
          bestSimilarity: Number.isFinite(bestSimilarity) ? bestSimilarity : null,
          bestPair,
          ollamaNameMatch: diag?.ollamaNameMatch ?? null,
        }
      })
      const anyLibraryHasName = libraryNameSamples.some((x) => x.normalizedNames.length > 0)
      const llmExplanation = anyLibraryHasName
        ? 'Названия товара не совпадают по смыслу. Сравнение по ключевым показателям не выполнялось. Поле productNameGate в ответе показывает извлеченные названия и их семантическую близость.'
        : 'В документах библиотеки не найдено наименование товара (пусто или устарел индекс). Выполните переиндексацию библиотеки (reindexStored) или заново загрузите файлы. Сравнение по параметрам не выполнялось.'

      return res.json({
        ok: true,
        embeddingMode:
          String(process.env.EMBEDDINGS_PROVIDER ?? '').toLowerCase() === 'local'
            ? 'local'
            : process.env.OPENAI_API_KEY
              ? 'openai'
              : 'local',
        thresholdUsed: Number(process.env.MATCH_PASS_PERCENT ?? 82),
        indicatorSimilarityThresholdUsed: Number(process.env.MATCH_INDICATOR_SIM_THRESHOLD ?? 0.75),
        decision: 'no_match',
        bestScore: 0,
        matchPercent: 0,
        matchedCount: 0,
        totalCount: 0,
        bestMatchFilename: null,
        rowResults: [],
        llmDecision: null,
        llmConfidence: null,
        llmExplanation,
        matches: [],
        productNameGate: {
          query: queryNamesForGate,
          queryRows: queryProductNames,
          queryFileHint,
          semanticThreshold: productNameSimilarityThreshold,
          library: libraryNameSamples,
        },
      })
    }

    const libDocNameMap = new Map(
      libDocNames.map((item) => [String(item.doc.id), { namesForGate: item.namesForGate, fileHint: item.fileHint }]),
    )

    // 1) Hybrid coarse ranking (docEmbedding + lexical recall over keywords).
    const queryVectors = queryRows
      .filter((r) => !isExcludedFromParameterMatch(r.indicator))
      .map((r) => r.embedding)
      .filter((v) => Array.isArray(v)) as number[][]
    const queryDocEmbedding = queryVectors.length > 0 ? centroid(queryVectors) : null
    const queryKeywordTokens = toKeywordTokenSet([
      ...queryRows.map((r) => String(r.indicator ?? '')),
      ...queryNamesForGate,
      ...queryCodes,
      ...queryMarkers,
    ])

    const rankedAll: Array<{ doc: LibraryDoc; docScore: number; lexicalScore: number }> = queryDocEmbedding
      ? gatedCandidateDocs
          .map((doc) => {
            const embFromDoc = (doc as any).docEmbedding
            const embFromRows =
              Array.isArray((doc as any)?.rows) && (doc as any).rows.length > 0
                ? centroid(
                    (doc as any).rows
                      .map((r: any) => r?.embedding)
                      .filter((v: unknown) => Array.isArray(v)) as number[][],
                  )
                : null
            const emb = Array.isArray(embFromDoc) ? embFromDoc : embFromRows
            const docScore = Array.isArray(emb) ? cosineSimilarity(queryDocEmbedding, emb) : -Infinity
            const nameMeta = libDocNameMap.get(String((doc as any)?.id ?? ''))
            const docKeywordTokens = toKeywordTokenSet([
              ...(((doc as any)?.rows ?? []) as any[]).map((r) => String(r?.indicator ?? '')),
              ...(Array.isArray(nameMeta?.namesForGate) ? nameMeta.namesForGate : []),
              String(nameMeta?.fileHint ?? ''),
              String((doc as any)?.originalFilename ?? ''),
            ])
            const lexicalScore = keywordTokenRecall(queryKeywordTokens, docKeywordTokens)
            return { doc, docScore, lexicalScore }
          })
          .sort((a, b) => b.docScore - a.docScore)
      : gatedCandidateDocs.map((doc) => {
          const nameMeta = libDocNameMap.get(String((doc as any)?.id ?? ''))
          const docKeywordTokens = toKeywordTokenSet([
            ...(((doc as any)?.rows ?? []) as any[]).map((r) => String(r?.indicator ?? '')),
            ...(Array.isArray(nameMeta?.namesForGate) ? nameMeta.namesForGate : []),
            String(nameMeta?.fileHint ?? ''),
            String((doc as any)?.originalFilename ?? ''),
          ])
          const lexicalScore = keywordTokenRecall(queryKeywordTokens, docKeywordTokens)
          return { doc, docScore: -Infinity, lexicalScore }
        })

    const rankByDocEmbedding = new Map<string, number>()
    for (let i = 0; i < rankedAll.length; i++) rankByDocEmbedding.set(String(rankedAll[i].doc.id), i + 1)
    const rankedByLexical = [...rankedAll].sort((a, b) => b.lexicalScore - a.lexicalScore)
    const rankByLexical = new Map<string, number>()
    for (let i = 0; i < rankedByLexical.length; i++) rankByLexical.set(String(rankedByLexical[i].doc.id), i + 1)
    const rrfK = 50
    const rankedHybrid = [...rankedAll]
      .map((item) => {
        const id = String(item.doc.id)
        const embRank = rankByDocEmbedding.get(id) ?? rankedAll.length + 1
        const lexRank = rankByLexical.get(id) ?? rankedAll.length + 1
        const rrfScore =
          (Number.isFinite(item.docScore) ? 1 / (rrfK + embRank) : 0) + 1 / (rrfK + lexRank) + item.lexicalScore * 0.15
        return { ...item, rrfScore }
      })
      .sort((a, b) => b.rrfScore - a.rrfScore)

    const rankedByDocEmbedding: Array<{ doc: LibraryDoc; docScore: number; lexicalScore: number }> = Number.isFinite(
      maxCandidateDocs,
    )
      ? rankedHybrid.slice(0, maxCandidateDocs)
      : rankedHybrid

    // 2) Expensive key-value scoring only for top candidates.
    const scoredDocs = rankedByDocEmbedding
      .map(({ doc, docScore, lexicalScore }) => {
        const libRows = Array.isArray(doc.rows) ? doc.rows : []
        const libRowsWithEmb = libRows.filter((r: any) => Array.isArray((r as any).embedding))

        if (libRowsWithEmb.length === 0) {
          return {
            doc,
            docScore,
            lexicalScore,
            score: -Infinity,
            matchedCount: 0,
            totalCount: 0,
            matchedKeys: [] as string[],
          }
        }

        // Pre-filter library rows by similarity to query centroid (cuts O(N*M)).
        let reducedLibRowsWithEmb = libRowsWithEmb as any[]
        if (queryDocEmbedding && libRowsWithEmb.length > maxLibraryRows) {
          reducedLibRowsWithEmb = [...libRowsWithEmb]
            .map((r: any) => ({ r, s: cosineSimilarity(queryDocEmbedding, r.embedding as number[]) }))
            .sort((a, b) => b.s - a.s)
            .slice(0, maxLibraryRows)
            .map((x) => x.r)
        } else if (libRowsWithEmb.length > maxLibraryRows) {
          reducedLibRowsWithEmb = (libRowsWithEmb as any[]).slice(0, maxLibraryRows)
        }

        const valueToleranceRel = Number(process.env.MATCH_VALUE_TOLERANCE_REL ?? 0.1)
        const valueToleranceAbs = Number(process.env.MATCH_VALUE_TOLERANCE_ABS ?? 0)

        const prop = scoreKeyValueIndicators({
          queryRows: queryRows as any,
          libraryRows: reducedLibRowsWithEmb as any,
          indicatorSimilarityThreshold,
          valueToleranceRel,
          valueToleranceAbs,
          maxKeyRows,
        })

        const score = prop.totalPossible > 0 ? prop.points / prop.totalPossible : 0
        const nameDiag =
          nameDiagByDocId.get(String((doc as any)?.id ?? '')) ??
          allNameDiagByDocId.get(String((doc as any)?.id ?? ''))
        const gateDiag = gatedWithNameDiagnostics.find((x: any) => String(x?.doc?.id ?? '') === String((doc as any)?.id ?? '')) as any
        return {
          doc,
          docScore,
          lexicalScore,
          score,
          matchedCount: prop.points,
          totalCount: prop.totalPossible,
          matchedKeys: prop.matchedIndicators,
          exactNameMatch: Boolean(nameDiag?.exactMatch),
          nameSimilarity: Number.isFinite(Number(nameDiag?.bestSimilarity)) ? Number(nameDiag?.bestSimilarity) : -1,
          markerRecall: Number.isFinite(Number(gateDiag?.markerRecall)) ? Number(gateDiag?.markerRecall) : 0,
          markerPrecision: Number.isFinite(Number(gateDiag?.markerPrecision)) ? Number(gateDiag?.markerPrecision) : 0,
        }
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        if (b.matchedCount !== a.matchedCount) return b.matchedCount - a.matchedCount
        const aMarkerRecall = Number.isFinite(Number(a.markerRecall)) ? Number(a.markerRecall) : 0
        const bMarkerRecall = Number.isFinite(Number(b.markerRecall)) ? Number(b.markerRecall) : 0
        if (bMarkerRecall !== aMarkerRecall) return bMarkerRecall - aMarkerRecall
        const aMarkerPrecision = Number.isFinite(Number(a.markerPrecision)) ? Number(a.markerPrecision) : 0
        const bMarkerPrecision = Number.isFinite(Number(b.markerPrecision)) ? Number(b.markerPrecision) : 0
        if (bMarkerPrecision !== aMarkerPrecision) return bMarkerPrecision - aMarkerPrecision
        if (Number(b.exactNameMatch) !== Number(a.exactNameMatch)) return Number(b.exactNameMatch) - Number(a.exactNameMatch)
        const aNameSim = Number.isFinite(Number(a.nameSimilarity)) ? Number(a.nameSimilarity) : -1
        const bNameSim = Number.isFinite(Number(b.nameSimilarity)) ? Number(b.nameSimilarity) : -1
        if (bNameSim !== aNameSim) return bNameSim - aNameSim
        if (b.docScore !== a.docScore) return b.docScore - a.docScore
        if (b.lexicalScore !== a.lexicalScore) return b.lexicalScore - a.lexicalScore
        return 0
      })

    const buildMatchedRowResultsForDoc = (doc: LibraryDoc): any[] => {
      const selectedDoc = doc as any
      if (!selectedDoc || !Array.isArray(selectedDoc.rows) || !selectedDoc.rows?.length) return []
      const libRowsWithEmb = selectedDoc.rows.filter(
        (r: any) => Array.isArray(r.embedding) && !isExcludedFromParameterMatch(r.indicator),
      )
      if (libRowsWithEmb.length === 0) return []
      const queryRowsForResults = (queryRows as any[]).filter((r) => !isExcludedFromParameterMatch(r.indicator))

      const rows = queryRowsForResults
        .map((qRow) => {
          const qEmb = qRow.embedding as number[]
          let bestSimAll = -Infinity
          let bestLibAll: any = null
          let bestSimValueMatch = -Infinity
          let bestLibValueMatch: any = null

          for (const lRow of libRowsWithEmb as any[]) {
            const s = cosineSimilarity(qEmb, lRow.embedding as number[])
            if (s > bestSimAll) {
              bestSimAll = s
              bestLibAll = lRow
            }

            const aliasPair = tenderAliasesAllowValueCompare(qRow.indicator, lRow.indicator)
            const keywordSimilar = indicatorsLookKeywordSimilar(qRow.indicator, lRow.indicator)
            if (s < indicatorSimilarityThreshold && !aliasPair && !keywordSimilar) continue

            const m = valuesMatch({
              queryValueRaw: qRow.valueRaw,
              libraryValueRaw: lRow.valueRaw,
              toleranceRel: Number(process.env.MATCH_VALUE_TOLERANCE_REL ?? 0.1),
              toleranceAbs: Number(process.env.MATCH_VALUE_TOLERANCE_ABS ?? 0),
            })
            const fallbackTextMatch =
              aliasPair &&
              ((
                indicatorLooksComposition(qRow.indicator) &&
                indicatorLooksComposition(lRow.indicator)
              ) ||
                (indicatorLooksPurposeOrDescription(qRow.indicator) &&
                  indicatorLooksPurposeOrDescription(lRow.indicator))) &&
              compositionLongTextFallbackMatch(qRow.valueRaw, lRow.valueRaw)

            if ((m.match || fallbackTextMatch) && s > bestSimValueMatch) {
              bestSimValueMatch = s
              bestLibValueMatch = lRow
            }
          }

          const chosenLib = bestLibValueMatch ?? bestLibAll
          const m = chosenLib
            ? valuesMatch({
                queryValueRaw: qRow.valueRaw,
                libraryValueRaw: chosenLib.valueRaw,
                toleranceRel: Number(process.env.MATCH_VALUE_TOLERANCE_REL ?? 0.1),
                toleranceAbs: Number(process.env.MATCH_VALUE_TOLERANCE_ABS ?? 0),
              })
            : { match: false, reason: 'no candidate' }
          const fallbackTextMatch =
            chosenLib != null &&
            tenderAliasesAllowValueCompare(qRow.indicator, chosenLib.indicator) &&
            ((
              indicatorLooksComposition(qRow.indicator) &&
              indicatorLooksComposition(chosenLib.indicator)
            ) ||
              (indicatorLooksPurposeOrDescription(qRow.indicator) &&
                indicatorLooksPurposeOrDescription(chosenLib.indicator))) &&
            compositionLongTextFallbackMatch(qRow.valueRaw, chosenLib.valueRaw)

          const bestSimForIndicatorOk = chosenLib === bestLibValueMatch ? bestSimValueMatch : bestSimAll
          const keywordSimilar = chosenLib ? indicatorsLookKeywordSimilar(qRow.indicator, chosenLib.indicator) : false
          const indicatorOk =
            bestSimForIndicatorOk >= indicatorSimilarityThreshold ||
            (chosenLib != null &&
              (tenderAliasesAllowValueCompare(qRow.indicator, chosenLib.indicator) || keywordSimilar))
          const valueOk = Boolean(m.match || fallbackTextMatch)

          return {
            indicator: qRow.indicator,
            queryValueRaw: qRow.valueRaw,
            matchedLibraryIndicator: chosenLib?.indicator,
            matchedLibraryValueRaw: chosenLib?.valueRaw,
            indicatorSimilarity: bestSimForIndicatorOk,
            valueMatch: valueOk,
            indicatorOk,
            valueReason: m.match ? m.reason : fallbackTextMatch ? 'composition long-text fallback' : m.reason,
            rowMatched: indicatorOk && valueOk,
          }
        })
        .filter((r) => Boolean(r.rowMatched))

      return rows
    }

    const refinementTopDocs = autoMode
      ? Math.max(1, Number(process.env.AUTO_MATCH_REFINEMENT_TOP_DOCS ?? 2))
      : Math.max(1, Number(process.env.MATCH_REFINEMENT_TOP_DOCS ?? 5))
    const refinedTopDocs = scoredDocs.slice(0, refinementTopDocs).map((item) => {
      const refinedRowResults = buildMatchedRowResultsForDoc(item.doc)
      return {
        ...item,
        refinedRowResults,
        refinedMatchedCount: refinedRowResults.length,
      }
    })

    const refinementBest =
      refinedTopDocs
        .slice()
        .sort((a, b) => {
          if (b.refinedMatchedCount !== a.refinedMatchedCount) return b.refinedMatchedCount - a.refinedMatchedCount
          if (b.matchedCount !== a.matchedCount) return b.matchedCount - a.matchedCount
          if (b.score !== a.score) return b.score - a.score
          return b.docScore - a.docScore
        })[0] ?? null

    let heuristicBest = refinementBest ?? scoredDocs[0]
    let pipelineDecisionExplanation: string | null = null
    try {
      const pipelineEnabled = String(process.env.MATCH_PIPELINE_ENABLED ?? 'true') === 'true'
      if (pipelineEnabled) {
        const pipelineCandidateCount = autoMode
          ? Math.max(2, Number(process.env.AUTO_MATCH_PIPELINE_CANDIDATES ?? 4))
          : Math.max(2, Number(process.env.MATCH_PIPELINE_CANDIDATES ?? 10))
        const pipelineCandidatesRaw = scoredDocs.slice(0, pipelineCandidateCount)
        if (pipelineCandidatesRaw.length > 0) {
          const queryParsed = await matchingRuntime.fileParser.parse({
            filename: fixedFilename,
            sizeBytes: f.buffer.length,
            buffer: Buffer.from(f.buffer),
          })
          const pipelineCandidatesParsed = await Promise.all(
            pipelineCandidatesRaw.map(async (item) => {
              try {
                const fileBuffer = await fs.readFile(item.doc.storedPath)
                return await matchingRuntime.fileParser.parse({
                  filename: item.doc.originalFilename,
                  sizeBytes: fileBuffer.length,
                  buffer: fileBuffer,
                })
              } catch {
                const fallbackText = Array.isArray((item.doc as any)?.rows)
                  ? (item.doc as any).rows
                      .map((r: any) => `${String(r?.indicator ?? '')}: ${String(r?.valueRaw ?? '')}`)
                      .join('\n')
                  : ''
                const fallbackBuffer = Buffer.from(fallbackText, 'utf8')
                return await matchingRuntime.fileParser.parse({
                  filename: item.doc.originalFilename,
                  sizeBytes: fallbackBuffer.length,
                  buffer: fallbackBuffer,
                })
              }
            }),
          )
          const pipelineBest = await matchingRuntime.pipeline.compare(queryParsed, pipelineCandidatesParsed)
          if (pipelineBest) {
            pipelineDecisionExplanation = pipelineBest.decision.explanation
            const boosted = scoredDocs.find((x) => x.doc.id === pipelineBest.document.id)
            if (boosted) {
              const boostFactor = Number(process.env.MATCH_PIPELINE_BOOST_FACTOR ?? 0.35)
              heuristicBest = {
                ...boosted,
                score: Math.max(boosted.score, boosted.score + pipelineBest.decision.confidence * boostFactor),
                refinedMatchedCount: Math.max(
                  Number((boosted as any).refinedMatchedCount ?? 0),
                  Math.round(pipelineBest.decision.scores.coverageAByB * Math.max(1, queryRows.length)),
                ),
              } as any
            }
          }
        }
      }
    } catch {
      // Keep primary matching flow resilient if secondary pipeline fails.
    }
    // LLM judge step (neural network) for final decision.
    // For speed we can skip LLM when heuristic already reached required matched criteria.
    // This dramatically reduces latency on local Ollama models.
    const skipLlmWhenHeuristicConfident = String(process.env.MATCH_SKIP_LLM_IF_CRITERIA_MATCH ?? 'true') === 'true'
    const selected = heuristicBest
    let llm: { decision: JudgeDecision; confidence: number; similarity: number; explanation: string } | null = null
    let llmError: string | null = null
    const judgeProvider = String(process.env.JUDGE_PROVIDER ?? '').toLowerCase()
    const heuristicMatchedCount = Math.max(
      Number((heuristicBest as any)?.matchedCount ?? 0),
      Number((heuristicBest as any)?.refinedMatchedCount ?? 0),
    )
    const heuristicEnough = heuristicMatchedCount >= minCriteriaIfNameMatched
    const disableLlm = disableLlmByRequest || String(process.env.MATCH_DISABLE_LLM ?? 'false') === 'true'
    const shouldRunLlm = !disableLlm && !(skipLlmWhenHeuristicConfident && heuristicEnough)
    if (shouldRunLlm) {
      try {
        const queryRowsForJudge = (queryRows as any[])
          .filter((r) => !isExcludedFromParameterMatch(r.indicator))
          .map((r) => ({ indicator: r.indicator, valueRaw: r.valueRaw })) as RowForJudge[]
        const selectedDoc = selected.doc as any
        const libraryRowsForJudge = Array.isArray(selectedDoc?.rows)
          ? (selectedDoc.rows as any[])
              .filter((r) => !isExcludedFromParameterMatch(r.indicator))
              .map((r) => ({ indicator: r.indicator, valueRaw: r.valueRaw }))
          : []

        llm = await judgeMatch({
          queryRows: queryRowsForJudge,
          libraryRows: libraryRowsForJudge,
          fileNames: { query: fixedFilename, library: selectedDoc?.originalFilename },
        })

        if (!llm) {
          const noLlmConfigured =
            !judgeProvider && !process.env.OPENAI_API_KEY && !process.env.OLLAMA_URL
          if (noLlmConfigured) {
            // LLM is intentionally disabled; do not surface this as an error.
            llmError = null
          } else
          if (judgeProvider === 'openai') {
            if (!process.env.OPENAI_API_KEY) {
              llmError =
                'OpenAI judge включен, но `OPENAI_API_KEY` не задан. Вставьте ключ в `backend/.env`. Используется эвристика.'
            } else {
              llmError =
                'OpenAI judge не сработал (возможна блокировка по региону 403/not supported). При необходимости включите VPN/прокси в поддерживаемый регион. Используется эвристика.'
            }
          } else {
            llmError =
              'Нейросеть не вернула корректный структурированный ответ (judge). Используется эвристика.'
          }
        } else if (!llm.explanation || llm.explanation.trim().length === 0) {
          llmError = 'Нейросеть вернула решение, но не приложила текстовое объяснение. Используется эвристика по строкам.'
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        // If request was aborted (timeout/cancel), keep UI clean and silently use heuristic.
        if (message.toLowerCase().includes('aborted')) {
          llmError = null
        } else {
          // Provide the original failure reason to help debugging proxy/VPN issues.
          llmError = `Ошибка при вызове нейросети (подробности): ${message}. Используется эвристика.`
        }
        llm = null
      }
    } else {
      llmError = 'Нейросеть пропущена: эвристика уже выполнила критерий совпадения.'
    }

    // Prefer deterministic heuristic when it already meets criteria.
    // This avoids false "no_match" from LLM on partially-structured tender docs.
    const decisionByCriteriaIfNameMatched: JudgeDecision =
      heuristicMatchedCount >= minCriteriaIfNameMatched ? 'match' : 'no_match'
    const llmContradictsStrongHeuristic =
      judgeProvider === 'ollama' &&
      heuristicEnough &&
      llm?.decision === 'no_match'
    const decision: JudgeDecision =
      llmContradictsStrongHeuristic
        ? decisionByCriteriaIfNameMatched
        : judgeProvider === 'ollama' && llm?.decision
        ? llm.decision
        : decisionByCriteriaIfNameMatched

    // Build row-level explanation for the selected document only.
    const rowResults: any[] = Array.isArray((selected as any).refinedRowResults)
      ? ((selected as any).refinedRowResults as any[])
      : buildMatchedRowResultsForDoc(selected.doc)

    const matchedCountByRows = rowResults.length
    const matchedCountOut = Math.max(selected.matchedCount, matchedCountByRows)
    const rawMatchPercentOut =
      selected.totalCount > 0 ? (matchedCountOut / selected.totalCount) * 100 : 0
    const minMatchPercentForComplianceDefault = Number(process.env.MATCH_MIN_PERCENT_FOR_COMPLIANCE ?? 30)
    const minMatchPercentForCompliance = clampPercent(
      minMatchPercentForComplianceByRequest ?? minMatchPercentForComplianceDefault,
      30,
    )
    const belowMinPercent = rawMatchPercentOut < minMatchPercentForCompliance
    const decisionOut: JudgeDecision = belowMinPercent
      ? 'no_match'
      : matchedCountOut >= minCriteriaIfNameMatched
        ? 'match'
        : decision
    const matchPercentOut = rawMatchPercentOut
    const notificationPayload: MatchNotificationPayload = {
      recipientEmail: notifyEmail,
      auctionNumber,
      customerName,
      customerInn,
      auctionPrice,
      sourceUrl,
      decision: decisionOut,
      uploadedFilename: fixedFilename,
      bestMatchFilename: selected.doc?.originalFilename ?? null,
      matchedCount: matchedCountOut,
      totalCount: selected.totalCount,
      matchPercent: matchPercentOut,
    }
    const crmNotification =
      !sendCrm
        ? { sent: false, reason: 'Skipped: disabled by user' }
        : decisionOut === 'match'
          ? await sendMatchNotificationToCrm(notificationPayload)
          : { sent: false, reason: 'Skipped: decision is no_match' }

    const emailNotification =
      !sendEmail
        ? { sent: false, reason: 'Skipped: disabled by user', recipient: notifyEmail }
        : decisionOut === 'match'
        ? await sendMatchNotificationEmail(notificationPayload)
        : { sent: false, reason: 'Skipped: decision is no_match', recipient: notifyEmail }

    res.json({
      ok: true,
      embeddingMode:
        String(process.env.EMBEDDINGS_PROVIDER ?? '').toLowerCase() === 'local'
          ? 'local'
          : process.env.OPENAI_API_KEY
            ? 'openai'
            : 'local',
      thresholdUsed: passThresholdPercent,
      indicatorSimilarityThresholdUsed: indicatorSimilarityThreshold,
      minCriteriaIfNameMatched,
      decision: decisionOut,
      bestScore: selected.score,
      matchPercent: matchPercentOut,
      matchedCount: matchedCountOut,
      totalCount: selected.totalCount,
      bestMatchFilename: selected.doc?.originalFilename ?? null,
      rowResults,
      llmDecision: llm?.decision ?? null,
      llmConfidence: llm?.confidence ?? null,
      llmSimilarity: llm?.similarity ?? null,
      llmExplanation:
        llm?.explanation && llm.explanation.trim().length > 0
          ? llm.explanation
          : pipelineDecisionExplanation
            ? `${pipelineDecisionExplanation}${llmError ? ` | ${llmError}` : ''}`
            : llmError ?? null,
      analyzerInfo,
      crmNotification,
      emailNotification,
      // We return only the best matching document.
      matches:
        decisionOut === 'match'
          ? scoredDocs.slice(0, 1).map((m) => ({
              id: m.doc.id,
              originalFilename: m.doc.originalFilename,
              storedPath: m.doc.storedPath,
              extension: m.doc.extension,
              score: m.score,
              matchPercent: Number.isFinite(m.score) ? m.score * 100 : 0,
              matchedCount: m.matchedCount,
              totalCount: m.totalCount,
            }))
          : [],
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(500).json({ error: message })
  }
})

type AutoMatchIntervalCode = '3m' | '5m' | '10m' | '30m' | '60m'

type AutoMatchRunItem = {
  timestamp: string
  keyId: string
  tenderId: string
  attachmentName: string
  status: 'matched' | 'no_match' | 'skipped' | 'error'
  message?: string
  matchPercent?: number
  bestMatchFilename?: string | null
}

type AutoMatchCurrentItem = {
  stage: 'keys' | 'tenders' | 'tender_details' | 'attachment_download' | 'matching'
  keyId?: string
  tenderId?: string
  attachmentName?: string
  updatedAt: string
}

type AutoMatchState = {
  enabled: boolean
  interval: AutoMatchIntervalCode
  running: boolean
  currentRunStartedAt: string | null
  lastRunAt: string | null
  lastRunFinishedAt: string | null
  stats: {
    processed: number
    matched: number
    noMatch: number
    skipped: number
    errors: number
  }
  currentItem: AutoMatchCurrentItem | null
  history: AutoMatchRunItem[]
}

const AUTO_MATCH_INTERVALS_MS: Record<AutoMatchIntervalCode, number> = {
  '3m': 3 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '10m': 10 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '60m': 60 * 60 * 1000,
}

const DEFAULT_AUTO_MATCH_STATE: AutoMatchState = {
  enabled: false,
  interval: '10m',
  running: false,
  currentRunStartedAt: null,
  lastRunAt: null,
  lastRunFinishedAt: null,
  stats: {
    processed: 0,
    matched: 0,
    noMatch: 0,
    skipped: 0,
    errors: 0,
  },
  currentItem: null,
  history: [],
}

let autoMatchState: AutoMatchState = { ...DEFAULT_AUTO_MATCH_STATE }
let autoMatchTimer: NodeJS.Timeout | null = null
let autoMatchRunInProgress = false

function autoMatchStatePath(): string {
  return autoDataPath('auto-match-state.json')
}

async function loadAutoMatchState(): Promise<void> {
  try {
    const p = autoMatchStatePath()
    const text = await fs.readFile(p, 'utf8')
    const parsed = JSON.parse(text) as Partial<AutoMatchState>
    const interval = (parsed.interval ?? DEFAULT_AUTO_MATCH_STATE.interval) as AutoMatchIntervalCode
    autoMatchState = {
      ...DEFAULT_AUTO_MATCH_STATE,
      ...parsed,
      interval: Object.keys(AUTO_MATCH_INTERVALS_MS).includes(interval) ? interval : DEFAULT_AUTO_MATCH_STATE.interval,
      running: false,
      currentRunStartedAt: null,
      lastRunFinishedAt:
        typeof parsed.lastRunFinishedAt === 'string'
          ? parsed.lastRunFinishedAt
          : typeof parsed.lastRunAt === 'string'
            ? parsed.lastRunAt
            : null,
      currentItem:
        parsed.currentItem && typeof parsed.currentItem === 'object'
          ? {
              stage: String((parsed.currentItem as any).stage ?? 'keys') as AutoMatchCurrentItem['stage'],
              keyId: asNonEmptyString((parsed.currentItem as any).keyId) ?? undefined,
              tenderId: asNonEmptyString((parsed.currentItem as any).tenderId) ?? undefined,
              attachmentName: asNonEmptyString((parsed.currentItem as any).attachmentName) ?? undefined,
              updatedAt: asNonEmptyString((parsed.currentItem as any).updatedAt) ?? new Date().toISOString(),
            }
          : null,
      history: Array.isArray(parsed.history) ? (parsed.history as AutoMatchRunItem[]).slice(-200) : [],
      stats: { ...DEFAULT_AUTO_MATCH_STATE.stats, ...(parsed.stats ?? {}) },
    }
  } catch {
    autoMatchState = { ...DEFAULT_AUTO_MATCH_STATE }
  }
}

async function saveAutoMatchState(): Promise<void> {
  const p = autoMatchStatePath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, JSON.stringify(autoMatchState), 'utf8')
}

function autoMatchBaseUrl(): string {
  const p = Number(process.env.PORT ?? 3001)
  return `http://127.0.0.1:${p}`
}

function autoMatchPushHistory(item: AutoMatchRunItem): void {
  autoMatchState.history.push(item)
  if (autoMatchState.history.length > 200) {
    autoMatchState.history = autoMatchState.history.slice(-200)
  }
}

async function readHttpErrorMessage(resp: Response): Promise<string> {
  try {
    const json: any = await resp.json().catch(() => null)
    const msg =
      (typeof json?.error === 'string' && json.error.trim().length > 0 ? json.error.trim() : null) ??
      (typeof json?.message === 'string' && json.message.trim().length > 0 ? json.message.trim() : null)
    if (msg) return msg.slice(0, 250)
  } catch {
    // ignore JSON parse issues
  }

  try {
    const text = await resp.text()
    if (text && text.trim().length > 0) return text.trim().slice(0, 250)
  } catch {
    // ignore text read issues
  }

  return ''
}

function stopAutoMatchScheduler(): void {
  if (autoMatchTimer) {
    clearInterval(autoMatchTimer)
    autoMatchTimer = null
  }
}

function startAutoMatchScheduler(): void {
  stopAutoMatchScheduler()
  const ms = AUTO_MATCH_INTERVALS_MS[autoMatchState.interval]
  autoMatchTimer = setInterval(() => {
    void runAutoMatchCycle('interval')
  }, ms)
}

async function fetchAutoMatchAllKeys(): Promise<Array<{ _id: string; name: string; Text: string[]; Exclude: string[] }>> {
  const token =
    process.env.TENDERPLAN_API_TOKEN ??
    'f6cf879e0113dc709cb929e4281a9f54b21a5ef6b3e4190523837650d2c1e0995ad31d17524739a5c011c7b0255e33e994daee02249d6eb4a530e22132bc2116'

  try {
    const upstream = await fetch('https://tenderplan.ru/api/keys/getall', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    })
    const json = await upstream.json().catch(() => null)
    if (upstream.ok) {
      const rawList = Array.isArray(json) ? json : Array.isArray((json as any)?.data) ? (json as any).data : []
      const list = normalizeTenderKeyItems(rawList)
      await writeCachedTenderKeys(list)
      return list
    }
  } catch {
    // fallback to cache below
  }

  const cached = await readCachedTenderKeys()
  if (cached && cached.length > 0) return cached
  return buildLocalTenderKeysFallback()
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

async function downloadTenderAttachmentWithRetry(params: {
  href: string
  attachmentName: string
}): Promise<{ ok: true; data: Buffer } | { ok: false; error: string }> {
  const retries = Math.max(0, Number(process.env.AUTO_MATCH_ATTACHMENT_RETRIES ?? 2))
  const baseDelayMs = Math.max(100, Number(process.env.AUTO_MATCH_RETRY_BASE_DELAY_MS ?? 1200))

  let lastError = 'attachment download failed'
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const url = `${autoMatchBaseUrl()}/api/tender-attachment?href=${encodeURIComponent(params.href)}&realName=${encodeURIComponent(params.attachmentName || 'attachment')}`
      const resp = await fetch(url, { signal: AbortSignal.timeout(90000) })

      if (resp.ok) {
        const data = Buffer.from(await resp.arrayBuffer())
        return { ok: true, data }
      }

      const detail = await readHttpErrorMessage(resp)
      lastError = detail
        ? `attachment failed: ${resp.status}: ${detail}`
        : `attachment failed: ${resp.status}`
      if (attempt < retries && isRetryableStatus(resp.status)) {
        await sleepMs(baseDelayMs * Math.pow(2, attempt))
        continue
      }
      return { ok: false, error: `${lastError} (attempt ${attempt + 1}/${retries + 1})` }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      if (attempt < retries) {
        await sleepMs(baseDelayMs * Math.pow(2, attempt))
        continue
      }
      return { ok: false, error: `attachment failed: ${lastError} (attempt ${attempt + 1}/${retries + 1})` }
    }
  }

  return { ok: false, error: lastError }
}

async function runMatchForAttachment(params: {
  data: Buffer
  filename: string
  auctionNumber: string | null
  customerName: string | null
  customerInn: string | null
  auctionPrice: number | null
  sourceUrl: string | null
  disableLlm?: boolean
  forceAllLibraryCandidates?: boolean
  autoMode?: boolean
}): Promise<{ ok: boolean; json?: any; error?: string }> {
  const safeFilename = params.filename.replace(/[\r\n"]/g, ' ').replace(/\s+/g, ' ').trim() || 'attachment.bin'
  const retries = Math.max(0, Number(process.env.AUTO_MATCH_MATCH_RETRIES ?? 0))
  const baseDelayMs = Math.max(100, Number(process.env.AUTO_MATCH_RETRY_BASE_DELAY_MS ?? 1200))
  const matchTimeoutMs = Math.max(10000, Number(process.env.AUTO_MATCH_MATCH_TIMEOUT_MS ?? 60000))

  let lastError = 'match failed'
  for (let attempt = 0; attempt <= retries; attempt++) {
    const form = new FormData()
    const blob = new Blob([Uint8Array.from(params.data)], { type: 'application/octet-stream' })
    form.append('file', blob, safeFilename)
    form.append('clientFilename', safeFilename)
    if (params.auctionNumber) form.append('auctionNumber', params.auctionNumber)
    if (params.customerName) form.append('customerName', params.customerName)
    if (params.customerInn) form.append('customerInn', params.customerInn)
    if (typeof params.auctionPrice === 'number' && Number.isFinite(params.auctionPrice)) {
      form.append('auctionPrice', String(params.auctionPrice))
    }
    if (params.sourceUrl) form.append('sourceUrl', params.sourceUrl)
    form.append('sendEmail', 'false')
    if (params.disableLlm) form.append('disableLlm', 'true')
    if (params.forceAllLibraryCandidates) form.append('forceAllLibraryCandidates', 'true')
    if (params.autoMode) form.append('autoMode', 'true')

    try {
      const resp = await fetch(`${autoMatchBaseUrl()}/api/match`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(matchTimeoutMs),
      })
      const json: any = await resp.json().catch(() => null)
      if (resp.ok) return { ok: true, json }

      lastError = json?.error ?? `match failed: ${resp.status}`
      if (attempt < retries && isRetryableStatus(resp.status)) {
        await sleepMs(baseDelayMs * Math.pow(2, attempt))
        continue
      }
      return { ok: false, error: `${lastError} (attempt ${attempt + 1}/${retries + 1})` }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      if (attempt < retries) {
        await sleepMs(baseDelayMs * Math.pow(2, attempt))
        continue
      }
      return { ok: false, error: `${lastError} (attempt ${attempt + 1}/${retries + 1})` }
    }
  }

  return { ok: false, error: lastError }
}

async function runAutoMatchCycle(trigger: 'interval' | 'manual'): Promise<void> {
  if (autoMatchRunInProgress) return
  autoMatchRunInProgress = true
  autoMatchState.running = true
  autoMatchState.currentRunStartedAt = new Date().toISOString()
  autoMatchState.lastRunAt = autoMatchState.currentRunStartedAt
  // Per-run counters: reset at the beginning of every new cycle.
  autoMatchState.stats = {
    processed: 0,
    matched: 0,
    noMatch: 0,
    skipped: 0,
    errors: 0,
  }
  autoMatchState.currentItem = {
    stage: 'keys',
    updatedAt: new Date().toISOString(),
  }
  await saveAutoMatchState().catch(() => undefined)

  const maxKeys = parsePositiveLimit(process.env.AUTO_MATCH_MAX_KEYS, Number.POSITIVE_INFINITY)
  const maxTendersPerKey = parsePositiveLimit(process.env.AUTO_MATCH_MAX_TENDERS_PER_KEY, Number.POSITIVE_INFINITY)
  const maxAttachmentsPerTender = parsePositiveLimit(
    process.env.AUTO_MATCH_MAX_ATTACHMENTS_PER_TENDER,
    Number.POSITIVE_INFINITY,
  )
  const forceAllLibraryCandidates = String(process.env.AUTO_MATCH_FORCE_ALL_LIBRARY_CANDIDATES ?? 'false') === 'true'
  const historyErrorDedup = new Set<string>()

  try {
    const keyList = await fetchAutoMatchAllKeys()
    const keys = Number.isFinite(maxKeys) ? keyList.slice(0, maxKeys) : keyList
    for (const key of keys) {
      const keyId = String(key._id ?? '').trim()
      if (!keyId) continue
      autoMatchState.currentItem = {
        stage: 'tenders',
        keyId,
        updatedAt: new Date().toISOString(),
      }

      let tenders: Array<{ _id: string; orderName: string }> = []
      try {
        const tendersResp = await fetch(`${autoMatchBaseUrl()}/api/tender-tenders?key=${encodeURIComponent(keyId)}`, {
          signal: AbortSignal.timeout(30000),
        })
        const tendersJson: any = await tendersResp.json().catch(() => null)
        if (!tendersResp.ok) {
          const detail = await readHttpErrorMessage(tendersResp)
          const message = detail
            ? `tenders failed: ${tendersResp.status}: ${detail}`
            : (tendersJson?.error ?? `tenders failed: ${tendersResp.status}`)
          const dedupKey = `tenders|${keyId}|${message}`
          if (!historyErrorDedup.has(dedupKey)) {
            historyErrorDedup.add(dedupKey)
            autoMatchPushHistory({
              timestamp: new Date().toISOString(),
              keyId,
              tenderId: '',
              attachmentName: '',
              status: 'error',
              message,
            })
          }
          autoMatchState.stats.errors++
          continue
        }
        const raw = Array.isArray(tendersJson?.tenders) ? tendersJson.tenders : []
        const normalized = raw
          .filter((x: any) => typeof x?._id === 'string')
          .map((x: any) => ({ _id: String(x._id), orderName: String(x?.orderName ?? '') }))
        tenders = Number.isFinite(maxTendersPerKey) ? normalized.slice(0, maxTendersPerKey) : normalized
      } catch (e) {
        autoMatchPushHistory({
          timestamp: new Date().toISOString(),
          keyId,
          tenderId: '',
          attachmentName: '',
          status: 'error',
          message: e instanceof Error ? e.message : String(e),
        })
        autoMatchState.stats.errors++
        continue
      }

      for (const tender of tenders) {
        autoMatchState.currentItem = {
          stage: 'tender_details',
          keyId,
          tenderId: tender._id,
          updatedAt: new Date().toISOString(),
        }
        let details: any = null
        try {
          const dResp = await fetch(`${autoMatchBaseUrl()}/api/tenders/get?id=${encodeURIComponent(tender._id)}`, {
            signal: AbortSignal.timeout(30000),
          })
          const dJson: any = await dResp.json().catch(() => null)
          if (!dResp.ok) {
            const detail = await readHttpErrorMessage(dResp)
            const message = detail
              ? `tender details failed: ${dResp.status}: ${detail}`
              : (dJson?.error ?? `tender details failed: ${dResp.status}`)
            const dedupKey = `details|${keyId}|${tender._id}|${message}`
            if (!historyErrorDedup.has(dedupKey)) {
              historyErrorDedup.add(dedupKey)
              autoMatchPushHistory({
                timestamp: new Date().toISOString(),
                keyId,
                tenderId: tender._id,
                attachmentName: '',
                status: 'error',
                message,
              })
            }
            autoMatchState.stats.errors++
            continue
          }
          details = dJson
        } catch (e) {
          autoMatchPushHistory({
            timestamp: new Date().toISOString(),
            keyId,
            tenderId: tender._id,
            attachmentName: '',
            status: 'error',
            message: e instanceof Error ? e.message : String(e),
          })
          autoMatchState.stats.errors++
          continue
        }

        const allAttachments = Array.isArray(details?.attachments) ? details.attachments : []
        const attachments = Number.isFinite(maxAttachmentsPerTender)
          ? allAttachments.slice(0, maxAttachmentsPerTender)
          : allAttachments
        for (const a of attachments) {
          const attachmentName = String(a?.realName ?? '')
          const href = String(a?.href ?? '')
          if (!href) continue
          autoMatchState.currentItem = {
            stage: 'attachment_download',
            keyId,
            tenderId: tender._id,
            attachmentName,
            updatedAt: new Date().toISOString(),
          }
          autoMatchState.stats.processed++

          try {
            const dlResult = await downloadTenderAttachmentWithRetry({
              href,
              attachmentName: attachmentName || 'attachment',
            })
            if (!dlResult.ok) {
              const message = dlResult.error
              const dedupKey = `attachment|${keyId}|${tender._id}|${href}|${message}`
              autoMatchState.stats.errors++
              if (!historyErrorDedup.has(dedupKey)) {
                historyErrorDedup.add(dedupKey)
                autoMatchPushHistory({
                  timestamp: new Date().toISOString(),
                  keyId,
                  tenderId: tender._id,
                  attachmentName,
                  status: 'error',
                  message,
                })
              }
              continue
            }

            const match = await runMatchForAttachment({
              data: dlResult.data,
              filename: attachmentName || 'attachment',
              auctionNumber: asNonEmptyString(details?.auctionNumber),
              customerName: asNonEmptyString(details?.customerName),
              customerInn: asNonEmptyString(details?.customerInn),
              auctionPrice: asNullableNumber(details?.maxPrice),
              sourceUrl: asNonEmptyString(details?.href),
              disableLlm: true,
              forceAllLibraryCandidates,
              autoMode: true,
            })
            autoMatchState.currentItem = {
              stage: 'matching',
              keyId,
              tenderId: tender._id,
              attachmentName,
              updatedAt: new Date().toISOString(),
            }

            if (!match.ok) {
              const message = String(match.error ?? 'match failed')
              const dedupKey = `match|${keyId}|${tender._id}|${attachmentName}|${message}`
              autoMatchState.stats.errors++
              if (!historyErrorDedup.has(dedupKey)) {
                historyErrorDedup.add(dedupKey)
                autoMatchPushHistory({
                  timestamp: new Date().toISOString(),
                  keyId,
                  tenderId: tender._id,
                  attachmentName,
                  status: 'error',
                  message,
                })
              }
              continue
            }

            const decision = String(match.json?.decision ?? '')
            const crmNotification = match.json?.crmNotification
            if (decision === 'match') {
              const crmSent = Boolean(crmNotification?.sent)
              if (crmSent) {
                autoMatchState.stats.matched++
                autoMatchPushHistory({
                  timestamp: new Date().toISOString(),
                  keyId,
                  tenderId: tender._id,
                  attachmentName,
                  status: 'matched',
                  matchPercent: Number(match.json?.matchPercent ?? 0),
                  bestMatchFilename: typeof match.json?.bestMatchFilename === 'string' ? match.json.bestMatchFilename : null,
                })
              } else {
                autoMatchState.stats.skipped++
                autoMatchPushHistory({
                  timestamp: new Date().toISOString(),
                  keyId,
                  tenderId: tender._id,
                  attachmentName,
                  status: 'skipped',
                  message: typeof crmNotification?.reason === 'string' ? crmNotification.reason : 'Skipped',
                  matchPercent: Number(match.json?.matchPercent ?? 0),
                  bestMatchFilename: typeof match.json?.bestMatchFilename === 'string' ? match.json.bestMatchFilename : null,
                })
              }
            } else {
              autoMatchState.stats.noMatch++
              autoMatchPushHistory({
                timestamp: new Date().toISOString(),
                keyId,
                tenderId: tender._id,
                attachmentName,
                status: 'no_match',
                matchPercent: Number(match.json?.matchPercent ?? 0),
                bestMatchFilename: typeof match.json?.bestMatchFilename === 'string' ? match.json.bestMatchFilename : null,
              })
            }
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            const dedupKey = `runtime|${keyId}|${tender._id}|${attachmentName}|${message}`
            autoMatchState.stats.errors++
            if (!historyErrorDedup.has(dedupKey)) {
              historyErrorDedup.add(dedupKey)
              autoMatchPushHistory({
                timestamp: new Date().toISOString(),
                keyId,
                tenderId: tender._id,
                attachmentName,
                status: 'error',
                message,
              })
            }
          }
        }
      }
    }
  } finally {
    autoMatchState.running = false
    autoMatchState.currentRunStartedAt = null
    autoMatchState.lastRunFinishedAt = new Date().toISOString()
    autoMatchState.currentItem = null
    autoMatchRunInProgress = false
    await saveAutoMatchState().catch(() => undefined)
    // Trigger field is kept to make debugging easier in future extension.
    void trigger
  }
}

app.get('/api/auto-match/status', async (_req, res) => {
  res.json({ ok: true, ...autoMatchState })
})

app.post('/api/auto-match/start', express.json(), async (req, res) => {
  const interval = String(req.body?.interval ?? autoMatchState.interval) as AutoMatchIntervalCode
  if (!Object.prototype.hasOwnProperty.call(AUTO_MATCH_INTERVALS_MS, interval)) {
    return res.status(400).json({ error: 'Invalid interval. Allowed: 3m,5m,10m,30m,60m' })
  }
  autoMatchState.enabled = true
  autoMatchState.interval = interval
  startAutoMatchScheduler()
  await saveAutoMatchState().catch(() => undefined)
  res.json({ ok: true, ...autoMatchState })
})

app.post('/api/auto-match/stop', async (_req, res) => {
  autoMatchState.enabled = false
  stopAutoMatchScheduler()
  await saveAutoMatchState().catch(() => undefined)
  res.json({ ok: true, ...autoMatchState })
})

app.post('/api/auto-match/run-once', async (_req, res) => {
  if (autoMatchRunInProgress) {
    return res.json({ ok: true, started: false, alreadyRunning: true })
  }
  void runAutoMatchCycle('manual')
  res.json({ ok: true, started: true, alreadyRunning: false })
})

const port = Number(process.env.PORT ?? 3001)

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${port}`)
  void (async () => {
    await loadAutoMatchState()
    if (autoMatchState.enabled) {
      startAutoMatchScheduler()
    }
  })()
})


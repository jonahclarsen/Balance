import { expect, test } from '@playwright/test'
import { createDailyTemplate, createListTemplate, createListTemplateItem, createTemplateItem, generateListFromTemplate, generatePlanFromTemplate } from '../../src/lib/planner'
import { expandTemplateTimes, vancouverSunsetMinutes } from '../../src/lib/templateTimes'
import { VANCOUVER_SUNSETS } from '../../src/lib/vancouverSunsets'
import { createInitialState } from '../../src/lib/planner'
import { reconcileTaskNotifications } from '../../src/lib/taskNotifications'
import type { TaskNotification } from '../../src/lib/types'

const date = '2026-10-01'
const expand = (text: string) => expandTemplateTimes(text, text, date).text

test('both delimiters expand with signed hours and minutes, whitespace and repeated tokens', () => {
  expect(expand('{sunset} / [sunset] / {sunset +5m} / [sunset-2h3m]')).toBe('6:51 PM / 6:51 PM / 6:56 PM / 4:48 PM')
  expect(expand('{SUNSET +2H3M} [sunset -5m] {sunset+90m}')).toBe('8:54 PM 6:46 PM 8:21 PM')
})

test('offsets wrap in either direction, including multiple days, noon and midnight', () => {
  expect(expand('{sunset+24h} [sunset+48h5m] {sunset-72h}')).toBe('6:51 PM 6:56 PM 6:51 PM')
  expect(expand('{sunset+6h} {sunset-20h} {sunset+5h9m} {sunset-6h51m}')).toBe('12:51 AM 10:51 PM 12:00 AM 12:00 PM')
})

test('invalid tokens and unsafe offsets stay literal', () => {
  for (const token of ['[sunset}', '{sunset]', '{sunset+}', '[sunset+2]', '{sunset-2d}', '[sunset+1.5h]', '{sunset+1h-2m}', '{sunset+999999999999999999999h}']) {
    expect(expand(token)).toBe(token)
  }
})

test('bounds clamp a computed time, including past midnight and in rich text', () => {
  // 2026-10-01 sunset is 6:51 PM; 2026-06-21 is 9:22 PM.
  expect(expand('{sunset+4h <10pm} [sunset+2h <10pm] {sunset-3h >5pm} {sunset+4h ≤ 10:30PM}')).toBe('10:00 PM 8:51 PM 5:00 PM 10:30 PM')
  expect(expandTemplateTimes('{sunset+4h <10pm}', '', '2026-06-21').text).toBe('10:00 PM')
  expect(expandTemplateTimes('{sunset+4h <1am} {sunset >8pm <9pm}', '', '2026-06-21').text).toBe('1:00 AM 9:00 PM')
  expect(expandTemplateTimes('', '<p>Bed <b>{sunset+4h &lt;10pm}</b></p>', date).html).toBe('<p>Bed <b>10:00 PM</b></p>')
})

test('bare clock times expand like sunset, with offsets and bounds', () => {
  expect(expand('{10am} [7:30pm] {22:15} {12am} {12pm} {9am+90m} {9am <8am}')).toBe('10:00 AM 7:30 PM 10:15 PM 12:00 AM 12:00 PM 10:30 AM 8:00 AM')
  for (const token of ['{10}', '[13pm]', '{0am}', '{9:60am}', '{24:00}', '{note}', '[x]', '{sunset <10}', '{10am <}']) {
    expect(expand(token)).toBe(token)
  }
})

test('clock-time notifications use Vancouver time and roll early-morning times to the next night', () => {
  const template = createDailyTemplate('Synthetic')
  template.items = [createTemplateItem('Stretch {10am}, bed {sunset+4h <10pm}, lights [1am]')]
  const records: TaskNotification[] = []
  generatePlanFromTemplate(template, '2026-06-21', '', [], [], {}, [], [], records)
  expect(records.map(record => record.at)).toEqual([
    Date.parse('2026-06-21T17:00:00Z'),
    Date.parse('2026-06-22T05:00:00Z'),
    Date.parse('2026-06-22T08:00:00Z'),
  ])
  const winter = createDailyTemplate('Synthetic')
  winter.items = [createTemplateItem('{10am}')]
  const winterRecords: TaskNotification[] = []
  // Historical winter avoids depending on the runner's future timezone rules.
  generatePlanFromTemplate(winter, '2025-12-01', '', [], [], {}, [], [], winterRecords)
  expect(winterRecords.map(record => record.at)).toEqual([Date.parse('2025-12-01T18:00:00Z')])
})

test('lookup covers complete leap and common years with seasonally appropriate UTC sunsets', () => {
  expect(Object.keys(VANCOUVER_SUNSETS)).toHaveLength(100)
  for (let year = 2000; year <= 2099; year++) {
    const days = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000
    expect(VANCOUVER_SUNSETS[year]).toHaveLength(days)
    expect(VANCOUVER_SUNSETS[year].every(minutes => Number.isInteger(minutes) && minutes >= 1440 && minutes <= 1710)).toBe(true)
  }
  // Sea-level Vancouver winter and summer sunset: 00:25 and 04:22 UTC next day.
  expect(VANCOUVER_SUNSETS[2026][0]).toBe(1465)
  expect(VANCOUVER_SUNSETS[2026][171]).toBe(1702)
  expect(vancouverSunsetMinutes('2024-02-29')).toBe(17 * 60 + 55)
})

test('Vancouver timezone conversion uses the target date, independent of host timezone', () => {
  for (const date of ['2026-03-07', '2026-03-08', '2026-11-01', '2026-12-31']) {
    const midnight = Date.parse(`${date}T00:00:00Z`)
    const day = (midnight - Date.UTC(2026, 0, 1)) / 86400000
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hourCycle: 'h23', hour: 'numeric', minute: '2-digit' })
      .formatToParts(midnight + VANCOUVER_SUNSETS[2026][day] * 60000)
    expect(vancouverSunsetMinutes(date)).toBe(Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value))
  }
})

test('invalid and out-of-range dates keep placeholders literal', () => {
  for (const date of ['2026-02-29', '2024-02-30', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-1', '1999-12-31', '2100-01-01', 'invalid']) {
    expect(vancouverSunsetMinutes(date)).toBeNull()
    expect(expandTemplateTimes('{sunset}', '<b>{sunset}</b>', date)).toEqual({ text: '{sunset}', html: '<b>{sunset}</b>' })
  }
})

test('rich text expands across inline formatting and encoded whitespace, leaving attributes intact', () => {
  const html = '<a href="https://example.com/{sunset}" title="[sunset]">Walk <b>{sun</b><i>set&nbsp;+5m}</i></a> &#91;sunset-2h3m&#93;'
  expect(expandTemplateTimes('Walk {sunset +5m} [sunset-2h3m]', html, date)).toEqual({
    text: 'Walk 6:56 PM 4:48 PM',
    html: '<a href="https://example.com/{sunset}" title="[sunset]">Walk <b>6:56 PM</b><i></i></a> 4:48 PM',
  })
  expect(expandTemplateTimes('', '<div>{sunset</div><div>+5m}</div>', date).html).toBe('<div>{sunset</div><div>+5m}</div>')
})

test('day generation expands selected options and nested rows while preserving the template', () => {
  const template = createDailyTemplate('Synthetic')
  const parent = createTemplateItem('Walk {sunset}')
  parent.options[0].html = '<b>Walk {sunset}</b>'
  parent.children = [createTemplateItem('[sunset-2h3m]')]
  template.items = [parent]
  const original = structuredClone(template)
  const generated = generatePlanFromTemplate(template, date)
  expect(generated.items[0].text).toBe('Walk 6:51 PM')
  expect(generated.items[0].html).toBe('<b>Walk 6:51 PM</b>')
  expect(generated.items[0].children[0].text).toBe('4:48 PM')
  expect(generatePlanFromTemplate(template, '2026-06-21').items[0].text).toBe('Walk 9:22 PM')
  expect(template).toEqual(original)
})

test('list generation expands nested rows and plain HTML fallbacks with the list date', () => {
  const template = createListTemplate('Synthetic')
  const parent = createListTemplateItem('Walk [sunset]')
  parent.html = ''
  parent.children = [createListTemplateItem('{sunset+48h5m}')]
  template.items = [parent]
  const original = structuredClone(template)
  const generated = generateListFromTemplate(template, date)
  expect(generated.items[0].text).toBe('Walk 6:51 PM')
  expect(generated.items[0].html).toBe('Walk 6:51 PM')
  expect(generated.items[0].children[0].text).toBe('6:56 PM')
  expect(generateListFromTemplate(template, '2026-06-21').items[0].text).toBe('Walk 9:22 PM')
  expect(template).toEqual(original)
})

test('notification snapshots retain generated text and absolute rollover dates, deduplicating repeated times', () => {
  const template = createDailyTemplate('Synthetic')
  template.items = [createTemplateItem('{sunset+6h} then [sunset+6h] and {sunset-20h}')]
  const records: TaskNotification[] = []
  const plan = generatePlanFromTemplate(template, date, '', [], [], {}, [], [], records)
  expect(records.map(record => record.at)).toEqual([Date.parse('2026-10-02T07:51:00Z'), Date.parse('2026-10-01T05:51:00Z')])
  expect(records.every(record => record.sourceId === plan.id && record.itemId === plan.items[0].id && record.text === plan.items[0].text)).toBe(true)
  const before = { ...createInitialState(), plans: [plan], taskNotifications: records }
  const edited = { ...before, plans: [{ ...plan, items: [{ ...plan.items[0], text: 'Edited later' }] }] }
  expect(reconcileTaskNotifications(before, edited).taskNotifications).toBe(records)
  const aliased = { ...before, plans: [{ ...plan, id: 'replacement-day-id' }] }
  expect(reconcileTaskNotifications(before, aliased).taskNotifications).toBe(records)
  expect(reconcileTaskNotifications(before, { ...before, plans: [] }).taskNotifications).toEqual([])
  expect(reconcileTaskNotifications(before, { ...before, plans: [{ ...plan, items: [] }] }).taskNotifications).toEqual([])
  const future = { ...records[0], id: 'synthetic-future-source', sourceKind: 'event' } as unknown as TaskNotification
  const withFuture = { ...before, taskNotifications: [...records, future] }
  expect(reconcileTaskNotifications(withFuture, { ...withFuture, plans: [] }).taskNotifications).toEqual([future])
})

test('linked-list expansion remaps sunset notification snapshots to the generated day task IDs', () => {
  const list = createListTemplate('Synthetic walks')
  list.items = [createListTemplateItem('Walk [sunset+5m]')]
  const template = createDailyTemplate('Synthetic')
  template.items = [createTemplateItem('Synthetic walks'), createTemplateItem('Synthetic walks')]
  const records: TaskNotification[] = []
  const plan = generatePlanFromTemplate(template, date, '', [], [], {}, [list], template.items.map(item => ({ id: item.options[0].id, listTemplateIds: [list.id] })), records)
  expect(plan.items.map(item => item.text)).toEqual(['Walk 6:56 PM', 'Walk 6:56 PM'])
  expect(records).toHaveLength(2)
  for (const [index, record] of records.entries()) {
    expect(record).toMatchObject({ sourceKind: 'plan', sourceId: plan.id, itemId: plan.items[index].id, text: 'Walk 6:56 PM' })
    expect(record.id).toBe(`${plan.items[index].id}:0`)
  }
})

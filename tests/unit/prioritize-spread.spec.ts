import { expect, test } from '@playwright/test'
import { isPriorityScaleCrowded, spreadPriorityItems } from '../../src/lib/prioritize'
import type { PriorityItem } from '../../src/lib/types'

const items = (...priorities: (number | undefined)[]): PriorityItem[] =>
  priorities.map((priority, index) => ({ id: `p${index}`, text: `Item ${index}`, ...(priority === undefined ? {} : { priority }) }))
const values = (list: PriorityItem[]) => list.map((item) => item.priority)

test('crowding counts decimals and close distinct neighbours, not ties or unrated rows', () => {
  expect(isPriorityScaleCrowded(items(20, 10, undefined, 10))).toBe(false)
  expect(isPriorityScaleCrowded(items(10, 13))).toBe(true)
  expect(isPriorityScaleCrowded(items(10, 14))).toBe(false)
  expect(isPriorityScaleCrowded(items(20, 8.5))).toBe(true)
  expect(isPriorityScaleCrowded(items())).toBe(false)
})

test('spreading doubles whole scales and clears decimals in one step', () => {
  expect(values(spreadPriorityItems(items(9, 8, 8, undefined, 0)))).toEqual([18, 16, 16, undefined, 0])
  expect(values(spreadPriorityItems(items(9, 8.5, 8)))).toEqual([18, 17, 16])
  expect(values(spreadPriorityItems(items(9, 8.25)))).toEqual([36, 33])
  expect(values(spreadPriorityItems(items(9, 8.3, 8.5)))).toEqual([90, 83, 85])
})

test('repeated spreading eventually leaves room between every value', () => {
  let list = items(3, 2.5, 2, 1)
  let presses = 0
  while (isPriorityScaleCrowded(list)) {
    list = spreadPriorityItems(list)
    presses += 1
  }
  expect(values(list)).toEqual([24, 20, 16, 8])
  expect(presses).toBe(3)
})

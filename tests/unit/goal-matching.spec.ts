import { expect, test } from '@playwright/test'
import { goalNameMatchesAnyTerm } from '../../src/lib/goals'

test('goal names use checked-item matching semantics', () => {
  expect(goalNameMatchesAnyTerm('Strenuous exercise', ['exercise', 'lift'])).toBe(true)
  expect(goalNameMatchesAnyTerm('Write music', ['beat'])).toBe(false)
  expect(goalNameMatchesAnyTerm('Adjust the plan', ['just'])).toBe(false)
  expect(goalNameMatchesAnyTerm('Morning run', ['RUN'])).toBe(true)
})

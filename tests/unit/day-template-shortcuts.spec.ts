import { expect, test } from '@playwright/test'
import { dayTemplateShortcutLetters } from '../../src/lib/dayTemplateShortcuts'

test('each template takes the first letter of its name that is still free', () => {
  expect(dayTemplateShortcutLetters(['Workday', 'Weekend', 'Wellness day', 'ww', '', '1 2'])).toEqual(['W', 'E', 'L', null, null, null])
  expect(dayTemplateShortcutLetters(['Rest', 'rest'])).toEqual(['R', 'E'])
})

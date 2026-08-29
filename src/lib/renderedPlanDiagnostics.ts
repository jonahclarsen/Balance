export type RenderedPlanRowDiagnostic = {
  rowIndex: number
  itemId: string
  planId: string
  depth: number | null
  checkboxCount: number
  checkboxChecked: boolean | null
  checkboxDefaultChecked: boolean | null
  checkedAttributePresent: boolean | null
  checkboxIndeterminate: boolean | null
  rowDoneClass: boolean
  editorDoneClass: boolean | null
}

export type RenderedPlanPaneDiagnostic = {
  paneIndex: number
  comparisonPane: boolean
  date: string
  rows: RenderedPlanRowDiagnostic[]
}

export type RenderedPlanDiagnosticSnapshot = {
  capturedAtMs: number
  mobileLayout: boolean
  documentVisible: boolean
  panes: RenderedPlanPaneDiagnostic[]
}

let lastNonEmptySnapshot: RenderedPlanDiagnosticSnapshot | null = null

/**
 * Capture only structural DOM state. No task text, labels, HTML, URLs, or other
 * user-authored content enters this snapshot. Raw ids and dates never leave the
 * process: the native diagnostic exporter replaces them with account-keyed
 * one-way tokens before writing the trace.
 */
export function captureRenderedPlanSnapshot(): RenderedPlanDiagnosticSnapshot | null {
  const panes = Array.from(document.querySelectorAll<HTMLElement>('.day-pane')).map((pane, paneIndex) => {
    const date = pane.querySelector<HTMLInputElement>('.date-input')?.value ?? ''
    const rows = Array.from(pane.querySelectorAll<HTMLElement>('[data-plan-item-id]')).map((row, rowIndex) => {
      const checkboxes = Array.from(row.querySelectorAll<HTMLInputElement>(':scope > .check-target > input.check'))
      const checkbox = checkboxes[0] ?? null
      const editor = row.querySelector<HTMLElement>(':scope > .plan-item-main [data-plan-text-input]')
      return {
        rowIndex,
        itemId: row.dataset.planItemId ?? '',
        planId: row.dataset.itemContainerId ?? '',
        depth: parseOptionalInteger(row.dataset.planItemDepth),
        checkboxCount: checkboxes.length,
        checkboxChecked: checkbox?.checked ?? null,
        checkboxDefaultChecked: checkbox?.defaultChecked ?? null,
        checkedAttributePresent: checkbox ? checkbox.hasAttribute('checked') : null,
        checkboxIndeterminate: checkbox?.indeterminate ?? null,
        rowDoneClass: row.classList.contains('done'),
        editorDoneClass: editor ? editor.classList.contains('done') : null,
      }
    })
    return {
      paneIndex,
      comparisonPane: pane.getAttribute('aria-label') === 'Compared day',
      date,
      rows,
    }
  })
  const snapshot = {
    capturedAtMs: Date.now(),
    mobileLayout: window.matchMedia('(max-width: 760px)').matches,
    documentVisible: document.visibilityState === 'visible',
    panes,
  }
  if (panes.some((pane) => pane.rows.length > 0)) lastNonEmptySnapshot = snapshot
  return panes.length > 0 ? snapshot : null
}

export function getLastRenderedPlanSnapshot(): RenderedPlanDiagnosticSnapshot | null {
  return lastNonEmptySnapshot ? structuredClone(lastNonEmptySnapshot) : null
}

function parseOptionalInteger(value: string | undefined): number | null {
  if (value === undefined || !/^-?\d+$/.test(value)) return null
  return Number(value)
}

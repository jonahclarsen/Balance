const ANIMATION_DURATION_SECONDS = 12

function easeInOutElapsedFractionForProgress(progress: number): number {
  // CSS ease-in-out is cubic-bezier(0.42, 0, 0.58, 1). Find the curve
  // parameter for the desired visible progress, then return its elapsed time.
  let low = 0
  let high = 1
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const parameter = (low + high) / 2
    const visibleProgress = parameter * parameter * (3 - 2 * parameter)
    if (visibleProgress < progress) low = parameter
    else high = parameter
  }

  const parameter = (low + high) / 2
  const inverse = 1 - parameter
  return 3 * inverse * inverse * parameter * 0.42
    + 3 * inverse * parameter * parameter * 0.58
    + parameter * parameter * parameter
}

export function randomIridescentSelectionAnimationDelay(): string {
  // Sampling elapsed time directly makes ease-in-out cluster visibly near its
  // two endpoints. Sample visible progress uniformly, then randomly enter the
  // forward or reverse half of the alternating animation cycle.
  const elapsedFraction = easeInOutElapsedFractionForProgress(Math.random())
  const cycleFraction = Math.random() < 0.5 ? elapsedFraction : 2 - elapsedFraction
  return `${-cycleFraction * ANIMATION_DURATION_SECONDS}s`
}

export function restartElementAnimations(element: Element | null | undefined) {
  for (const animation of element?.getAnimations() ?? []) animation.currentTime = 0
}

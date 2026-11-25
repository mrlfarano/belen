/**
 * Pure scroll decisions for the room, extracted so Vitest can cover every
 * path without a DOM: follow vs. preserve, the frozen history anchor, and
 * the prepend compensation for "load older blocks".
 */

/** "At or near the bottom" — anything within this many px keeps following. */
export const FOLLOW_THRESHOLD_PX = 64
/** Scroll up this close to the very top to load older blocks. */
export const LOAD_MORE_THRESHOLD_PX = 48
/** How many blocks the visible window grows by when loading history. */
export const WINDOW_STEP = 120
export const WINDOW_INITIAL = 120

export function distanceToBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight)
}

export const shouldFollow = (distance: number): boolean => distance <= FOLLOW_THRESHOLD_PX

export const shouldLoadMore = (scrollTop: number): boolean => scrollTop <= LOAD_MORE_THRESHOLD_PX

/**
 * When the user scrolls away from the bottom, freeze the window at the oldest
 * block they can currently see. While frozen, new blocks append below the
 * viewport and the slice start never slides — their position is stable even
 * in rooms longer than the window.
 */
export function anchorOnUnfollow(orderLength: number, visibleCount: number): number {
  return Math.max(0, orderLength - visibleCount)
}

/**
 * The visible window. Following shows the newest `visibleCount` blocks;
 * reading history shows everything from the frozen anchor down (new blocks
 * included — they are below the viewport anyway).
 */
export function visibleWindow(
  orderLength: number,
  visibleCount: number,
  anchor: number,
  following: boolean,
): { start: number; count: number } {
  if (orderLength === 0) return { start: 0, count: 0 }
  if (following) {
    const start = Math.max(0, orderLength - visibleCount)
    return { start, count: orderLength - start }
  }
  const start = Math.min(Math.max(0, anchor), orderLength)
  return { start, count: orderLength - start }
}

/** Height delta to add to scrollTop after older blocks were prepended. */
export function prependShift(beforeHeight: number, afterHeight: number): number {
  return Math.max(0, afterHeight - beforeHeight)
}

/** Older blocks exist to load when the frozen anchor is not at the top. */
export const hasMoreHistory = (anchor: number): boolean => anchor > 0

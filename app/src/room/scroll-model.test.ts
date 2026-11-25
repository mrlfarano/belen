import { describe, expect, it } from 'vitest'
import {
  WINDOW_INITIAL,
  WINDOW_STEP,
  anchorOnUnfollow,
  distanceToBottom,
  hasMoreHistory,
  prependShift,
  shouldFollow,
  shouldLoadMore,
  visibleWindow,
} from './scroll-model'

describe('distanceToBottom', () => {
  it('is zero when fully scrolled', () => {
    expect(distanceToBottom(900, 1000, 100)).toBe(0)
  })

  it('grows as the reader scrolls up', () => {
    expect(distanceToBottom(500, 1000, 100)).toBe(400)
  })

  it('never goes negative when content overflows oddly', () => {
    expect(distanceToBottom(1000, 900, 200)).toBe(0)
  })
})

describe('follow decisions', () => {
  it('follows at and near the bottom', () => {
    expect(shouldFollow(0)).toBe(true)
    expect(shouldFollow(64)).toBe(true)
  })

  it('stops following once the reader scrolls up', () => {
    expect(shouldFollow(65)).toBe(false)
    expect(shouldFollow(400)).toBe(false)
  })

  it('offers load-more only at the very top', () => {
    expect(shouldLoadMore(0)).toBe(true)
    expect(shouldLoadMore(48)).toBe(true)
    expect(shouldLoadMore(49)).toBe(false)
  })
})

describe('history anchor', () => {
  it('freezes at the oldest visible block when unfollowing', () => {
    expect(anchorOnUnfollow(300, WINDOW_INITIAL)).toBe(180)
  })

  it('clamps to zero for short rooms', () => {
    expect(anchorOnUnfollow(50, WINDOW_INITIAL)).toBe(0)
  })

  it('steps back by a window when loading older blocks', () => {
    const anchor = anchorOnUnfollow(400, WINDOW_INITIAL)
    expect(Math.max(0, anchor - WINDOW_STEP)).toBe(160)
  })

  it('reports more history only when the anchor is past the top', () => {
    expect(hasMoreHistory(120)).toBe(true)
    expect(hasMoreHistory(0)).toBe(false)
  })
})

describe('visibleWindow', () => {
  it('shows the newest N blocks while following', () => {
    const w = visibleWindow(300, 120, 0, true)
    expect(w.start).toBe(180)
    expect(w.count).toBe(120)
  })

  it('shows the whole room when it is short', () => {
    const w = visibleWindow(80, 120, 0, true)
    expect(w).toEqual({ start: 0, count: 80 })
  })

  it('freezes the start while reading history, even as new blocks arrive', () => {
    // Reader unfollowed at block 300 (anchor 180): streaming 40 more must not slide.
    const before = visibleWindow(300, 120, 180, false)
    const after = visibleWindow(340, 120, 180, false)
    expect(before.start).toBe(180)
    expect(after.start).toBe(180)
    expect(after.count).toBe(160)
  })

  it('respects the step-back anchor after loading older blocks', () => {
    const w = visibleWindow(400, 240, 160, false)
    expect(w.start).toBe(160)
  })

  it('handles an empty room', () => {
    expect(visibleWindow(0, 120, 0, true)).toEqual({ start: 0, count: 0 })
  })
})

describe('prependShift', () => {
  it('returns the height delta to compensate scrolling', () => {
    expect(prependShift(5000, 7000)).toBe(2000)
  })

  it('never moves the viewport backwards', () => {
    expect(prependShift(7000, 5000)).toBe(0)
  })
})

describe('room switch', () => {
  it('resetting lands on the newest block and resumes following', () => {
    // resetScroll sets: following=true, anchor=0, visible=WINDOW_INITIAL.
    const w = visibleWindow(9999, WINDOW_INITIAL, 0, true)
    expect(w.count).toBe(WINDOW_INITIAL)
    expect(w.start + w.count).toBe(9999)
  })
})

import { describe, expect, test } from 'bun:test'
import {
  activeEntries,
  createChatState,
  createDefaultSettings,
  macroValue,
  normalizeSettings,
  pendingMessages,
  selectChapterBatch,
  selectPromotionBatch,
  type SummaryEntry,
} from './core'

function entry(
  id: string,
  level: 'chapter' | 'arc' | 'volume',
  orderStart: number,
  orderEnd = orderStart,
): SummaryEntry {
  return {
    id,
    level,
    content: id,
    orderStart,
    orderEnd,
    active: true,
    sourceIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('settings', () => {
  test('uses the agreed v0.0.1 defaults', () => {
    expect(createDefaultSettings()).toMatchObject({
      automationEnabled: true,
      messagesPerChapter: 24,
      messageDelay: 12,
      chaptersPerArc: 8,
      chapterDelay: 2,
      arcsPerVolume: 8,
      arcDelay: 2,
      retries: 1,
      temperature: 0.2,
      topP: 1,
      maxTokens: 4096,
    })
  })

  test('accepts an arbitrary non-negative retry count', () => {
    expect(normalizeSettings({ retries: 999_999 }).retries).toBe(999_999)
    expect(normalizeSettings({ retries: -10 }).retries).toBe(0)
  })
})

describe('chapter batching', () => {
  test('waits for a full batch plus the lookahead delay and excludes the delay', () => {
    const settings = { ...createDefaultSettings(), messagesPerChapter: 6, messageDelay: 3 }
    const state = createChatState(true)
    const messages = Array.from({ length: 9 }, (_, index) => ({
      id: String(index + 1),
      content: `message ${index + 1}`,
    }))

    expect(selectChapterBatch(messages.slice(0, 8), state, settings)).toBeNull()
    expect(selectChapterBatch(messages, state, settings)?.map((message) => message.id))
      .toEqual(['1', '2', '3', '4', '5', '6'])
  })

  test('deletions before creation reflow the current persisted history', () => {
    const settings = { ...createDefaultSettings(), messagesPerChapter: 3, messageDelay: 1 }
    const state = createChatState(true)
    const messages = [
      { id: '1', content: 'one' },
      { id: '3', content: 'three' },
      { id: '4', content: 'four' },
      { id: '5', content: 'five' },
    ]

    expect(selectChapterBatch(messages, state, settings)?.map((message) => message.id))
      .toEqual(['1', '3', '4'])
  })

  test('processed ids prevent overlap without depending on message positions', () => {
    const messages = [
      { id: '1', content: 'one' },
      { id: '2', content: 'two' },
      { id: '3', content: 'three' },
    ]
    expect(pendingMessages(messages, ['1', '2']).map((message) => message.id)).toEqual(['3'])
  })
})

describe('promotion and macros', () => {
  test('promotes the oldest fixed batch and leaves the delay active', () => {
    const state = createChatState(true)
    state.entries = Array.from({ length: 10 }, (_, index) => entry(`c${index + 1}`, 'chapter', index + 1))

    expect(selectPromotionBatch(state, 'chapter', 8, 2)?.map((item) => item.id))
      .toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'])
  })

  test('orders mixed active entries chronologically while each macro stays level-specific', () => {
    const state = createChatState(true)
    state.entries = [
      entry('chapter-new', 'chapter', 10),
      entry('volume-old', 'volume', 1, 4),
      entry('arc-middle', 'arc', 5, 9),
      { ...entry('chapter-archived', 'chapter', 2), active: false },
    ]

    expect(activeEntries(state).map((item) => item.id))
      .toEqual(['volume-old', 'arc-middle', 'chapter-new'])
    expect(macroValue(state, 'chapter')).toBe('chapter-new')
    expect(macroValue(state, 'arc')).toBe('arc-middle')
    expect(macroValue(state, 'volume')).toBe('volume-old')
  })

  test('joins macro entries with blank lines and no extension delimiters', () => {
    const state = createChatState(true)
    state.entries = [entry('First', 'chapter', 1), entry('Second', 'chapter', 2)]
    expect(macroValue(state, 'chapter')).toBe('First\n\nSecond')
  })
})

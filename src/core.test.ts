import { describe, expect, test } from 'bun:test'
import {
  activeEntries,
  contextEntriesBefore,
  createChatState,
  createDefaultSettings,
  deleteActiveEntry,
  estimatedStreamTokens,
  hasValidContextPlaceholders,
  macroValue,
  normalizeSettings,
  orderedSourceItems,
  pendingMessages,
  renderGenerationUserPrompt,
  restoreDeletedChapterSlot,
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

describe('generation context placeholder', () => {
  test('selects only active entries strictly before the current batch', () => {
    const state = createChatState(true)
    state.entries = [
      entry('arc-1', 'arc', 1, 8),
      entry('chapter-9', 'chapter', 9),
      entry('chapter-10', 'chapter', 10),
      entry('chapter-input', 'chapter', 11),
      { ...entry('inactive-old', 'chapter', 2), active: false },
    ]

    expect(contextEntriesBefore(state, 11).map((candidate) => candidate.id))
      .toEqual(['arc-1', 'chapter-9', 'chapter-10'])
  })

  test('injects the requested number of previous entries in chronological order', () => {
    const context = [
      entry('Chapter 10', 'chapter', 10),
      entry('Arc 1', 'arc', 1, 8),
      entry('Chapter 9', 'chapter', 9),
    ]
    const template = [
      'Previous context:',
      '{{summaryPlusContext::2}}',
      '',
      'Material:',
      '{{summaryPlusInput}}',
    ].join('\n')

    expect(renderGenerationUserPrompt(template, 'new messages', context)).toBe([
      'Previous context:',
      'Chapter 9',
      '',
      'Chapter 10',
      '',
      'Material:',
      'new messages',
    ].join('\n'))
  })

  test('supports zero, fewer available entries, and inert placeholder-like source text', () => {
    const context = [{
      ...entry('previous', 'chapter', 1),
      content: 'Keep {{summaryPlusInput}} literal',
    }]
    expect(renderGenerationUserPrompt(
      '{{summaryPlusContext::0}}|{{summaryPlusInput}}',
      'Keep {{summaryPlusContext::9}} literal',
      context,
    )).toBe('|Keep {{summaryPlusContext::9}} literal')
    expect(renderGenerationUserPrompt(
      '{{summaryPlusContext::99}}',
      'unused',
      context,
    )).toBe('Keep {{summaryPlusInput}} literal')
  })

  test('accepts only non-negative integer context arguments', () => {
    expect(hasValidContextPlaceholders('No context placeholder')).toBe(true)
    expect(hasValidContextPlaceholders('{{summaryPlusContext::0}}')).toBe(true)
    expect(hasValidContextPlaceholders('{{summaryPlusContext:: 12 }}')).toBe(true)
    expect(hasValidContextPlaceholders('{{summaryPlusContext}}')).toBe(false)
    expect(hasValidContextPlaceholders('{{summaryPlusContext::-1}}')).toBe(false)
    expect(hasValidContextPlaceholders('{{summaryPlusContext::1.5}}')).toBe(false)
    expect(hasValidContextPlaceholders('{{summaryPlusContext::3')).toBe(false)
  })
})

describe('original source lookup', () => {
  test('restores sources in their recorded order', () => {
    const candidates = [
      { id: 'm3', content: 'three' },
      { id: 'm1', content: 'one' },
      { id: 'm2', content: 'two' },
    ]

    expect(orderedSourceItems(['m1', 'm2', 'm3'], candidates)?.map((item) => item.content))
      .toEqual(['one', 'two', 'three'])
  })

  test('fails when any recorded source no longer exists', () => {
    const candidates = [
      { id: 'm1', content: 'one' },
      { id: 'm3', content: 'three' },
    ]

    expect(orderedSourceItems(['m1', 'm2', 'm3'], candidates)).toBeNull()
  })
})

describe('streaming token estimates', () => {
  test('uses the same transparent character-based estimate as Threadverse', () => {
    expect(estimatedStreamTokens(0)).toBe(0)
    expect(estimatedStreamTokens(1)).toBe(1)
    expect(estimatedStreamTokens(4)).toBe(1)
    expect(estimatedStreamTokens(5)).toBe(2)
  })
})

describe('restorative deletion', () => {
  test('only deletes active summaries from newest to oldest', () => {
    const state = createChatState(true)
    state.processedMessageIds = ['m9', 'm10']
    state.entries = [
      entry('a1', 'arc', 1, 8),
      { ...entry('c9', 'chapter', 9), sourceIds: ['m9'] },
      { ...entry('c10', 'chapter', 10), sourceIds: ['m10'] },
    ]

    expect(deleteActiveEntry(state, 'c9', '2026-02-01T00:00:00.000Z')).toBeNull()
    expect(activeEntries(state).map((candidate) => candidate.id)).toEqual(['a1', 'c9', 'c10'])

    expect(deleteActiveEntry(state, 'c10', '2026-02-01T00:00:00.000Z')?.level).toBe('chapter')
    expect(deleteActiveEntry(state, 'c9', '2026-02-01T00:00:01.000Z')?.level).toBe('chapter')
    expect(deleteActiveEntry(state, 'a1', '2026-02-01T00:00:02.000Z')?.level).toBe('arc')
    expect(activeEntries(state)).toEqual([])
  })

  test('deleting a Chapter releases its messages and preserves a reusable chronological slot', () => {
    const state = createChatState(true)
    state.processedMessageIds = ['m1', 'm2', 'm3']
    state.entries = [{
      ...entry('c1', 'chapter', 1),
      sourceIds: ['m1', 'm2'],
    }]

    expect(deleteActiveEntry(state, 'c1', '2026-02-01T00:00:00.000Z')).toEqual({
      level: 'chapter',
      restoredSourceCount: 2,
    })
    expect(state.processedMessageIds).toEqual(['m3'])
    expect(activeEntries(state)).toEqual([])
    expect(state.entries[0]).toMatchObject({
      id: 'c1',
      active: false,
      content: '',
      deletedAt: '2026-02-01T00:00:00.000Z',
    })

    const restored = restoreDeletedChapterSlot(
      state,
      ['m1', 'm2'],
      'regenerated',
      '2026-02-02T00:00:00.000Z',
    )
    expect(restored).toMatchObject({
      id: 'c1',
      active: true,
      content: 'regenerated',
      orderStart: 1,
      orderEnd: 1,
      sourceIds: ['m1', 'm2'],
    })
    expect(restored?.deletedAt).toBeUndefined()
  })

  test('deleting an Arc restores its source Chapters and removes the Arc', () => {
    const state = createChatState(true)
    const chapter1 = {
      ...entry('c1', 'chapter', 1),
      active: false,
      promotedToId: 'a1',
    }
    const chapter2 = {
      ...entry('c2', 'chapter', 2),
      active: false,
      promotedToId: 'a1',
    }
    const arc = {
      ...entry('a1', 'arc', 1, 2),
      sourceIds: ['c1', 'c2'],
    }
    state.entries = [chapter1, chapter2, arc]

    expect(deleteActiveEntry(state, 'a1', '2026-02-01T00:00:00.000Z')).toEqual({
      level: 'arc',
      restoredSourceCount: 2,
    })
    expect(state.entries.some((candidate) => candidate.id === 'a1')).toBe(false)
    expect(activeEntries(state).map((candidate) => candidate.id)).toEqual(['c1', 'c2'])
    expect(state.entries.every((candidate) => candidate.promotedToId === undefined)).toBe(true)
  })

  test('deleting a Volume restores only its direct source Arcs', () => {
    const state = createChatState(true)
    const chapter = {
      ...entry('c1', 'chapter', 1),
      active: false,
      promotedToId: 'a1',
    }
    const arc = {
      ...entry('a1', 'arc', 1, 8),
      active: false,
      sourceIds: ['c1'],
      promotedToId: 'v1',
    }
    const volume = {
      ...entry('v1', 'volume', 1, 8),
      sourceIds: ['a1'],
    }
    state.entries = [chapter, arc, volume]

    expect(deleteActiveEntry(state, 'v1', '2026-02-01T00:00:00.000Z')).toEqual({
      level: 'volume',
      restoredSourceCount: 1,
    })
    expect(activeEntries(state).map((candidate) => candidate.id)).toEqual(['a1'])
    expect(chapter).toMatchObject({ active: false, promotedToId: 'a1' })
  })
})

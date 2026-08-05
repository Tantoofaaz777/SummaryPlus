import { describe, expect, test } from 'bun:test'
import {
  activeEntries,
  chaptersReadyForTrimming,
  contextEntriesBefore,
  createChatState,
  createDefaultSettings,
  deleteActiveEntry,
  ensureEntryDisplayMetadata,
  entryDisplayTitle,
  estimatedStreamTokens,
  hasValidContextPlaceholders,
  macroValue,
  mergeVisibleOrder,
  migrateChatStateForBranch,
  nextEntrySequence,
  normalizeSettings,
  orderBySavedIds,
  orderedSourceItems,
  pendingMessages,
  renderGenerationUserPrompt,
  restoreDeletedChapterSlot,
  selectChapterBatch,
  selectPromotionBatch,
  summaryPlusHiddenMessageIds,
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
      hideSummarizedMessages: false,
      hideDelayChapters: 1,
      retries: 1,
      temperature: 0.2,
      topP: 1,
      maxTokens: 4096,
      regexEnabledIds: [],
      regexOrder: [],
    })
  })

  test('accepts an arbitrary non-negative retry count', () => {
    expect(normalizeSettings({ retries: 999_999 }).retries).toBe(999_999)
    expect(normalizeSettings({ retries: -10 }).retries).toBe(0)
  })

  test('normalizes an arbitrary non-negative Chapter trimming delay', () => {
    expect(normalizeSettings({
      hideSummarizedMessages: true,
      hideDelayChapters: 999_999,
    })).toMatchObject({
      hideSummarizedMessages: true,
      hideDelayChapters: 999_999,
    })
    expect(normalizeSettings({ hideDelayChapters: -10 }).hideDelayChapters).toBe(0)
  })

  test('normalizes regex selections and order as unique IDs', () => {
    const settings = normalizeSettings({
      regexEnabledIds: ['one', ' one ', '', 2, 'two', 'one'],
      regexOrder: ['two', 'one', 'two', null],
    })
    expect(settings.regexEnabledIds).toEqual(['one', 'two'])
    expect(settings.regexOrder).toEqual(['two', 'one'])
  })
})

describe('regex ordering', () => {
  test('uses the saved order and appends newly discovered scripts', () => {
    const scripts = [
      { id: 'one', name: 'One' },
      { id: 'two', name: 'Two' },
      { id: 'three', name: 'Three' },
    ]
    expect(orderBySavedIds(scripts, ['two', 'missing', 'one']).map((script) => script.id))
      .toEqual(['two', 'one', 'three'])
  })

  test('reorders visible scripts without discarding hidden scope-specific IDs', () => {
    expect(mergeVisibleOrder(
      ['global', 'other-chat', 'current-chat'],
      ['current-chat', 'global'],
    )).toEqual(['current-chat', 'global', 'other-chat'])
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

describe('message trimming', () => {
  test('keeps the configured number of newest Chapters visible across promotion', () => {
    const state = createChatState(true)
    state.entries = [
      {
        ...entry('c1', 'chapter', 1),
        active: false,
        promotedToId: 'a1',
        sourceIds: ['m1', 'm2'],
      },
      {
        ...entry('c2', 'chapter', 2),
        active: false,
        promotedToId: 'a1',
        sourceIds: ['m3', 'm4'],
      },
      {
        ...entry('c3', 'chapter', 3),
        sourceIds: ['m5', 'm6'],
      },
      {
        ...entry('a1', 'arc', 1, 2),
        sourceIds: ['c1', 'c2'],
      },
    ]

    expect(chaptersReadyForTrimming(state, 1).map((chapter) => chapter.id))
      .toEqual(['c1', 'c2'])
    expect(chaptersReadyForTrimming(state, 2).map((chapter) => chapter.id))
      .toEqual(['c1'])
    expect(chaptersReadyForTrimming(state, 3)).toEqual([])
  })

  test('skips handled and deleted Chapters and deduplicates owned message ids', () => {
    const state = createChatState(true)
    state.entries = [
      {
        ...entry('c1', 'chapter', 1),
        hideHandledAt: '2026-08-05T20:00:00.000Z',
        autoHiddenSourceIds: ['m1', 'm2'],
      },
      {
        ...entry('c2', 'chapter', 2),
        autoHiddenSourceIds: ['m2', 'm3'],
      },
      {
        ...entry('c3', 'chapter', 3),
        active: false,
        deletedAt: '2026-08-05T20:01:00.000Z',
      },
      entry('c4', 'chapter', 4),
    ]

    expect(chaptersReadyForTrimming(state, 0).map((chapter) => chapter.id))
      .toEqual(['c2', 'c4'])
    expect(summaryPlusHiddenMessageIds(state)).toEqual(['m1', 'm2', 'm3'])
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

describe('summary display metadata', () => {
  test('uses the first and last persisted message positions across deleted-message gaps', () => {
    const state = createChatState(true)
    state.entries = [{
      ...entry('c1', 'chapter', 1),
      sourceIds: ['m1', 'm4', 'm6', 'm9', 'm10', 'm11', 'm12'],
    }]
    const messages = [
      { id: 'm1', content: 'one', indexInChat: 0 },
      { id: 'm4', content: 'four', indexInChat: 3 },
      { id: 'm6', content: 'six', indexInChat: 5 },
      { id: 'm9', content: 'nine', indexInChat: 8 },
      { id: 'm10', content: 'ten', indexInChat: 9 },
      { id: 'm11', content: 'eleven', indexInChat: 10 },
      { id: 'm12', content: 'twelve', indexInChat: 11 },
    ]

    expect(ensureEntryDisplayMetadata(state, messages)).toBe(true)
    expect(state.entries[0]).toMatchObject({
      sequence: 1,
      sourceOrderStart: 1,
      sourceOrderEnd: 12,
    })
    expect(entryDisplayTitle(state.entries[0])).toBe('Chapter 1 • Messages 1-12')

    ensureEntryDisplayMetadata(state, messages.slice(1))
    expect(state.entries[0]).toMatchObject({
      sourceOrderStart: 1,
      sourceOrderEnd: 12,
    })
  })

  test('backfills Arc and Volume numbers and their direct source ranges', () => {
    const state = createChatState(true)
    const chapters = Array.from({ length: 16 }, (_, index) => ({
      ...entry(`c${index + 1}`, 'chapter', index + 1),
      active: false,
    }))
    const arc1 = {
      ...entry('a1', 'arc', 1, 8),
      active: false,
      sourceIds: chapters.slice(0, 8).map((chapter) => chapter.id),
    }
    const arc2 = {
      ...entry('a2', 'arc', 9, 16),
      active: false,
      sourceIds: chapters.slice(8).map((chapter) => chapter.id),
    }
    const volume = {
      ...entry('v1', 'volume', 1, 16),
      sourceIds: ['a1', 'a2'],
    }
    state.entries = [...chapters, arc2, arc1, volume]

    ensureEntryDisplayMetadata(state)

    expect(arc1).toMatchObject({
      sequence: 1,
      sourceOrderStart: 1,
      sourceOrderEnd: 8,
    })
    expect(arc2).toMatchObject({
      sequence: 2,
      sourceOrderStart: 9,
      sourceOrderEnd: 16,
    })
    expect(volume).toMatchObject({
      sequence: 1,
      sourceOrderStart: 1,
      sourceOrderEnd: 2,
    })
    expect(entryDisplayTitle(arc1)).toBe('Arc 1 • Chapters 1-8')
    expect(entryDisplayTitle(volume)).toBe('Volume 1 • Arcs 1-2')
    expect(nextEntrySequence(state, 'arc')).toBe(3)
    expect(nextEntrySequence(state, 'volume')).toBe(2)
  })
})

describe('chat branch migration', () => {
  test('remaps copied message ids, preserves gaps, and drops a Chapter crossing the fork', () => {
    const state = createChatState(true)
    state.ownerChatId = 'source-chat'
    state.nextChapterOrder = 3
    state.processedMessageIds = ['s1', 's4', 's5', 's8']
    state.entries = [
      {
        ...entry('c1', 'chapter', 1),
        sequence: 1,
        sourceOrderStart: 1,
        sourceOrderEnd: 4,
        sourceIds: ['s1', 's4'],
        hideHandledAt: '2026-08-05T19:00:00.000Z',
        autoHiddenSourceIds: ['s1'],
      },
      {
        ...entry('c2', 'chapter', 2),
        sequence: 2,
        sourceOrderStart: 5,
        sourceOrderEnd: 8,
        sourceIds: ['s5', 's8'],
      },
    ]

    const result = migrateChatStateForBranch({
      state,
      sourceChatId: 'source-chat',
      forkedChatId: 'forked-chat',
      forkedAtMessageIndex: 4,
      sourceMessages: [],
      forkedMessages: [
        { id: 'f1', content: 'one', indexInChat: 0 },
        { id: 'f4', content: 'four', indexInChat: 3 },
        { id: 'f5', content: 'five', indexInChat: 4 },
      ],
      migratedAt: '2026-08-05T20:00:00.000Z',
    })

    expect(result.discardedEntryCount).toBe(1)
    expect(result.state).toMatchObject({
      ownerChatId: 'forked-chat',
      nextChapterOrder: 2,
      processedMessageIds: ['f1', 'f4'],
      branchMigration: {
        status: 'complete',
        sourceChatId: 'source-chat',
        forkedAtMessageIndex: 4,
      },
    })
    expect(result.state.entries).toHaveLength(1)
    expect(result.state.entries[0]).toMatchObject({
      id: 'c1',
      sourceIds: ['f1', 'f4'],
      sourceOrderStart: 1,
      sourceOrderEnd: 4,
      hideHandledAt: '2026-08-05T19:00:00.000Z',
      autoHiddenSourceIds: [],
    })
  })

  test('decomposes an invalid Volume and Arc while restoring the valid older Arc', () => {
    const state = createChatState(true)
    state.ownerChatId = 'source-chat'
    const chapters = Array.from({ length: 4 }, (_, index) => ({
      ...entry(`c${index + 1}`, 'chapter', index + 1),
      sequence: index + 1,
      sourceOrderStart: index * 2 + 1,
      sourceOrderEnd: index * 2 + 2,
      sourceIds: [`s${index * 2 + 1}`, `s${index * 2 + 2}`],
      active: false,
      promotedToId: index < 2 ? 'a1' : 'a2',
    }))
    const arc1 = {
      ...entry('a1', 'arc', 1, 2),
      sequence: 1,
      sourceOrderStart: 1,
      sourceOrderEnd: 2,
      sourceIds: ['c1', 'c2'],
      active: false,
      promotedToId: 'v1',
    }
    const arc2 = {
      ...entry('a2', 'arc', 3, 4),
      sequence: 2,
      sourceOrderStart: 3,
      sourceOrderEnd: 4,
      sourceIds: ['c3', 'c4'],
      active: false,
      promotedToId: 'v1',
    }
    const volume = {
      ...entry('v1', 'volume', 1, 4),
      sequence: 1,
      sourceOrderStart: 1,
      sourceOrderEnd: 2,
      sourceIds: ['a1', 'a2'],
    }
    state.entries = [...chapters, arc1, arc2, volume]
    state.processedMessageIds = Array.from({ length: 8 }, (_, index) => `s${index + 1}`)

    const sourceMessages = Array.from({ length: 8 }, (_, index) => ({
      id: `s${index + 1}`,
      content: `source ${index + 1}`,
      indexInChat: index,
    }))
    const forkedMessages = sourceMessages.slice(0, 5).map((message) => ({
      ...message,
      id: `f${message.indexInChat + 1}`,
    }))
    const result = migrateChatStateForBranch({
      state,
      sourceChatId: 'source-chat',
      forkedChatId: 'forked-chat',
      forkedAtMessageIndex: 4,
      sourceMessages,
      forkedMessages,
      migratedAt: '2026-08-05T20:00:00.000Z',
    })

    expect(result.discardedEntryCount).toBe(4)
    expect(result.restoredEntryCount).toBe(1)
    expect(result.state.entries.map((item) => item.id)).toEqual(['c1', 'c2', 'a1'])
    expect(activeEntries(result.state).map((item) => item.id)).toEqual(['a1'])
    expect(result.state.entries.find((item) => item.id === 'a1')).toMatchObject({
      active: true,
    })
    expect(result.state.entries.find((item) => item.id === 'c1')).toMatchObject({
      active: false,
      promotedToId: 'a1',
    })
    expect(result.state.processedMessageIds).toEqual(['f1', 'f2', 'f3', 'f4'])
    expect(result.state.nextChapterOrder).toBe(3)
    expect(macroValue(result.state, 'volume')).toBe('')
    expect(macroValue(result.state, 'arc')).toBe('a1')
  })

  test('migrates legacy Chapters by matching source and fork positions', () => {
    const state = createChatState(true)
    state.ownerChatId = 'source-chat'
    state.entries = [{
      ...entry('legacy', 'chapter', 1),
      sourceIds: ['source-one', 'source-three'],
      hideHandledAt: '2026-08-05T19:00:00.000Z',
      autoHiddenSourceIds: ['source-three'],
    }]

    const result = migrateChatStateForBranch({
      state,
      sourceChatId: 'source-chat',
      forkedChatId: 'forked-chat',
      forkedAtMessageIndex: 2,
      sourceMessages: [
        { id: 'source-one', content: 'one', indexInChat: 0 },
        { id: 'source-three', content: 'three', indexInChat: 2 },
      ],
      forkedMessages: [
        { id: 'fork-one', content: 'one', indexInChat: 0 },
        { id: 'fork-three', content: 'three', indexInChat: 2 },
      ],
      migratedAt: '2026-08-05T20:00:00.000Z',
    })

    expect(result.state.entries[0]).toMatchObject({
      sourceIds: ['fork-one', 'fork-three'],
      sourceOrderStart: 1,
      sourceOrderEnd: 3,
      hideHandledAt: '2026-08-05T19:00:00.000Z',
      autoHiddenSourceIds: ['fork-three'],
    })
    expect(result.state.processedMessageIds).toEqual(['fork-one', 'fork-three'])
  })

  test('refuses a legacy migration when a source position cannot be proven', () => {
    const state = createChatState(true)
    state.entries = [{
      ...entry('legacy', 'chapter', 1),
      sourceIds: ['missing-source'],
    }]

    expect(() => migrateChatStateForBranch({
      state,
      sourceChatId: 'source-chat',
      forkedChatId: 'forked-chat',
      forkedAtMessageIndex: 2,
      sourceMessages: [],
      forkedMessages: [],
      migratedAt: '2026-08-05T20:00:00.000Z',
    })).toThrow('cannot map source message')
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
      hideHandledAt: '2026-01-02T00:00:00.000Z',
      autoHiddenSourceIds: ['m1'],
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
    expect(state.entries[0]?.hideHandledAt).toBeUndefined()
    expect(state.entries[0]?.autoHiddenSourceIds).toBeUndefined()

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

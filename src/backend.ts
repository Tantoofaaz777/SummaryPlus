import type {
  ChatDTO,
  ConnectionProfileDTO,
  GenerationRequestDTO,
  RegexScriptDTO,
  SpindleAPI,
} from 'lumiverse-spindle-types'
import {
  CONTEXT_PLACEHOLDER_EXAMPLE,
  INPUT_PLACEHOLDER,
  LEVELS,
  SETTINGS_PATH,
  STATE_KEY,
  allPrompts,
  contextEntriesBefore,
  createChatState,
  deleteActiveEntry,
  entryCounts,
  ensureEntryDisplayMetadata,
  isSameEntryBatch,
  isSameMessageBatch,
  hasValidContextPlaceholders,
  latestActiveEntry,
  macroValue,
  mergeVisibleOrder,
  nextEntrySequence,
  normalizeSettings,
  orderBySavedIds,
  orderedSourceItems,
  parseChatState,
  pendingMessages,
  renderGenerationUserPrompt,
  restoreDeletedChapterSlot,
  selectChapterBatch,
  selectedPrompt,
  selectPromotionBatch,
  sourceText,
  estimatedStreamTokens,
  type ChatMessageLike,
  type ChatState,
  type ConnectionOption,
  type GenerationProgress,
  type PromptDefinition,
  type RegexOption,
  type Snapshot,
  type SummaryEntry,
  type SummaryLevel,
  type SummaryPlusSettings,
} from './core'
import {
  applyRegexPipeline,
  type SummaryRegexScript,
} from './regex-pipeline'

declare const spindle: SpindleAPI

type FrontendRequest =
  | { type: 'request_snapshot' }
  | { type: 'process_history' }
  | { type: 'process_now' }
  | { type: 'cancel_processing' }
  | { type: 'edit_entry'; entryId: string; value: string }
  | { type: 'regenerate_entry'; entryId: string }
  | { type: 'delete_entry'; entryId: string }
  | { type: 'save_entries'; entries: Array<{ id: string; content: string }> }
  | { type: 'save_settings'; settings: Partial<SummaryPlusSettings> }
  | { type: 'save_prompt'; prompt: Pick<PromptDefinition, 'id' | 'name' | 'systemPrompt' | 'userPrompt'> }
  | { type: 'new_prompt'; level: SummaryLevel }
  | { type: 'duplicate_prompt'; promptId: string }
  | { type: 'delete_prompt'; promptId: string }
  | { type: 'select_prompt'; level: SummaryLevel; promptId: string }

interface ChatEventPayload {
  chatId?: unknown
}

class ProcessingCancelledError extends Error {
  constructor() {
    super('Processing cancelled.')
    this.name = 'AbortError'
  }
}

class ConfigurationError extends Error {}

const processingChats = new Set<string>()
const queuedChats = new Set<string>()
const controllers = new Map<string, AbortController>()
const generationProgressByChat = new Map<string, GenerationProgress>()
const frontendUserIds = new Set<string>()

function now(): string {
  return new Date().toISOString()
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return 'Unknown generation error.'
}

function isAbort(error: unknown): boolean {
  return error instanceof ProcessingCancelledError
    || (error instanceof Error && error.name === 'AbortError')
}

function isSummaryLevel(value: unknown): value is SummaryLevel {
  return typeof value === 'string' && LEVELS.includes(value as SummaryLevel)
}

function chatIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const value = (payload as ChatEventPayload).chatId
  return typeof value === 'string' && value ? value : null
}

function isFrontendRequest(payload: unknown): payload is FrontendRequest {
  return Boolean(
    payload
    && typeof payload === 'object'
    && typeof (payload as { type?: unknown }).type === 'string',
  )
}

async function getSettings(userId?: string): Promise<SummaryPlusSettings> {
  const value = await spindle.userStorage.getJson<unknown>(SETTINGS_PATH, {
    fallback: null,
    userId,
  })
  return normalizeSettings(value)
}

async function setSettings(settings: SummaryPlusSettings, userId?: string): Promise<void> {
  await spindle.userStorage.setJson(SETTINGS_PATH, settings, {
    indent: 2,
    userId,
  })
}

async function loadState(chatId: string): Promise<ChatState | null> {
  return parseChatState(await spindle.variables.chat.get(chatId, STATE_KEY))
}

async function saveState(chatId: string, state: ChatState): Promise<void> {
  await spindle.variables.chat.set(chatId, STATE_KEY, JSON.stringify(state))
}

async function getMessages(chatId: string): Promise<ChatMessageLike[]> {
  const messages = await spindle.chat.getMessages(chatId)
  return messages.map((message) => ({
    id: String(message.id),
    content: typeof message.content === 'string' ? message.content : '',
    role: message.role,
    indexInChat: message.index_in_chat,
  }))
}

async function ensureState(
  chatId: string,
  discovery: 'view' | 'message' = 'view',
): Promise<ChatState> {
  const existing = await loadState(chatId)
  if (existing) return existing

  const messages = await getMessages(chatId)
  const historyLengthBeforeCurrentMessage = discovery === 'message'
    ? Math.max(0, messages.length - 1)
    : messages.length
  const state = createChatState(historyLengthBeforeCurrentMessage <= 1)
  await saveState(chatId, state)
  return state
}

async function activeChatId(userId?: string): Promise<string | null> {
  const chat = await spindle.chats.getActive(userId)
  return chat && typeof chat.id === 'string' ? chat.id : null
}

function toConnectionOption(connection: ConnectionProfileDTO): ConnectionOption {
  return {
    id: connection.id,
    name: connection.name,
    provider: connection.provider,
    model: connection.model,
    isDefault: connection.is_default,
  }
}

function regexScopeRank(scope: RegexScriptDTO['scope']): number {
  if (scope === 'global') return 0
  if (scope === 'character') return 1
  return 2
}

function regexAppliesToChat(script: RegexScriptDTO, chat: ChatDTO | null): boolean {
  if (script.scope === 'global') return true
  if (!chat) return false
  if (script.scope === 'character') return script.scope_id === chat.character_id
  return script.scope_id === chat.id
}

async function listPromptRegexScripts(
  chat: ChatDTO | null,
  userId?: string,
): Promise<SummaryRegexScript[]> {
  const scripts: SummaryRegexScript[] = []
  const limit = 200
  let offset = 0
  let total = 0
  do {
    const page = await spindle.regex_scripts.list({
      target: 'prompt',
      limit,
      offset,
      userId,
    })
    scripts.push(...page.data as SummaryRegexScript[])
    total = page.total
    offset += page.data.length
    if (page.data.length === 0) break
  } while (offset < total)

  return scripts
    .filter((script) => regexAppliesToChat(script, chat))
    .sort((left, right) => (
      regexScopeRank(left.scope) - regexScopeRank(right.scope)
      || left.sort_order - right.sort_order
      || left.created_at - right.created_at
    ))
}

function toRegexOption(script: RegexScriptDTO): RegexOption {
  return {
    id: script.id,
    name: script.name,
  }
}

async function createSnapshot(userId?: string): Promise<Snapshot> {
  const settings = await getSettings(userId)
  let connections: ConnectionOption[] = []
  try {
    connections = (await spindle.connections.list(userId)).map(toConnectionOption)
  } catch {
    // A revoked generation permission should not make the rest of the drawer unusable.
  }

  const chat = await spindle.chats.getActive(userId)
  const chatId = chat && typeof chat.id === 'string' ? chat.id : null
  let regexScripts: RegexOption[] = []
  try {
    regexScripts = orderBySavedIds(
      (await listPromptRegexScripts(chat, userId)).map(toRegexOption),
      settings.regexOrder,
    )
  } catch {
    // A missing regex_scripts permission should not make the drawer unusable.
  }

  if (!chatId) {
    return {
      chatId: null,
      state: null,
      settings,
      prompts: allPrompts(settings),
      connections,
      regexScripts,
      processing: false,
      generationProgress: null,
      pendingMessageCount: 0,
      activeCounts: entryCounts(null),
    }
  }

  const [state, messages] = await Promise.all([
    ensureState(chatId),
    getMessages(chatId),
  ])
  ensureEntryDisplayMetadata(state, messages)
  return {
    chatId,
    state,
    settings,
    prompts: allPrompts(settings),
    connections,
    regexScripts,
    processing: processingChats.has(chatId),
    generationProgress: generationProgressByChat.get(chatId) ?? null,
    pendingMessageCount: pendingMessages(messages, state.processedMessageIds).length,
    activeCounts: entryCounts(state),
  }
}

async function publishSnapshot(userId?: string): Promise<void> {
  if (!userId) return
  try {
    spindle.sendToFrontend({
      type: 'snapshot',
      snapshot: await createSnapshot(userId),
    }, userId)
  } catch (error) {
    publishActionError(error, userId)
  }
}

function publishSnapshotsForKnownUsers(): void {
  for (const userId of frontendUserIds) void publishSnapshot(userId)
}

function publishActionError(error: unknown, userId?: string): void {
  const message = errorMessage(error)
  spindle.toast.error(message, { userId })
  spindle.sendToFrontend({
    type: 'action_error',
    message,
  }, userId)
}

function publishActionSuccess(message: string, userId?: string): void {
  spindle.toast.success(message, { userId })
}

function waitBeforeRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new ProcessingCancelledError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, 1_000)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new ProcessingCancelledError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

interface GenerationTarget {
  action: GenerationProgress['action']
  level: SummaryLevel
  orderStart: number
  orderEnd: number
}

function publishGenerationProgress(
  chatId: string,
  progress: GenerationProgress,
  userId?: string,
): void {
  generationProgressByChat.set(chatId, progress)
  try {
    spindle.sendToFrontend({
      type: 'generation_progress',
      chatId,
      progress,
    }, userId)
  } catch (error) {
    spindle.log.warn(
      `SummaryPlus could not publish generation progress for chat ${chatId}: ${errorMessage(error)}`,
    )
  }
}

async function generateSummary(
  chatId: string,
  target: GenerationTarget,
  input: string,
  contextEntries: SummaryEntry[],
  settings: SummaryPlusSettings,
  signal: AbortSignal,
  userId?: string,
): Promise<string> {
  const prompt = selectedPrompt(settings, target.level)
  if (!prompt.userPrompt.includes(INPUT_PLACEHOLDER)) {
    throw new ConfigurationError(
      `${prompt.name} must include ${INPUT_PLACEHOLDER} in its user prompt.`,
    )
  }
  if (!hasValidContextPlaceholders(prompt.userPrompt)) {
    throw new ConfigurationError(
      `${prompt.name} has an invalid context placeholder. Use ${CONTEXT_PLACEHOLDER_EXAMPLE} with a non-negative integer.`,
    )
  }

  const messages: Array<{ role: 'system' | 'user'; content: string }> = []
  if (prompt.systemPrompt.trim()) {
    messages.push({ role: 'system', content: prompt.systemPrompt })
  }
  messages.push({
    role: 'user',
    content: renderGenerationUserPrompt(prompt.userPrompt, input, contextEntries),
  })

  const request: GenerationRequestDTO = {
    type: 'quiet',
    messages,
    parameters: {
      temperature: settings.temperature,
      top_p: settings.topP,
      max_tokens: settings.maxTokens,
    },
    signal,
    userId,
  }
  if (settings.connectionId) request.connection_id = settings.connectionId

  let lastFailure: unknown = new Error('The provider returned an empty response.')
  for (let attempt = 0; attempt <= settings.retries; attempt += 1) {
    if (signal.aborted) throw new ProcessingCancelledError()
    let outputCharacters = 0
    let reasoningCharacters = 0
    let lastProgressAt = 0
    const publishProgress = (force = false) => {
      const publishedAt = Date.now()
      if (!force && publishedAt - lastProgressAt < 250) return
      lastProgressAt = publishedAt
      publishGenerationProgress(chatId, {
        ...target,
        outputTokens: estimatedStreamTokens(outputCharacters),
        reasoningTokens: estimatedStreamTokens(reasoningCharacters),
        attempt: attempt + 1,
        maxAttempts: settings.retries + 1,
      }, userId)
    }
    publishProgress(true)

    try {
      let content = ''
      for await (const chunk of spindle.generate.quietStream(request)) {
        if (chunk.type === 'token') {
          outputCharacters += chunk.token.length
          publishProgress()
        } else if (chunk.type === 'reasoning') {
          reasoningCharacters += chunk.token.length
          publishProgress()
        } else {
          content = chunk.content.trim()
          outputCharacters = chunk.content.length
          if (typeof chunk.reasoning === 'string') {
            reasoningCharacters = chunk.reasoning.length
          }
          publishProgress(true)
        }
      }
      if (!content) throw new Error('The provider returned an empty response.')
      return content
    } catch (error) {
      if (isAbort(error)) throw error
      lastFailure = error
      if (attempt < settings.retries) await waitBeforeRetry(signal)
    }
  }
  throw lastFailure
}

async function chapterSourceText(
  chatId: string,
  messages: ChatMessageLike[],
  settings: SummaryPlusSettings,
  signal: AbortSignal,
  userId?: string,
): Promise<string> {
  if (settings.regexEnabledIds.length === 0) return sourceText(messages)
  const chat = await spindle.chats.get(chatId, userId)
  const enabledIds = new Set(settings.regexEnabledIds)
  const scripts = orderBySavedIds(
    await listPromptRegexScripts(chat, userId),
    settings.regexOrder,
  ).filter((script) => enabledIds.has(script.id))
  if (scripts.length === 0) return sourceText(messages)

  const processed = await applyRegexPipeline(
    messages,
    scripts,
    async (template) => {
      const result = await spindle.macros.resolve(template, {
        chatId,
        characterId: chat?.character_id || undefined,
        userId,
        commit: false,
      })
      return result.text
    },
    signal,
  )
  return sourceText(processed)
}

async function recordFailure(
  chatId: string,
  level: SummaryLevel,
  error: unknown,
  userId?: string,
): Promise<void> {
  const state = await ensureState(chatId)
  const message = errorMessage(error)
  state.lastError = {
    level,
    message,
    at: now(),
  }
  await saveState(chatId, state)
  const label = `${level[0].toUpperCase()}${level.slice(1)}`
  spindle.toast.error(`${label} generation failed: ${message}`, { userId })
}

async function createChapter(
  chatId: string,
  state: ChatState,
  settings: SummaryPlusSettings,
  signal: AbortSignal,
  userId?: string,
): Promise<'created' | 'stale' | 'none'> {
  const messages = await getMessages(chatId)
  ensureEntryDisplayMetadata(state, messages)
  const batch = selectChapterBatch(messages, state, settings)
  if (!batch) return 'none'
  const sourceMessageNumbers = batch
    .map((message) => message.indexInChat)
    .filter((value): value is number => (
      typeof value === 'number' && Number.isInteger(value) && value >= 0
    ))
    .map((value) => value + 1)
  if (sourceMessageNumbers.length !== batch.length) {
    throw new Error('Lumiverse did not provide message positions for the Chapter source batch.')
  }
  const sourceOrderStart = Math.min(...sourceMessageNumbers)
  const sourceOrderEnd = Math.max(...sourceMessageNumbers)

  let content: string
  try {
    content = await generateSummary(
      chatId,
      {
        action: 'create',
        level: 'chapter',
        orderStart: state.nextChapterOrder,
        orderEnd: state.nextChapterOrder,
      },
      await chapterSourceText(chatId, batch, settings, signal, userId),
      contextEntriesBefore(state, state.nextChapterOrder),
      settings,
      signal,
      userId,
    )
  } catch (error) {
    if (isAbort(error)) throw error
    await recordFailure(chatId, 'chapter', error, userId)
    throw error
  }

  const [currentState, currentMessages] = await Promise.all([
    ensureState(chatId),
    getMessages(chatId),
  ])
  ensureEntryDisplayMetadata(currentState, currentMessages)
  const currentBatch = selectChapterBatch(currentMessages, currentState, settings)
  if (
    !currentBatch
    || !isSameMessageBatch(batch, currentMessages)
    || currentBatch.length !== batch.length
    || currentBatch.some((message, index) => String(message.id) !== String(batch[index]?.id))
  ) {
    return 'stale'
  }

  const createdAt = now()
  const sourceIds = batch.map((message) => String(message.id))
  currentState.processedMessageIds = [
    ...new Set([
      ...currentState.processedMessageIds,
      ...sourceIds,
    ]),
  ]
  const restored = restoreDeletedChapterSlot(
    currentState,
    sourceIds,
    content,
    createdAt,
  )
  if (restored) {
    restored.sequence = restored.orderStart
    restored.sourceOrderStart = sourceOrderStart
    restored.sourceOrderEnd = sourceOrderEnd
  }
  if (!restored) {
    const order = currentState.nextChapterOrder
    currentState.nextChapterOrder += 1
    currentState.entries.push({
      id: id('chapter'),
      level: 'chapter',
      content,
      sequence: order,
      orderStart: order,
      orderEnd: order,
      sourceOrderStart,
      sourceOrderEnd,
      active: true,
      sourceIds,
      createdAt,
      updatedAt: createdAt,
    })
  }
  delete currentState.lastError
  await saveState(chatId, currentState)
  return 'created'
}

async function createPromotion(
  chatId: string,
  targetLevel: 'arc' | 'volume',
  state: ChatState,
  settings: SummaryPlusSettings,
  signal: AbortSignal,
  userId?: string,
): Promise<'created' | 'stale' | 'none'> {
  ensureEntryDisplayMetadata(state)
  const sourceLevel = targetLevel === 'arc' ? 'chapter' : 'arc'
  const size = targetLevel === 'arc' ? settings.chaptersPerArc : settings.arcsPerVolume
  const delay = targetLevel === 'arc' ? settings.chapterDelay : settings.arcDelay
  const batch = selectPromotionBatch(state, sourceLevel, size, delay)
  if (!batch) return 'none'
  const orderStart = Math.min(...batch.map((entry) => entry.orderStart))
  const orderEnd = Math.max(...batch.map((entry) => entry.orderEnd))
  const sourceSequenceNumbers = batch
    .map((entry) => entry.sequence)
    .filter((value): value is number => (
      typeof value === 'number' && Number.isInteger(value) && value >= 1
    ))
  if (sourceSequenceNumbers.length !== batch.length) {
    throw new Error(`SummaryPlus could not determine the ${sourceLevel} sequence range.`)
  }
  const sourceOrderStart = Math.min(...sourceSequenceNumbers)
  const sourceOrderEnd = Math.max(...sourceSequenceNumbers)

  let content: string
  try {
    content = await generateSummary(
      chatId,
      {
        action: 'create',
        level: targetLevel,
        orderStart,
        orderEnd,
      },
      sourceText(batch),
      contextEntriesBefore(state, orderStart),
      settings,
      signal,
      userId,
    )
  } catch (error) {
    if (isAbort(error)) throw error
    await recordFailure(chatId, targetLevel, error, userId)
    throw error
  }

  const currentState = await ensureState(chatId)
  ensureEntryDisplayMetadata(currentState)
  if (!isSameEntryBatch(batch, currentState)) return 'stale'

  const createdAt = now()
  const promotedEntry: SummaryEntry = {
    id: id(targetLevel),
    level: targetLevel,
    content,
    sequence: nextEntrySequence(currentState, targetLevel),
    orderStart,
    orderEnd,
    sourceOrderStart,
    sourceOrderEnd,
    active: true,
    sourceIds: batch.map((entry) => entry.id),
    createdAt,
    updatedAt: createdAt,
  }
  const sourceIds = new Set(promotedEntry.sourceIds)
  for (const entry of currentState.entries) {
    if (sourceIds.has(entry.id)) {
      entry.active = false
      entry.promotedToId = promotedEntry.id
      entry.updatedAt = createdAt
    }
  }
  currentState.entries.push(promotedEntry)
  delete currentState.lastError
  await saveState(chatId, currentState)
  return 'created'
}

async function processPass(
  chatId: string,
  signal: AbortSignal,
  userId?: string,
): Promise<void> {
  while (!signal.aborted) {
    const [state, settings] = await Promise.all([
      ensureState(chatId),
      getSettings(userId),
    ])
    if (!state.historyApproved) return

    const volumeResult = await createPromotion(
      chatId,
      'volume',
      state,
      settings,
      signal,
      userId,
    )
    if (volumeResult === 'created') continue
    if (volumeResult === 'stale') return

    const refreshedForArc = await ensureState(chatId)
    const arcResult = await createPromotion(
      chatId,
      'arc',
      refreshedForArc,
      settings,
      signal,
      userId,
    )
    if (arcResult === 'created') continue
    if (arcResult === 'stale') return

    const refreshedForChapter = await ensureState(chatId)
    const chapterResult = await createChapter(
      chatId,
      refreshedForChapter,
      settings,
      signal,
      userId,
    )
    if (chapterResult === 'created') continue
    return
  }
  throw new ProcessingCancelledError()
}

async function runProcessing(chatId: string, userId?: string): Promise<void> {
  if (processingChats.has(chatId)) {
    queuedChats.add(chatId)
    return
  }

  processingChats.add(chatId)
  generationProgressByChat.delete(chatId)
  const controller = new AbortController()
  controllers.set(chatId, controller)
  await publishSnapshot(userId)

  try {
    do {
      queuedChats.delete(chatId)
      await processPass(chatId, controller.signal, userId)
    } while (queuedChats.has(chatId) && !controller.signal.aborted)
  } catch (error) {
    if (!isAbort(error)) {
      spindle.log.error(`SummaryPlus processing failed for chat ${chatId}: ${errorMessage(error)}`)
    }
  } finally {
    processingChats.delete(chatId)
    queuedChats.delete(chatId)
    controllers.delete(chatId)
    generationProgressByChat.delete(chatId)
    await publishSnapshot(userId)
  }
}

function cancelChat(chatId: string): void {
  queuedChats.delete(chatId)
  controllers.get(chatId)?.abort()
}

function entryEditorTitle(entry: SummaryEntry): string {
  const level = `${entry.level[0].toUpperCase()}${entry.level.slice(1)}`
  if (entry.level === 'chapter') return `Edit ${level} ${entry.orderStart}`
  return `Edit ${level} - Chapters ${entry.orderStart}-${entry.orderEnd}`
}

async function editEntry(
  chatId: string,
  entryId: string,
  value: string,
  userId?: string,
): Promise<{ text: string; cancelled: boolean }> {
  if (processingChats.has(chatId)) {
    throw new Error('Wait for processing to finish, or cancel it before editing summaries.')
  }

  const state = await ensureState(chatId)
  const entry = state.entries.find((candidate) => candidate.id === entryId && candidate.active)
  if (!entry) throw new Error('This summary is no longer active.')

  const originalUpdatedAt = entry.updatedAt
  const result = await spindle.textEditor.open({
    title: entryEditorTitle(entry),
    value,
    placeholder: `Write the ${entry.level} summary...`,
    userId,
  })
  if (result.cancelled) return result

  if (processingChats.has(chatId)) {
    throw new Error('Processing started while the editor was open. Reopen the summary after it finishes.')
  }

  const refreshedState = await ensureState(chatId)
  const refreshedEntry = refreshedState.entries.find((candidate) => (
    candidate.id === entryId && candidate.active
  ))
  if (!refreshedEntry || refreshedEntry.updatedAt !== originalUpdatedAt) {
    throw new Error('This summary changed while the editor was open. Reopen it to edit the latest version.')
  }

  return result
}

async function saveEntryEdits(
  chatId: string,
  edits: Array<{ id: string; content: string }>,
): Promise<void> {
  if (processingChats.has(chatId)) {
    throw new Error('Wait for processing to finish, or cancel it before editing summaries.')
  }
  const state = await ensureState(chatId)
  const editsById = new Map(
    edits
      .filter((edit) => typeof edit.id === 'string' && typeof edit.content === 'string')
      .map((edit) => [edit.id, edit.content]),
  )
  const editedAt = now()
  for (const entry of state.entries) {
    const content = editsById.get(entry.id)
    if (entry.active && content !== undefined && entry.content !== content) {
      entry.content = content
      entry.updatedAt = editedAt
      entry.editedAt = editedAt
    }
  }
  await saveState(chatId, state)
}

async function deleteEntry(
  chatId: string,
  entryId: string,
): Promise<ReturnType<typeof deleteActiveEntry>> {
  if (processingChats.has(chatId)) {
    throw new Error('Wait for processing to finish, or cancel it before deleting summaries.')
  }
  const state = await ensureState(chatId)
  const requested = state.entries.find((entry) => entry.id === entryId && entry.active)
  if (!requested) throw new Error('This summary is no longer active.')
  if (latestActiveEntry(state)?.id !== entryId) {
    throw new Error('Delete newer summaries first. Only the most recent active summary can be deleted.')
  }
  const result = deleteActiveEntry(state, entryId, now())
  if (!result) throw new Error('A newer summary appeared. Delete it first.')
  if (processingChats.has(chatId)) {
    throw new Error('Processing started before the summary could be deleted. Try again after it finishes.')
  }
  await saveState(chatId, state)
  return result
}

function sameSourceIds(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((sourceId, index) => sourceId === right[index])
}

function promotionSources(
  entry: SummaryEntry,
  state: ChatState,
): SummaryEntry[] {
  const sourceLevel: SummaryLevel = entry.level === 'arc' ? 'chapter' : 'arc'
  const sources = orderedSourceItems(entry.sourceIds, state.entries)
  const sourcesAreValid = entry.sourceIds.length > 0
    && sources
    && sources.every((source) => (
      source.level === sourceLevel
      && !source.active
      && source.promotedToId === entry.id
    ))
  if (!sourcesAreValid) {
    const sourceLabel = sourceLevel === 'chapter' ? 'Chapters' : 'Arcs'
    throw new Error(
      `The original ${sourceLabel} for this summary are no longer available, so it cannot be regenerated.`,
    )
  }
  return sources
}

function assertRegenerationTargetUnchanged(
  original: SummaryEntry,
  currentState: ChatState,
): SummaryEntry {
  const current = currentState.entries.find((candidate) => candidate.id === original.id)
  if (
    !current?.active
    || latestActiveEntry(currentState)?.id !== original.id
    || current.level !== original.level
    || current.content !== original.content
    || current.updatedAt !== original.updatedAt
    || !sameSourceIds(current.sourceIds, original.sourceIds)
  ) {
    throw new Error(
      'The summary or its chronology changed during regeneration. The original summary was preserved.',
    )
  }
  return current
}

async function regenerateEntry(
  chatId: string,
  entryId: string,
  signal: AbortSignal,
  userId?: string,
): Promise<'regenerated' | 'failed'> {
  const [state, settings] = await Promise.all([
    ensureState(chatId),
    getSettings(userId),
  ])
  const entry = state.entries.find((candidate) => candidate.id === entryId && candidate.active)
  if (!entry) throw new Error('This summary is no longer active.')
  if (latestActiveEntry(state)?.id !== entryId) {
    throw new Error(
      'Regenerate newer summaries first. Only the most recent active summary can be regenerated.',
    )
  }

  let chapterSources: ChatMessageLike[] | null = null
  let summarySources: SummaryEntry[] | null = null
  if (entry.level === 'chapter') {
    const messages = await getMessages(chatId)
    chapterSources = orderedSourceItems(entry.sourceIds, messages)
    if (!entry.sourceIds.length || !chapterSources) {
      throw new Error(
        'The original messages for this Chapter are no longer available, so it cannot be regenerated.',
      )
    }
  } else {
    summarySources = promotionSources(entry, state)
  }

  let content: string
  try {
    const input = chapterSources
      ? await chapterSourceText(chatId, chapterSources, settings, signal, userId)
      : sourceText(summarySources ?? [])
    content = await generateSummary(
      chatId,
      {
        action: 'regenerate',
        level: entry.level,
        orderStart: entry.orderStart,
        orderEnd: entry.orderEnd,
      },
      input,
      contextEntriesBefore(state, entry.orderStart),
      settings,
      signal,
      userId,
    )
  } catch (error) {
    if (isAbort(error)) throw error
    await recordFailure(chatId, entry.level, error, userId)
    return 'failed'
  }

  if (signal.aborted) throw new ProcessingCancelledError()
  const currentState = await ensureState(chatId)
  const currentEntry = assertRegenerationTargetUnchanged(entry, currentState)

  if (entry.level === 'chapter') {
    const currentMessages = await getMessages(chatId)
    const currentSources = orderedSourceItems(entry.sourceIds, currentMessages)
    if (
      !chapterSources
      || !currentSources
      || !isSameMessageBatch(chapterSources, currentMessages)
    ) {
      throw new Error(
        'The original messages changed during regeneration. The existing Chapter was preserved.',
      )
    }
  } else {
    const currentSources = promotionSources(currentEntry, currentState)
    if (
      !summarySources
      || currentSources.some((source, index) => {
        const original = summarySources?.[index]
        return !original
          || source.id !== original.id
          || source.level !== original.level
          || source.content !== original.content
          || source.updatedAt !== original.updatedAt
          || source.active !== original.active
          || source.promotedToId !== original.promotedToId
      })
    ) {
      throw new Error(
        'The original summaries changed during regeneration. The existing summary was preserved.',
      )
    }
  }

  if (signal.aborted) throw new ProcessingCancelledError()
  const regeneratedAt = now()
  currentEntry.content = content
  currentEntry.updatedAt = regeneratedAt
  delete currentEntry.editedAt
  delete currentState.lastError
  await saveState(chatId, currentState)
  return 'regenerated'
}

async function runRegeneration(
  chatId: string,
  entryId: string,
  userId?: string,
): Promise<void> {
  if (processingChats.has(chatId)) {
    publishActionError(
      new Error('Wait for the current operation to finish, or cancel it before regenerating.'),
      userId,
    )
    return
  }

  processingChats.add(chatId)
  queuedChats.delete(chatId)
  generationProgressByChat.delete(chatId)
  const controller = new AbortController()
  controllers.set(chatId, controller)
  await publishSnapshot(userId)

  try {
    const result = await regenerateEntry(chatId, entryId, controller.signal, userId)
    if (result === 'regenerated') {
      publishActionSuccess('Summary regenerated.', userId)
    }
    while (queuedChats.has(chatId) && !controller.signal.aborted) {
      queuedChats.delete(chatId)
      await processPass(chatId, controller.signal, userId)
    }
  } catch (error) {
    if (!isAbort(error)) {
      spindle.log.error(
        `SummaryPlus regeneration failed for chat ${chatId}: ${errorMessage(error)}`,
      )
      publishActionError(error, userId)
    }
  } finally {
    processingChats.delete(chatId)
    queuedChats.delete(chatId)
    controllers.delete(chatId)
    generationProgressByChat.delete(chatId)
    await publishSnapshot(userId)
  }
}

function mergeSettings(
  current: SummaryPlusSettings,
  incoming: Partial<SummaryPlusSettings>,
): SummaryPlusSettings {
  const regexOrder = Array.isArray(incoming.regexOrder)
    ? mergeVisibleOrder(current.regexOrder, incoming.regexOrder)
    : current.regexOrder
  return normalizeSettings({
    ...current,
    ...incoming,
    regexOrder,
    customPrompts: current.customPrompts,
    activePromptIds: current.activePromptIds,
  })
}

async function saveGlobalSettings(
  incoming: Partial<SummaryPlusSettings>,
  userId?: string,
): Promise<void> {
  const current = await getSettings(userId)
  const next = mergeSettings(current, incoming)
  await setSettings(next, userId)
  if (current.automationEnabled && !next.automationEnabled) {
    for (const controller of controllers.values()) controller.abort()
  }
}

async function saveCustomPrompt(
  incoming: Pick<PromptDefinition, 'id' | 'name' | 'systemPrompt' | 'userPrompt'>,
  userId?: string,
): Promise<void> {
  const settings = await getSettings(userId)
  const index = settings.customPrompts.findIndex((prompt) => prompt.id === incoming.id)
  if (index < 0) throw new Error('Only duplicated or custom prompts can be edited.')
  if (!incoming.name.trim()) throw new Error('Prompt name cannot be empty.')
  if (!incoming.userPrompt.includes(INPUT_PLACEHOLDER)) {
    throw new Error(`User prompt must include ${INPUT_PLACEHOLDER} before it can be saved.`)
  }
  if (!hasValidContextPlaceholders(incoming.userPrompt)) {
    throw new Error(
      `Context placeholders must use ${CONTEXT_PLACEHOLDER_EXAMPLE}, where N is a non-negative integer.`,
    )
  }
  const original = settings.customPrompts[index]
  settings.customPrompts[index] = {
    ...original,
    name: incoming.name.trim(),
    systemPrompt: incoming.systemPrompt,
    userPrompt: incoming.userPrompt,
    builtIn: false,
    updatedAt: now(),
  }
  await setSettings(settings, userId)
}

async function createCustomPrompt(level: SummaryLevel, userId?: string): Promise<void> {
  const settings = await getSettings(userId)
  const createdAt = now()
  const prompt: PromptDefinition = {
    id: id('prompt'),
    level,
    name: `Untitled ${level[0].toUpperCase()}${level.slice(1)} Prompt`,
    systemPrompt: '',
    userPrompt: INPUT_PLACEHOLDER,
    builtIn: false,
    createdAt,
    updatedAt: createdAt,
  }
  settings.customPrompts.push(prompt)
  settings.activePromptIds[level] = prompt.id
  await setSettings(settings, userId)
}

async function duplicatePrompt(promptId: string, userId?: string): Promise<void> {
  const settings = await getSettings(userId)
  const source = allPrompts(settings).find((prompt) => prompt.id === promptId)
  if (!source) throw new Error('Prompt not found.')
  const createdAt = now()
  const copy: PromptDefinition = {
    ...source,
    id: id('prompt'),
    name: `${source.name} Copy`,
    builtIn: false,
    createdAt,
    updatedAt: createdAt,
  }
  settings.customPrompts.push(copy)
  settings.activePromptIds[source.level] = copy.id
  await setSettings(settings, userId)
}

async function deletePrompt(promptId: string, userId?: string): Promise<void> {
  const settings = await getSettings(userId)
  const prompt = settings.customPrompts.find((candidate) => candidate.id === promptId)
  if (!prompt) throw new Error('The default prompt cannot be deleted.')
  settings.customPrompts = settings.customPrompts.filter((candidate) => candidate.id !== promptId)
  if (settings.activePromptIds[prompt.level] === promptId) {
    settings.activePromptIds[prompt.level] = `builtin_${prompt.level}`
  }
  await setSettings(settings, userId)
}

async function selectUserPrompt(
  level: SummaryLevel,
  promptId: string,
  userId?: string,
): Promise<void> {
  const settings = await getSettings(userId)
  const prompt = allPrompts(settings).find((candidate) => (
    candidate.id === promptId && candidate.level === level
  ))
  if (!prompt) throw new Error('Prompt not found for this summary level.')
  settings.activePromptIds[level] = prompt.id
  await setSettings(settings, userId)
}

async function handleFrontendRequest(payload: FrontendRequest, userId: string): Promise<void> {
  const chatId = await activeChatId(userId)
  switch (payload.type) {
    case 'request_snapshot':
      await publishSnapshot(userId)
      return
    case 'process_history': {
      if (!chatId) throw new Error('Open a chat before processing history.')
      const state = await ensureState(chatId)
      state.historyApproved = true
      delete state.lastError
      await saveState(chatId, state)
      void runProcessing(chatId, userId)
      return
    }
    case 'process_now':
      if (!chatId) throw new Error('Open a chat before processing.')
      if (!(await ensureState(chatId)).historyApproved) {
        throw new Error('Approve existing chat history first.')
      }
      void runProcessing(chatId, userId)
      return
    case 'cancel_processing':
      if (chatId) cancelChat(chatId)
      return
    case 'edit_entry': {
      if (!chatId) throw new Error('Open a chat before editing summaries.')
      if (typeof payload.entryId !== 'string' || !payload.entryId) {
        throw new Error('Invalid summary entry.')
      }
      if (typeof payload.value !== 'string') throw new Error('Invalid summary draft.')
      const result = await editEntry(chatId, payload.entryId, payload.value, userId)
      spindle.sendToFrontend({
        type: 'entry_editor_closed',
        chatId,
        entryId: payload.entryId,
        text: result.text,
        cancelled: result.cancelled,
      }, userId)
      await publishSnapshot(userId)
      return
    }
    case 'regenerate_entry':
      if (!chatId) throw new Error('Open a chat before regenerating summaries.')
      if (typeof payload.entryId !== 'string' || !payload.entryId) {
        throw new Error('Invalid summary entry.')
      }
      void runRegeneration(chatId, payload.entryId, userId)
      return
    case 'delete_entry': {
      if (!chatId) throw new Error('Open a chat before deleting summaries.')
      if (typeof payload.entryId !== 'string' || !payload.entryId) {
        throw new Error('Invalid summary entry.')
      }
      const result = await deleteEntry(chatId, payload.entryId)
      if (!result) throw new Error('This summary is no longer active.')
      const level = `${result.level[0].toUpperCase()}${result.level.slice(1)}`
      const restoredLevel = result.level === 'arc' ? 'Chapter' : 'Arc'
      const restoredLabel = `${restoredLevel}${result.restoredSourceCount === 1 ? '' : 's'}`
      const source = result.level === 'chapter'
        ? 'source messages restored'
        : `${result.restoredSourceCount} source ${restoredLabel} restored`
      publishActionSuccess(`${level} deleted; ${source}.`, userId)
      await publishSnapshot(userId)
      return
    }
    case 'save_entries':
      if (!chatId) throw new Error('Open a chat before editing summaries.')
      if (!Array.isArray(payload.entries)) throw new Error('Invalid summary edits.')
      await saveEntryEdits(chatId, payload.entries)
      publishActionSuccess('Summary changes saved.', userId)
      await publishSnapshot(userId)
      return
    case 'save_settings':
      if (!payload.settings || typeof payload.settings !== 'object') {
        throw new Error('Invalid settings payload.')
      }
      await saveGlobalSettings(payload.settings, userId)
      await publishSnapshot(userId)
      return
    case 'save_prompt':
      await saveCustomPrompt(payload.prompt, userId)
      publishActionSuccess('Prompt saved.', userId)
      await publishSnapshot(userId)
      return
    case 'new_prompt':
      if (!isSummaryLevel(payload.level)) throw new Error('Invalid prompt level.')
      await createCustomPrompt(payload.level, userId)
      publishActionSuccess('Prompt created.', userId)
      await publishSnapshot(userId)
      return
    case 'duplicate_prompt':
      await duplicatePrompt(payload.promptId, userId)
      publishActionSuccess('Prompt duplicated.', userId)
      await publishSnapshot(userId)
      return
    case 'delete_prompt':
      await deletePrompt(payload.promptId, userId)
      publishActionSuccess('Prompt deleted.', userId)
      await publishSnapshot(userId)
      return
    case 'select_prompt':
      if (!isSummaryLevel(payload.level)) throw new Error('Invalid prompt level.')
      await selectUserPrompt(payload.level, payload.promptId, userId)
      await publishSnapshot(userId)
      return
  }
}

type PullMacroDefinition = {
  name: string
  category: string
  description: string
  returnType: 'string'
  handler: (context: {
    env?: {
      variables?: {
        chat?: Record<string, string>
      }
    }
  }) => string
}

const registerPullMacro = spindle.registerMacro.bind(spindle) as unknown as (
  definition: PullMacroDefinition,
) => void

for (const level of LEVELS) {
  const suffix = `${level[0].toUpperCase()}${level.slice(1)}`
  registerPullMacro({
    name: `summaryPlus${suffix}`,
    category: 'extension:summary_plus',
    description: `Active SummaryPlus ${suffix} summaries in chronological order.`,
    returnType: 'string',
    handler: (context) => {
      const raw = context.env?.variables?.chat?.[STATE_KEY]
      return macroValue(parseChatState(raw), level)
    },
  })
}

spindle.onFrontendMessage((payload, userId) => {
  if (!isFrontendRequest(payload)) return
  frontendUserIds.add(userId)
  void handleFrontendRequest(payload, userId).catch((error) => publishActionError(error, userId))
})

spindle.on('CHAT_SWITCHED', (payload, userId) => {
  const chatId = chatIdFromPayload(payload)
  if (!chatId) {
    void publishSnapshot(userId)
    return
  }
  void ensureState(chatId)
    .then(() => publishSnapshot(userId))
    .catch((error) => publishActionError(error, userId))
})

spindle.on('MESSAGE_SENT', (payload, userId) => {
  const chatId = chatIdFromPayload(payload)
  if (!chatId) return
  void (async () => {
    const [state, settings] = await Promise.all([
      ensureState(chatId, 'message'),
      getSettings(userId),
    ])
    if (state.historyApproved && settings.automationEnabled) {
      void runProcessing(chatId, userId)
    } else {
      await publishSnapshot(userId)
    }
  })().catch((error) => publishActionError(error, userId))
})

for (const event of ['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'SWIPE_EDITED']) {
  spindle.on(event, (payload, userId) => {
    const chatId = chatIdFromPayload(payload)
    if (!chatId || processingChats.has(chatId)) return
    void publishSnapshot(userId)
  })
}

for (const event of ['REGEX_SCRIPT_CHANGED', 'REGEX_SCRIPT_DELETED']) {
  spindle.on(event, (_payload: unknown, userId?: string) => {
    if (userId) {
      frontendUserIds.add(userId)
      void publishSnapshot(userId)
    } else {
      publishSnapshotsForKnownUsers()
    }
  })
}

spindle.on('PERMISSION_CHANGED', (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return
  const event = payload as { granted?: unknown; permission?: unknown }
  if (!event.granted && event.permission === 'generation') {
    for (const controller of controllers.values()) controller.abort()
  }
  if (event.permission === 'regex_scripts') publishSnapshotsForKnownUsers()
})

spindle.log.info('SummaryPlus 0.0.1 loaded.')

import type {
  ConnectionProfileDTO,
  GenerationRequestDTO,
  SpindleAPI,
} from 'lumiverse-spindle-types'
import {
  INPUT_PLACEHOLDER,
  LEVELS,
  SETTINGS_PATH,
  STATE_KEY,
  allPrompts,
  createChatState,
  deleteActiveEntry,
  entryCounts,
  isSameEntryBatch,
  isSameMessageBatch,
  latestActiveEntry,
  macroValue,
  normalizeSettings,
  parseChatState,
  pendingMessages,
  restoreDeletedChapterSlot,
  selectChapterBatch,
  selectedPrompt,
  selectPromotionBatch,
  sourceText,
  type ChatMessageLike,
  type ChatState,
  type ConnectionOption,
  type PromptDefinition,
  type Snapshot,
  type SummaryEntry,
  type SummaryLevel,
  type SummaryPlusSettings,
} from './core'

declare const spindle: SpindleAPI

type FrontendRequest =
  | { type: 'request_snapshot' }
  | { type: 'process_history' }
  | { type: 'process_now' }
  | { type: 'cancel_processing' }
  | { type: 'edit_entry'; entryId: string; value: string }
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

async function createSnapshot(userId?: string): Promise<Snapshot> {
  const settings = await getSettings(userId)
  let connections: ConnectionOption[] = []
  try {
    connections = (await spindle.connections.list(userId)).map(toConnectionOption)
  } catch {
    // A revoked generation permission should not make the rest of the drawer unusable.
  }

  const chatId = await activeChatId(userId)
  if (!chatId) {
    return {
      chatId: null,
      state: null,
      settings,
      prompts: allPrompts(settings),
      connections,
      processing: false,
      pendingMessageCount: 0,
      activeCounts: entryCounts(null),
    }
  }

  const [state, messages] = await Promise.all([
    ensureState(chatId),
    getMessages(chatId),
  ])
  return {
    chatId,
    state,
    settings,
    prompts: allPrompts(settings),
    connections,
    processing: processingChats.has(chatId),
    pendingMessageCount: pendingMessages(messages, state.processedMessageIds).length,
    activeCounts: entryCounts(state),
  }
}

async function publishSnapshot(userId?: string): Promise<void> {
  try {
    spindle.sendToFrontend({
      type: 'snapshot',
      snapshot: await createSnapshot(userId),
    }, userId)
  } catch (error) {
    publishActionError(error, userId)
  }
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

function generationContent(result: unknown): string {
  if (typeof result === 'string') return result.trim()
  if (
    result
    && typeof result === 'object'
    && typeof (result as { content?: unknown }).content === 'string'
  ) {
    return (result as { content: string }).content.trim()
  }
  return ''
}

async function generateSummary(
  level: SummaryLevel,
  input: string,
  settings: SummaryPlusSettings,
  signal: AbortSignal,
  userId?: string,
): Promise<string> {
  const prompt = selectedPrompt(settings, level)
  if (!prompt.userPrompt.includes(INPUT_PLACEHOLDER)) {
    throw new ConfigurationError(
      `${prompt.name} must include ${INPUT_PLACEHOLDER} in its user prompt.`,
    )
  }

  const messages: Array<{ role: 'system' | 'user'; content: string }> = []
  if (prompt.systemPrompt.trim()) {
    messages.push({ role: 'system', content: prompt.systemPrompt })
  }
  messages.push({
    role: 'user',
    content: prompt.userPrompt.replaceAll(INPUT_PLACEHOLDER, input),
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
    try {
      const content = generationContent(await spindle.generate.quiet(request))
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
  const batch = selectChapterBatch(messages, state, settings)
  if (!batch) return 'none'

  let content: string
  try {
    content = await generateSummary('chapter', sourceText(batch), settings, signal, userId)
  } catch (error) {
    if (isAbort(error)) throw error
    await recordFailure(chatId, 'chapter', error, userId)
    throw error
  }

  const [currentState, currentMessages] = await Promise.all([
    ensureState(chatId),
    getMessages(chatId),
  ])
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
  if (!restored) {
    const order = currentState.nextChapterOrder
    currentState.nextChapterOrder += 1
    currentState.entries.push({
      id: id('chapter'),
      level: 'chapter',
      content,
      orderStart: order,
      orderEnd: order,
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
  const sourceLevel = targetLevel === 'arc' ? 'chapter' : 'arc'
  const size = targetLevel === 'arc' ? settings.chaptersPerArc : settings.arcsPerVolume
  const delay = targetLevel === 'arc' ? settings.chapterDelay : settings.arcDelay
  const batch = selectPromotionBatch(state, sourceLevel, size, delay)
  if (!batch) return 'none'

  let content: string
  try {
    content = await generateSummary(targetLevel, sourceText(batch), settings, signal, userId)
  } catch (error) {
    if (isAbort(error)) throw error
    await recordFailure(chatId, targetLevel, error, userId)
    throw error
  }

  const currentState = await ensureState(chatId)
  if (!isSameEntryBatch(batch, currentState)) return 'stale'

  const createdAt = now()
  const promotedEntry: SummaryEntry = {
    id: id(targetLevel),
    level: targetLevel,
    content,
    orderStart: Math.min(...batch.map((entry) => entry.orderStart)),
    orderEnd: Math.max(...batch.map((entry) => entry.orderEnd)),
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

function mergeSettings(
  current: SummaryPlusSettings,
  incoming: Partial<SummaryPlusSettings>,
): SummaryPlusSettings {
  return normalizeSettings({
    ...current,
    ...incoming,
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

spindle.on('PERMISSION_CHANGED', (payload) => {
  if (!payload.granted && payload.permission === 'generation') {
    for (const controller of controllers.values()) controller.abort()
  }
})

spindle.log.info('SummaryPlus 0.0.1 loaded.')

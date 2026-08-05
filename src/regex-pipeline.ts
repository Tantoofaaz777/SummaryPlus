import type {
  RegexMacroModeDTO,
  RegexPlacementDTO,
  RegexScriptDTO,
} from 'lumiverse-spindle-types'
import type { ChatMessageLike } from './core'

export type SummaryRegexScript = RegexScriptDTO & {
  actions?: unknown[]
}

export type RegexMacroResolver = (template: string) => Promise<string>

function abortError(): Error {
  const error = new Error('Processing cancelled.')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function placementFor(message: ChatMessageLike): RegexPlacementDTO | null {
  if (message.role === 'user') return 'user_input'
  if (message.role === 'assistant') return 'ai_output'
  if (message.role === 'system') return 'world_info'
  return null
}

function replacementCapture(
  token: string,
  captures: Array<string | undefined>,
): string | null {
  const index = Number(token)
  if (!Number.isInteger(index) || index <= 0) return null
  if (index <= captures.length) return captures[index - 1] ?? ''
  if (token.length === 2) {
    const firstIndex = Number(token[0])
    if (firstIndex > 0 && firstIndex <= captures.length) {
      return `${captures[firstIndex - 1] ?? ''}${token[1]}`
    }
  }
  return null
}

function substituteCaptures(
  template: string,
  fullMatch: string,
  captures: Array<string | undefined>,
  offset: number,
  input: string,
  namedGroups?: Record<string, string>,
): string {
  return template.replace(
    /\$(\$|&|`|'|<([^>]+)>|(\d{1,2}))/g,
    (token, special: string, groupName: string | undefined, captureIndex: string | undefined) => {
      if (special === '$') return '$'
      if (special === '&') return fullMatch
      if (special === '`') return input.slice(0, offset)
      if (special === "'") return input.slice(offset + fullMatch.length)
      if (groupName !== undefined) {
        return namedGroups ? namedGroups[groupName] ?? '' : token
      }
      if (captureIndex !== undefined) {
        return replacementCapture(captureIndex, captures) ?? token
      }
      return token
    },
  )
}

interface CapturedReplacement {
  index: number
  matchLength: number
  template: string
}

function captureReplacements(
  input: string,
  regex: RegExp,
  replacement: string,
): CapturedReplacement[] {
  const matches: CapturedReplacement[] = []
  input.replace(regex, (...args: unknown[]) => {
    const fullMatch = String(args[0] ?? '')
    const maybeNamedGroups = args.at(-1)
    const hasNamedGroups = Boolean(
      maybeNamedGroups
      && typeof maybeNamedGroups === 'object'
      && !Array.isArray(maybeNamedGroups),
    )
    const inputIndex = hasNamedGroups ? args.length - 2 : args.length - 1
    const offsetIndex = hasNamedGroups ? args.length - 3 : args.length - 2
    const offset = Number(args[offsetIndex])
    const wholeInput = String(args[inputIndex] ?? input)
    const captures = args
      .slice(1, offsetIndex)
      .map((capture) => capture === undefined ? undefined : String(capture))
    matches.push({
      index: offset,
      matchLength: fullMatch.length,
      template: substituteCaptures(
        replacement,
        fullMatch,
        captures,
        offset,
        wholeInput,
        hasNamedGroups ? maybeNamedGroups as Record<string, string> : undefined,
      ),
    })
    return fullMatch
  })
  return matches
}

function rebuildFromMatches(
  input: string,
  matches: CapturedReplacement[],
  replacements: string[],
): string {
  let output = ''
  let lastIndex = 0
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    output += input.slice(lastIndex, match.index)
    output += replacements[index] ?? ''
    lastIndex = match.index + match.matchLength
  }
  return output + input.slice(lastIndex)
}

async function resolvedPattern(
  script: SummaryRegexScript,
  resolveMacros: RegexMacroResolver,
): Promise<string> {
  return script.substitute_macros === 'none'
    ? script.find_regex
    : resolveMacros(script.find_regex)
}

async function replaceWithScript(
  input: string,
  script: SummaryRegexScript,
  resolveMacros: RegexMacroResolver,
): Promise<string> {
  const findPattern = await resolvedPattern(script, resolveMacros)
  const regex = new RegExp(findPattern, script.flags)
  const mode: RegexMacroModeDTO = script.substitute_macros

  if (mode === 'raw') {
    const matches = captureReplacements(input, regex, script.replace_string)
    const replacements: string[] = []
    for (const match of matches) {
      replacements.push(await resolveMacros(match.template))
    }
    return rebuildFromMatches(input, matches, replacements)
  }

  if (mode === 'after') {
    return resolveMacros(input.replace(regex, script.replace_string))
  }

  if (mode === 'escaped') {
    const replacement = await resolveMacros(script.replace_string)
    return input.replace(regex, () => replacement)
  }

  return input.replace(regex, script.replace_string)
}

function trimConfiguredStrings(input: string, trimStrings: string[]): string {
  let output = input
  for (const trim of trimStrings) {
    if (trim) output = output.replaceAll(trim, '')
  }
  return output
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return 'Unknown regex error.'
}

export async function applyRegexPipeline(
  messages: ChatMessageLike[],
  scripts: SummaryRegexScript[],
  resolveMacros: RegexMacroResolver,
  signal?: AbortSignal,
): Promise<ChatMessageLike[]> {
  const output: ChatMessageLike[] = []
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    throwIfAborted(signal)
    const message = messages[messageIndex]
    const placement = placementFor(message)
    const depth = messages.length - 1 - messageIndex
    let content = message.content

    if (placement) {
      for (const script of scripts) {
        throwIfAborted(signal)
        if (!script.placement.includes(placement)) continue
        if (script.min_depth !== null && depth < script.min_depth) continue
        if (script.max_depth !== null && depth > script.max_depth) continue
        try {
          content = await replaceWithScript(content, script, resolveMacros)
          content = trimConfiguredStrings(content, script.trim_strings)
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error
          throw new Error(`Regex "${script.name}" failed: ${errorText(error)}`)
        }
      }
    }
    output.push({ ...message, content })
  }
  return output
}

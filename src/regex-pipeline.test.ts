import { describe, expect, test } from 'bun:test'
import type { RegexScriptDTO } from 'lumiverse-spindle-types'
import { applyRegexPipeline, type SummaryRegexScript } from './regex-pipeline'

function script(
  overrides: Partial<SummaryRegexScript> = {},
): SummaryRegexScript {
  return {
    id: 'regex-1',
    name: 'Test regex',
    script_id: 'test',
    find_regex: 'secret',
    replace_string: '[redacted]',
    flags: 'gi',
    placement: ['user_input', 'ai_output'],
    scope: 'global',
    scope_id: null,
    target: 'prompt',
    min_depth: null,
    max_depth: null,
    trim_strings: [],
    run_on_edit: false,
    substitute_macros: 'none',
    disabled: false,
    sort_order: 0,
    description: '',
    folder: '',
    metadata: {},
    created_at: 1,
    updated_at: 1,
    ...overrides,
  } as RegexScriptDTO
}

const resolveMacros = async (template: string) => (
  template.replaceAll('{{replacement}}', 'resolved')
)

describe('Chapter regex preprocessing', () => {
  test('runs selected scripts in order without mutating source messages', async () => {
    const messages = [
      { id: '1', role: 'user' as const, content: 'secret' },
      { id: '2', role: 'assistant' as const, content: '[redacted]' },
    ]
    const result = await applyRegexPipeline(messages, [
      script(),
      script({
        id: 'regex-2',
        name: 'Second',
        find_regex: '\\[redacted\\]',
        replace_string: 'clean',
      }),
    ], resolveMacros)
    expect(result.map((message) => message.content)).toEqual(['clean', 'clean'])
    expect(messages.map((message) => message.content)).toEqual(['secret', '[redacted]'])
  })

  test('respects placement and newest-first depth bounds', async () => {
    const messages = [
      { id: '1', role: 'user' as const, content: 'secret' },
      { id: '2', role: 'assistant' as const, content: 'secret' },
      { id: '3', role: 'assistant' as const, content: 'secret' },
    ]
    const result = await applyRegexPipeline(messages, [
      script({
        placement: ['ai_output'],
        min_depth: 1,
        max_depth: 1,
      }),
    ], resolveMacros)
    expect(result.map((message) => message.content))
      .toEqual(['secret', '[redacted]', 'secret'])
  })

  test('supports Lumiverse raw and escaped macro substitution modes', async () => {
    const raw = await applyRegexPipeline(
      [{ id: '1', role: 'user', content: 'Name: Ava' }],
      [script({
        find_regex: 'Name: (\\w+)',
        replace_string: '{{replacement}}-$1',
        flags: 'g',
        substitute_macros: 'raw',
      })],
      resolveMacros,
    )
    expect(raw[0].content).toBe('resolved-Ava')

    const escaped = await applyRegexPipeline(
      [{ id: '1', role: 'user', content: 'secret' }],
      [script({
        replace_string: '{{replacement}}-$1',
        substitute_macros: 'escaped',
      })],
      resolveMacros,
    )
    expect(escaped[0].content).toBe('resolved-$1')
  })

  test('reports the exact failing script', async () => {
    await expect(applyRegexPipeline(
      [{ id: '1', role: 'user', content: 'secret' }],
      [script({ name: 'Broken', find_regex: '[', flags: 'g' })],
      resolveMacros,
    )).rejects.toThrow('Regex "Broken" failed')
  })

  test('ignores display actions while preserving the prompt replacement', async () => {
    const result = await applyRegexPipeline(
      [{ id: '1', role: 'user', content: 'secret' }],
      [script({ name: 'Interactive', actions: [{ id: 'pick' }] })],
      resolveMacros,
    )
    expect(result[0].content).toBe('[redacted]')
  })
})

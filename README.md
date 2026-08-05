# SummaryPlus

SummaryPlus is a Lumiverse extension that turns long roleplay chats into a three-level, editable story memory:

- **Chapter** summarizes a fixed batch of persisted chat messages.
- **Arc** consolidates a fixed batch of active Chapters.
- **Volume** consolidates a fixed batch of active Arcs.

The extension keeps the active entries at every level in chronological order and exposes each level through its own prompt macro. SummaryPlus never injects delimiters or labels into macro output; prompt authors retain full control over presentation.

## Requirements

- Lumiverse 1.1.2 or newer
- At least one configured Lumiverse LLM connection
- Permissions requested by the extension:
  - `generation` for quiet summary calls and connection discovery
  - `chat_mutation` to read persisted chat history and optionally hide summarized messages
  - `chats` to identify the currently active chat
  - `regex_scripts` to list prompt-targeted Lumiverse regex

## Installation

In Lumiverse, open **Extensions**, install from this GitHub repository URL, grant the requested permissions, and enable SummaryPlus:

```text
https://github.com/Tantoofaaz777/SummaryPlus
```

The compiled `dist/` bundles are included in the repository, so installation does not depend on a local build step.

## Prompt macros

SummaryPlus registers:

- `{{summaryPlusVolume}}`
- `{{summaryPlusArc}}`
- `{{summaryPlusChapter}}`

Each macro returns only the currently active summaries at that level, ordered from oldest to newest and joined by one blank line. An empty level returns an empty string.

A typical roleplay prompt can decide the hierarchy and delimiters itself:

```text
{{if::{{summaryPlusVolume}}}}
{{summaryPlusVolume}}
{{/if}}

{{if::{{summaryPlusArc}}}}
{{summaryPlusArc}}
{{/if}}

{{if::{{summaryPlusChapter}}}}
{{summaryPlusChapter}}
{{/if}}
```

`{{arc}}` is a native Lumiverse macro and is not used by this extension.

## Counting and delay behavior

Only records returned by Lumiverse's persisted chat-history API are counted. Prompt assembly, presets, world books, SummaryPlus's own generation prompts, and quiet-generation calls are not part of the count.

Every persisted record counts as one message. Summary input contains only the active message contents, in history order, separated by blank lines. Names, IDs, timestamps, metadata, reasoning, and inactive swipes are omitted. Message roles are used only to select applicable regex placements and are not sent to the summarizing model.

Delays are item-count lookaheads, not timers. With 6 messages per Chapter and a delay of 3, reaching 9 pending messages summarizes messages 1–6; messages 7–9 are not sent to the summarizing model and stay pending for a later batch. Batches are consecutive and never overlap.

Deleting or editing a message before its Chapter is committed causes SummaryPlus to re-read and revalidate the current history. Already-created summaries are never silently rewritten after a configuration or chat-history change.

## Regex preprocessing

The Settings screen lists the Lumiverse regex available to the active chat whose target includes `prompt`. Each rule has an independent SummaryPlus switch and can be reordered by dragging its handle or by focusing the handle and pressing the up/down arrow keys.

SummaryPlus applies enabled rules from top to bottom to each message immediately before creating or regenerating a Chapter. Lumiverse placement and depth filters are respected. A rule selected in SummaryPlus runs even when that rule is disabled for normal Lumiverse prompt processing; the SummaryPlus switches do not change the rule's Lumiverse setting.

Regex preprocessing never edits persisted chat messages. Arc and Volume generation consumes the resulting summary entries and does not rerun message regex. Display actions do not run during prompt preprocessing. If a selected expression is invalid, Chapter generation fails before contacting the model and leaves its source messages eligible for another attempt.

## Existing chats

When SummaryPlus first encounters a chat with more than its opening message, automation stays paused for that chat. The main screen displays a **Process history & enable** button. Pressing it processes every currently eligible batch in sequence, with all configured delays respected, and then enables normal automatic processing for that chat.

A chat first encountered with only its opening message is treated as new and may use automation immediately.

## Chat branches

SummaryPlus synchronizes Lumiverse chat branches without contacting the summarizing model. Fully inherited Chapters are remapped to the copied messages in the new chat. A Chapter that crosses the fork point is discarded from that branch, along with any Arc or Volume that depends on it; valid lower-level summaries are restored as active entries. The original chat is never modified, and the new branch continues with its own independent state and numbering.

Branch synchronization runs on Lumiverse's `CHAT_FORKED` event and is also checked on first access, so untouched branches created while the extension was unavailable can be repaired later. If the source positions cannot be proven safely, automation and SummaryPlus macros are paused for that branch instead of processing potentially stale history. The Summary screen can retry synchronization or, after explicit confirmation, reset only that branch's SummaryPlus memory and return it to manual history approval.

## Promotion and editing

When an Arc succeeds, its source Chapters become archived and disappear from the Chapter macro. When a Volume succeeds, its source Arcs do the same. Archived entries remain in persisted state with their parent reference; promotion is committed only after a successful model response.

The Summary screen displays the combined active timeline and offers All, Volume, Arc, and Chapter filters. Every visible summary is editable. Saved edits become the authoritative source if that entry is later promoted.

Each card identifies its direct source range: `CHAPTER 1 • MESSAGES 1-24`, `ARC 1 • CHAPTERS 1-8`, or `VOLUME 1 • ARCS 1-8`. Message ranges use Lumiverse's persisted chat positions, so deleted-message gaps remain part of the displayed bounds—for example, source messages 1, 4, 6, and 12 are shown as `MESSAGES 1-12`. The captured bounds remain stable after creation.

Only the most recent active entry can be regenerated or deleted. Regeneration reuses that entry's original messages, Chapters, or Arcs with the currently selected prompt and generation settings; optional context placeholders are resolved again from the current older timeline. The existing text is replaced only after a successful response, so cancellation, missing sources, or generation failure leaves it intact. Deletion works in the same newest-to-oldest order and releases the deleted entry's direct sources for processing again.

## Automatic trimming

The **Trimming** card can automatically hide a Chapter's source messages after successful Chapter creation. Lumiverse excludes hidden messages from normal prompt-history assembly while keeping them in persisted chat history, so SummaryPlus can still find the original sources for regeneration and branch synchronization.

Trimming is disabled by default. Its delay is measured in completed Chapters: `0` hides a Chapter's messages immediately, `1` keeps the newest Chapter's messages visible, and `N` keeps the newest `N` Chapters visible. Arc and Volume promotion never changes message visibility.

SummaryPlus records only messages that it changed from visible to hidden. Messages already hidden by the user are never claimed or unhidden by the extension. Deleting a Chapter unhides its SummaryPlus-owned source messages before releasing them, and **Unhide SummaryPlus messages** restores all currently owned messages without reprocessing summaries. Disabling trimming stops future hides but does not automatically unhide previous ones.

## Defaults

| Setting | Default |
| --- | ---: |
| Messages per Chapter | 24 |
| Message delay | 12 |
| Chapters per Arc | 8 |
| Chapter delay | 2 |
| Arcs per Volume | 8 |
| Arc delay | 2 |
| Hide summarized messages | Off |
| Hide delay | 1 Chapter |
| Retries after the first call | 1 |
| Temperature | 0.2 |
| Top P | 1 |
| Maximum response tokens | 4096 |
| Global automation | On |

Retries are additional attempts after the initial call. SummaryPlus imposes no arbitrary maximum on the value selected by the user.

## Prompts

Chapter, Arc, and Volume each have an independent protected default prompt with separate System and User fields. Default prompts cannot be edited or deleted; duplicate one to create a customizable copy. Custom prompts can be renamed, duplicated, selected, edited, and deleted.

The User prompt must contain the private placeholder:

```text
{{summaryPlusInput}}
```

At generation time the placeholder receives:

- raw persisted message contents for a Chapter,
- active Chapter contents for an Arc,
- active Arc contents for a Volume.

User prompts may also include an optional, parameterized context placeholder:

```text
{{summaryPlusContext::3}}
```

The non-negative integer selects how many active entries immediately before the current source batch to inject. Selection is level-agnostic: the three entries may be any chronological combination of Volumes, Arcs, and Chapters. Entries in the current batch, delayed entries after it, and inactive entries are excluded. If fewer entries exist, all available entries are used; `0` injects an empty string.

Context entries are joined oldest-to-newest with blank lines and no extension-defined labels or delimiters. The prompt author controls their presentation, for example:

```text
Previous context, for continuity only:
{{summaryPlusContext::3}}

Material to summarize:
{{summaryPlusInput}}
```

Both placeholders are internal to SummaryPlus and separate from the three public roleplay prompt macros. Omitting `{{summaryPlusContext::N}}` preserves the original context-free generation behavior.

## Failure behavior

Provider errors, timeouts, and empty responses use the configured retry count with a one-second pause between attempts. Cancellation, disabling automation, or losing generation permission aborts without retrying.

While a summary is being generated, the Summary screen displays live character-based estimates for output tokens. The separate reasoning estimate appears only when the provider actually emits reasoning content. The progress card also provides a full-width **Cancel** button; cancelling preserves the current source items and any existing summary text.

After all attempts fail, source items remain active and unmodified. The main screen shows the failed level and provider error, and **Process now** can resume from the same oldest eligible batch.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

Source files live in `src/`; distributable backend and frontend bundles are emitted to `dist/`.

## License

[GNU Affero General Public License v3.0](LICENSE)

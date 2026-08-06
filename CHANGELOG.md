# Changelog

## 0.0.1 — 2026-08-05

- Added chronological Chapter, Arc, and Volume summary generation.
- Added count-based delays, fixed non-overlapping batches, and sequential catch-up.
- Added editable active-summary timeline with level filters.
- Added independent protected and custom prompts for all three levels.
- Added global connection, sampling, token, retry, and automation settings.
- Added chat-persisted state, user-persisted settings, cancellation, retries, and failure recovery.
- Added `summaryPlusChapter`, `summaryPlusArc`, and `summaryPlusVolume` macros.
- Added independently enabled and reorderable Lumiverse prompt-regex preprocessing for Chapter sources.
- Fixed regex-permission refreshes for operator-scoped Lumiverse installations.
- Fixed regex dragging to keep the floating row opaque and show a distinct dashed drop placeholder.
- Darkened configuration containers with the same subtle Lumiverse surface used by SceneMap.
- Added stable source-range labels to Chapter, Arc, and Volume cards, preserving deleted-message gaps.
- Added branch-safe state migration with message-ID remapping, hierarchy rollback, macro guards, and failure recovery.
- Added opt-in automatic message trimming with a Chapter delay, ownership-safe unhiding, deletion restoration, and branch remapping.
- Hid the dependent Trimming controls while automatic message hiding is disabled.
- Centered all screen headers with wider vertical spacing and replaced the automation checkbox with a themed switch.
- Shortened the Prompt Library navigation-tab label to Prompts.
- Moved Trimming into the top Automation card beneath Automatic processing.
- Fixed manual unhiding so eligible Chapters can be hidden again after automation is reactivated.
- Added always-visible manual controls to hide all summarized messages without delay or unhide all SummaryPlus-owned messages.
- Disabled the manual hide action when no summarized source messages remain visible.
- Added SceneMap-style expanded Lumiverse editors for editable System and User prompt fields.
- Resolved only `{{user}}` and `{{char}}` through Lumiverse before summary generation.

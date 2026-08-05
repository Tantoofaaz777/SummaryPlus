import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import Sortable from 'sortablejs'
import {
  LEVELS,
  activeEntries,
  createDefaultSettings,
  entryDisplayTitle,
  type GenerationProgress,
  type PromptDefinition,
  type Snapshot,
  type SummaryEntry,
  type SummaryLevel,
  type SummaryPlusSettings,
} from './core'

type BackendMessage =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'action_error'; message: string }
  | { type: 'generation_progress'; chatId: string; progress: GenerationProgress }
  | {
    type: 'entry_editor_closed'
    chatId: string
    entryId: string
    text: string
    cancelled: boolean
  }

type Screen = 'summary' | 'prompts' | 'settings'
type SummaryFilter = 'all' | SummaryLevel

const LEVEL_LABEL: Record<SummaryLevel, string> = {
  chapter: 'Chapter',
  arc: 'Arc',
  volume: 'Volume',
}

const ICON = `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M6.5 4.5h11M6.5 9.5h11M6.5 14.5h7M4 4.5h.01M4 9.5h.01M4 14.5h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M14.5 18.5 17 21l4-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

const EXPAND_ICON = `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M8.5 4.5h-4v4M15.5 4.5h4v4M19.5 15.5v4h-4M4.5 15.5v4h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

const REGENERATE_ICON = `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M19.2 8.5A7.5 7.5 0 1 0 19 16M19.2 4.5v4h-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

const DELETE_ICON = `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M4.5 7h15M9.5 3.5h5L16 7H8l1.5-3.5ZM7 7l.75 13h8.5L17 7M10 10.5v6M14 10.5v6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

const DRAG_ICON = `
<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="8" cy="7" r="1.4"/>
  <circle cx="16" cy="7" r="1.4"/>
  <circle cx="8" cy="12" r="1.4"/>
  <circle cx="16" cy="12" r="1.4"/>
  <circle cx="8" cy="17" r="1.4"/>
  <circle cx="16" cy="17" r="1.4"/>
</svg>`

const STYLES = `
.summaryplus-root {
  --sp-accent: var(--lumiverse-primary, #8b78f6);
  --sp-accent-soft: color-mix(in srgb, var(--sp-accent) 14%, transparent);
  --sp-surface: var(--lumiverse-fill, rgba(255, 255, 255, 0.045));
  --sp-surface-subtle: var(--lumiverse-fill-subtle, rgba(255, 255, 255, 0.025));
  --sp-secondary: var(--lumiverse-secondary, rgba(128, 128, 128, 0.15));
  --sp-secondary-hover: var(--lumiverse-secondary-hover, rgba(128, 128, 128, 0.25));
  --sp-secondary-border: var(--lumiverse-secondary-border, rgba(128, 128, 128, 0.25));
  --sp-border: var(--lumiverse-border, rgba(255, 255, 255, 0.11));
  --sp-text: var(--lumiverse-text, inherit);
  --sp-muted: var(--lumiverse-text-muted, rgba(255, 255, 255, 0.62));
  min-height: 100%;
  color: var(--sp-text);
  font: inherit;
}
.summaryplus-root * { box-sizing: border-box; }
.summaryplus-shell { display: flex; flex-direction: column; min-height: 100%; }
.summaryplus-nav {
  display: flex; gap: 2px; width: min(calc(100% - 28px), 380px); margin: 14px auto 0;
  padding: 3px; border: 1px solid var(--lumiverse-border, var(--sp-border));
  border-radius: var(--lumiverse-radius-md, 10px);
  background: var(--lumiverse-fill-subtle, var(--sp-surface-subtle));
}
.summaryplus-nav button {
  appearance: none; flex: 1 1 0; min-width: 0; padding: 7px 10px;
  border: 1px solid transparent; border-radius: var(--lumiverse-radius, 8px);
  background: transparent; color: var(--lumiverse-text-dim, var(--sp-muted)); font: inherit;
  font-size: calc(12px * var(--lumiverse-font-scale, 1)); font-weight: 500; text-align: center;
  cursor: pointer;
  transition:
    color var(--lumiverse-transition-fast, .15s ease),
    background var(--lumiverse-transition-fast, .15s ease),
    border-color var(--lumiverse-transition-fast, .15s ease),
    box-shadow var(--lumiverse-transition-fast, .15s ease);
}
.summaryplus-nav button:hover:not(.is-active) {
  color: var(--lumiverse-text-muted, var(--sp-muted));
  background: var(--lumiverse-fill-subtle, var(--sp-surface-subtle));
}
.summaryplus-nav button.is-active, .summaryplus-nav button.is-active:hover {
  color: var(--lumiverse-primary-text, var(--lumiverse-primary, var(--sp-accent)));
  background: var(--lumiverse-primary-015, color-mix(in srgb, var(--sp-accent) 15%, transparent));
  border-color: var(--lumiverse-primary-050, var(--lumiverse-primary, var(--sp-accent)));
  box-shadow: var(--lumiverse-shadow-sm);
}
.summaryplus-pill {
  appearance: none; border: 1px solid transparent; border-radius: 999px; padding: 7px 11px;
  background: transparent; color: var(--sp-muted); font: inherit; font-size: 12px;
  font-weight: 650; cursor: pointer; transition: background .16s, color .16s, border-color .16s;
}
.summaryplus-pill:hover { color: var(--sp-text); background: var(--sp-surface); }
.summaryplus-pill.is-active {
  color: var(--sp-text); background: var(--sp-accent-soft);
  border-color: color-mix(in srgb, var(--sp-accent) 38%, transparent);
}
.summaryplus-content { display: flex; flex-direction: column; gap: 14px; padding: 14px 12px 22px; }
.summaryplus-hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.summaryplus-eyebrow { color: var(--sp-accent); font-size: 10px; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
.summaryplus-title { margin: 3px 0 2px; font-size: 18px; line-height: 1.25; font-weight: 750; }
.summaryplus-copy, .summaryplus-help { color: var(--sp-muted); font-size: 12px; line-height: 1.55; }
.summaryplus-generation {
  display: grid; justify-items: center; gap: 9px; width: 100%; padding: 12px;
  border: 1px solid var(--lumiverse-primary-050, var(--lumiverse-primary, var(--sp-accent)));
  border-radius: var(--lumiverse-radius-md, 10px);
  background: var(--lumiverse-primary-015, color-mix(in srgb, var(--sp-accent) 15%, transparent));
  text-align: center;
}
.summaryplus-generation-status {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  color: var(--lumiverse-primary-text, var(--lumiverse-primary, var(--sp-accent)));
  font-size: 12px; font-weight: 650;
}
.summaryplus-generation-indicator {
  width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%;
  background: currentColor;
  animation: summaryplus-generation-pulse 1.2s ease-in-out infinite;
}
.summaryplus-generation-dots { margin-left: 1px; white-space: nowrap; }
.summaryplus-generation-dots span {
  display: inline-block;
  animation: summaryplus-dot-fade 1.2s ease-in-out infinite;
}
.summaryplus-generation-dots span:nth-child(2) { animation-delay: .16s; }
.summaryplus-generation-dots span:nth-child(3) { animation-delay: .32s; }
.summaryplus-generation-tokens,
.summaryplus-generation-retry {
  color: var(--sp-muted); font-size: 12px; font-variant-numeric: tabular-nums;
}
.summaryplus-generation-retry[hidden] { display: none; }
.summaryplus-generation-cancel { width: 100%; }
.summaryplus-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.summaryplus-stat { min-width: 0; padding: 8px 6px; border: 1px solid var(--sp-secondary-border); border-radius: var(--lumiverse-radius-md, 10px); background: var(--sp-secondary); text-align: center; }
.summaryplus-stat strong { display: block; overflow: hidden; font-size: 15px; text-overflow: ellipsis; }
.summaryplus-stat span { display: block; margin-top: 1px; color: var(--sp-muted); font-size: 9px; letter-spacing: .06em; text-transform: uppercase; }
.summaryplus-banner { padding: 11px 12px; border: 1px solid var(--sp-secondary-border); border-radius: var(--lumiverse-radius-md, 10px); background: var(--sp-secondary); font-size: 12px; line-height: 1.5; }
.summaryplus-banner.is-warning { border-color: color-mix(in srgb, #e6ad43 46%, transparent); background: color-mix(in srgb, #e6ad43 10%, transparent); }
.summaryplus-banner.is-error { border-color: color-mix(in srgb, #e16464 48%, transparent); background: color-mix(in srgb, #e16464 10%, transparent); }
.summaryplus-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.summaryplus-toolbar.is-split { justify-content: space-between; }
.summaryplus-toolbar-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.summaryplus-actions { display: flex; flex-wrap: wrap; gap: 7px; }
.summaryplus-button {
  appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 34px; border: 1px solid var(--sp-border); border-radius: 9px; padding: 7px 11px;
  background: var(--sp-surface); color: var(--sp-text); font: inherit; font-size: 12px; font-weight: 650;
  cursor: pointer; transition: transform .12s, background .16s, opacity .16s;
}
.summaryplus-button:hover:not(:disabled) { background: color-mix(in srgb, var(--sp-accent) 12%, var(--sp-surface)); }
.summaryplus-button:active:not(:disabled) { transform: translateY(1px); }
.summaryplus-button:disabled { cursor: not-allowed; opacity: .48; }
.summaryplus-button.is-danger { color: #ef8585; }
.summaryplus-button.is-quiet { min-height: 30px; padding: 5px 8px; background: transparent; }
.summaryplus-button.is-tint-primary {
  color: var(--lumiverse-primary-text, var(--lumiverse-primary, var(--sp-accent)));
  border-color: var(--lumiverse-primary-050, var(--lumiverse-primary, var(--sp-accent)));
  background: var(--lumiverse-primary-015, color-mix(in srgb, var(--sp-accent) 15%, transparent));
}
.summaryplus-button.is-tint-primary:hover:not(:disabled) {
  background: var(--lumiverse-primary-020, color-mix(in srgb, var(--sp-accent) 20%, transparent));
}
.summaryplus-button.is-tint-success {
  color: var(--lumiverse-success, #22c55e);
  border-color: var(--lumiverse-success-050, rgba(34, 197, 94, .5));
  background: var(--lumiverse-success-015, rgba(34, 197, 94, .15));
}
.summaryplus-button.is-tint-success:hover:not(:disabled) {
  background: var(--lumiverse-success-020, rgba(34, 197, 94, .2));
}
.summaryplus-button.is-tint-danger {
  color: var(--lumiverse-danger, #ef4444);
  border-color: var(--lumiverse-danger-050, rgba(239, 68, 68, .5));
  background: var(--lumiverse-danger-015, rgba(239, 68, 68, .15));
}
.summaryplus-button.is-tint-danger:hover:not(:disabled) {
  background: var(--lumiverse-danger-020, rgba(239, 68, 68, .2));
}
.summaryplus-stack { display: flex; flex-direction: column; gap: 8px; }
.summaryplus-entry {
  display: flex; align-items: stretch; width: 100%; min-height: 48px; border: 1px solid var(--sp-secondary-border);
  border-radius: var(--lumiverse-radius, 8px); outline: none;
  background: var(--sp-secondary); color: var(--sp-text); font: inherit; text-align: left;
  transition:
    color var(--lumiverse-transition-fast, .15s ease),
    background var(--lumiverse-transition-fast, .15s ease),
    border-color var(--lumiverse-transition-fast, .15s ease),
    box-shadow var(--lumiverse-transition-fast, .15s ease);
}
.summaryplus-entry:hover:not(.is-disabled) {
  border-color: var(--lumiverse-border-hover, var(--sp-secondary-border));
  background: var(--sp-secondary-hover);
}
.summaryplus-entry:focus-within {
  border-color: color-mix(in srgb, var(--sp-accent) 70%, var(--sp-border));
  box-shadow: 0 0 0 3px var(--sp-accent-soft);
}
.summaryplus-entry.has-pending-change {
  border-color: var(--lumiverse-success-050, rgba(34, 197, 94, .5));
  background: var(--lumiverse-success-015, rgba(34, 197, 94, .15));
}
.summaryplus-entry.is-disabled { opacity: .48; }
.summaryplus-entry-open {
  appearance: none; display: flex; align-items: center; flex: 1 1 auto; min-width: 0;
  border: 0; padding: 11px 8px 11px 13px; outline: none;
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.summaryplus-entry-open:disabled, .summaryplus-entry-action:disabled { cursor: not-allowed; }
.summaryplus-entry-actions {
  display: flex; align-items: center; flex: 0 0 auto; gap: 5px; padding: 7px 9px 7px 0;
  opacity: 0; transition: opacity var(--lumiverse-transition-fast, .15s ease);
}
.summaryplus-entry:hover .summaryplus-entry-actions,
.summaryplus-entry:focus-within .summaryplus-entry-actions {
  opacity: 1;
}
.summaryplus-entry-action {
  appearance: none; display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border: 0;
  padding: 5px; background: transparent; color: var(--lumiverse-icon-muted, var(--sp-muted));
  cursor: pointer; transition: color .16s, transform .12s;
}
.summaryplus-entry-action:hover:not(:disabled) {
  color: var(--lumiverse-primary-text, var(--lumiverse-primary, var(--sp-accent)));
}
.summaryplus-entry-action:active:not(:disabled) { transform: translateY(1px); }
.summaryplus-entry-action.is-delete:hover:not(:disabled) {
  color: var(--lumiverse-danger, #ef4444);
}
.summaryplus-entry-label {
  min-width: 0; overflow: hidden; color: var(--sp-text); font-size: 10px; font-weight: 800;
  letter-spacing: .1em; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap;
}
.summaryplus-entry-icon {
  display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
}
.summaryplus-entry-icon svg { display: block; width: 100%; height: 100%; }
.summaryplus-textarea, .summaryplus-input, .summaryplus-select {
  width: 100%; border: 1px solid var(--sp-secondary-border); border-radius: var(--lumiverse-radius, 8px); outline: none;
  background: var(--sp-secondary); color: var(--sp-text);
  font: inherit; font-size: 12px; transition: border-color .16s, box-shadow .16s;
}
.summaryplus-textarea:focus, .summaryplus-input:focus, .summaryplus-select:focus {
  border-color: color-mix(in srgb, var(--sp-accent) 70%, var(--sp-border));
  box-shadow: 0 0 0 3px var(--sp-accent-soft);
}
.summaryplus-textarea { min-height: 112px; resize: vertical; padding: 10px; line-height: 1.55; }
.summaryplus-input, .summaryplus-select { height: 36px; padding: 0 9px; }
.summaryplus-input::placeholder { color: var(--lumiverse-text-hint, var(--sp-muted)); opacity: 1; }
.summaryplus-textarea:read-only, .summaryplus-input:read-only { opacity: .72; cursor: default; }
.summaryplus-empty { padding: 30px 18px; border: 1px dashed var(--sp-secondary-border); border-radius: var(--lumiverse-radius-lg, 12px); background: var(--sp-secondary); text-align: center; }
.summaryplus-empty strong { display: block; margin-bottom: 5px; font-size: 13px; }
.summaryplus-section { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--lumiverse-border, var(--sp-border)); border-radius: var(--lumiverse-radius-lg, 12px); background: var(--lumiverse-fill-subtle, var(--sp-surface-subtle)); }
.summaryplus-section-title { margin: 0; font-size: 13px; font-weight: 750; }
.summaryplus-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.summaryplus-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.summaryplus-field.is-wide { grid-column: 1 / -1; }
.summaryplus-label { font-size: 11px; font-weight: 650; }
.summaryplus-switch { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.summaryplus-switch input { width: 17px; height: 17px; accent-color: var(--sp-accent); }
.summaryplus-regex-list { display: flex; flex-direction: column; gap: 7px; }
.summaryplus-regex-row {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center;
  min-height: 42px; overflow: hidden; border: 1px solid var(--sp-secondary-border);
  border-radius: var(--lumiverse-radius, 8px); background: var(--sp-secondary);
  transition:
    background var(--lumiverse-transition-fast, .15s ease),
    border-color var(--lumiverse-transition-fast, .15s ease),
    box-shadow var(--lumiverse-transition-fast, .15s ease);
}
.summaryplus-regex-row:hover { background: var(--sp-secondary-hover); }
.summaryplus-regex-name {
  min-width: 0; overflow: hidden; padding: 0 8px; color: var(--sp-text);
  font-size: 12px; font-weight: 550; text-overflow: ellipsis; white-space: nowrap;
}
.summaryplus-regex-drag {
  appearance: none; display: inline-flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; border: 0; outline: none; padding: 8px;
  background: transparent; color: var(--lumiverse-text-dim, var(--sp-muted));
  cursor: grab; touch-action: none; user-select: none;
  transition: color var(--lumiverse-transition-fast, .15s ease);
}
.summaryplus-regex-drag:hover,
.summaryplus-regex-drag:focus-visible,
.summaryplus-regex-drag[aria-grabbed="true"] {
  color: var(--lumiverse-primary-text, var(--lumiverse-primary, var(--sp-accent)));
}
.summaryplus-regex-drag:focus-visible {
  border-radius: var(--lumiverse-radius, 8px);
  box-shadow: inset 0 0 0 2px var(--lumiverse-primary, var(--sp-accent));
}
.summaryplus-regex-drag:active { cursor: grabbing; }
.summaryplus-regex-drag svg { display: block; width: 18px; height: 18px; pointer-events: none; }
.summaryplus-regex-toggle {
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  align-self: stretch; padding: 8px 10px 8px 4px; cursor: pointer;
}
.summaryplus-regex-toggle.summaryplus-settings-toggle { align-self: auto; padding: 0; }
.summaryplus-regex-toggle input {
  position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none;
}
.summaryplus-regex-switch {
  position: relative; width: 32px; height: 18px; flex: 0 0 auto;
  border: 1px solid var(--lumiverse-border-hover, var(--sp-secondary-border));
  border-radius: var(--lumiverse-radius-md, 10px);
  background: var(--lumiverse-fill, var(--sp-surface));
  transition:
    background var(--lumiverse-transition-fast, .15s ease),
    border-color var(--lumiverse-transition-fast, .15s ease);
}
.summaryplus-regex-switch::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
  border-radius: 50%; background: var(--lumiverse-text-muted, var(--sp-muted));
  transition:
    transform var(--lumiverse-transition-fast, .15s ease),
    background var(--lumiverse-transition-fast, .15s ease);
}
.summaryplus-regex-toggle input:focus-visible + .summaryplus-regex-switch {
  outline: 2px solid var(--lumiverse-primary, var(--sp-accent)); outline-offset: 2px;
}
.summaryplus-regex-toggle input:checked + .summaryplus-regex-switch {
  border-color: var(--lumiverse-primary, var(--sp-accent));
  background: var(--lumiverse-primary, var(--sp-accent));
}
.summaryplus-regex-toggle input:checked + .summaryplus-regex-switch::after {
  transform: translateX(14px);
  background: var(--lumiverse-primary-contrast, #fff);
}
.summaryplus-trimming-action { width: 100%; }
.summaryplus-regex-ghost {
  opacity: 1 !important;
  border: 1px dashed var(--lumiverse-primary-050, var(--lumiverse-primary, var(--sp-accent))) !important;
  border-radius: var(--lumiverse-radius, 8px);
  background:
    linear-gradient(
      var(--lumiverse-primary-010, color-mix(in srgb, var(--sp-accent) 10%, transparent)),
      var(--lumiverse-primary-010, color-mix(in srgb, var(--sp-accent) 10%, transparent))
    ),
    var(--lumiverse-bg-deep, var(--sp-secondary)) !important;
}
.summaryplus-regex-ghost > * { visibility: hidden !important; }
.summaryplus-regex-chosen {
  border-color: var(--lumiverse-primary-050, var(--lumiverse-primary, var(--sp-accent))) !important;
}
.summaryplus-regex-active,
.summaryplus-regex-fallback {
  opacity: 1 !important;
  border: 1px solid var(--lumiverse-primary-050, var(--lumiverse-primary, var(--sp-accent))) !important;
  border-radius: var(--lumiverse-radius, 8px);
  background:
    linear-gradient(
      var(--lumiverse-fill-subtle, rgba(128, 128, 128, .12)),
      var(--lumiverse-fill-subtle, rgba(128, 128, 128, .12))
    ),
    var(--lumiverse-bg-deep, var(--sp-secondary)) !important;
  box-shadow: var(--lumiverse-shadow-lg, 0 12px 30px rgba(0, 0, 0, .38));
}
.summaryplus-regex-fallback { pointer-events: none !important; z-index: 10020 !important; }
.summaryplus-regex-is-dragging { cursor: grabbing; }
.summaryplus-regex-is-dragging * {
  cursor: grabbing !important; user-select: none !important; -webkit-user-select: none !important;
}
.summaryplus-sr-only {
  position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0);
  clip-path: inset(50%); margin: -1px; padding: 0; border: 0; white-space: nowrap;
}
.summaryplus-prompt-head { display: flex; align-items: center; gap: 7px; }
.summaryplus-prompt-head .summaryplus-select { flex: 1; min-width: 0; }
.summaryplus-prompt-head .summaryplus-button { flex: 0 0 auto; }
.summaryplus-builtin { display: inline-flex; align-items: center; width: fit-content; padding: 3px 7px; border-radius: 999px; background: var(--sp-accent-soft); color: var(--sp-accent); font-size: 9px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.summaryplus-loading { display: flex; align-items: center; justify-content: center; min-height: 220px; color: var(--sp-muted); font-size: 12px; }
.summaryplus-dot { width: 7px; height: 7px; margin-right: 8px; border-radius: 50%; background: var(--sp-accent); animation: summaryplus-pulse 1s ease-in-out infinite alternate; }
@keyframes summaryplus-pulse { to { opacity: .28; transform: scale(.78); } }
@keyframes summaryplus-generation-pulse {
  0%, 100% { opacity: .72; }
  50% { opacity: 1; }
}
@keyframes summaryplus-dot-fade {
  0%, 20% { opacity: .2; transform: translateY(0); }
  45% { opacity: 1; transform: translateY(-1px); }
  80%, 100% { opacity: .2; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .summaryplus-generation-indicator,
  .summaryplus-generation-dots span,
  .summaryplus-regex-row,
  .summaryplus-regex-drag,
  .summaryplus-regex-switch,
  .summaryplus-regex-switch::after {
    animation: none;
    transition: none;
    opacity: 1;
    transform: none;
  }
}
@media (any-hover: none) {
  .summaryplus-entry-actions { opacity: 1; }
  .summaryplus-regex-drag { width: 44px; height: 44px; padding: 11px; }
}
@media (max-width: 370px) {
  .summaryplus-grid { grid-template-columns: 1fr; }
  .summaryplus-field.is-wide { grid-column: auto; }
  .summaryplus-stats { grid-template-columns: repeat(2, 1fr); }
}
`

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(
  label: string,
  onClick: () => void,
  className = '',
  disabled = false,
): HTMLButtonElement {
  const node = element('button', `summaryplus-button ${className}`.trim(), label)
  node.type = 'button'
  node.disabled = disabled
  node.addEventListener('click', onClick)
  return node
}

function isBackendMessage(payload: unknown): payload is BackendMessage {
  return Boolean(
    payload
    && typeof payload === 'object'
    && typeof (payload as { type?: unknown }).type === 'string',
  )
}

function generationSignature(progress: GenerationProgress | null): string {
  if (!progress) return 'preparing'
  return [
    progress.action,
    progress.level,
    progress.orderStart,
    progress.orderEnd,
  ].join(':')
}

function generationTitle(progress: GenerationProgress | null): string {
  if (!progress) return 'Preparing summaries'
  const verb = progress.action === 'regenerate' ? 'Regenerating' : 'Creating'
  const target = progress.level === 'chapter'
    ? `Chapter ${progress.orderStart}`
    : `${LEVEL_LABEL[progress.level]} · Chapters ${progress.orderStart}-${progress.orderEnd}`
  return `${verb} ${target}`
}

function generationTokenText(progress: GenerationProgress | null): string {
  const outputTokens = progress?.outputTokens ?? 0
  const reasoningTokens = progress?.reasoningTokens ?? 0
  const outputText = `~${outputTokens} output tokens`
  return reasoningTokens > 0
    ? `${outputText} · ~${reasoningTokens} reasoning tokens`
    : outputText
}

function generationRetryText(progress: GenerationProgress | null): string {
  if (!progress || progress.attempt <= 1 || progress.maxAttempts <= 1) return ''
  return `Retry ${progress.attempt - 1} of ${progress.maxAttempts - 1}`
}

function deleteEntryMessage(entry: SummaryEntry): string {
  if (entry.level === 'chapter') {
    return `Delete ${entryDisplayTitle(entry)}? Its summary text will be permanently deleted and its source messages will become eligible for Chapter processing again.`
  }
  const sourceLevel = entry.level === 'arc' ? 'Chapter' : 'Arc'
  const sourceLabel = `${sourceLevel}${entry.sourceIds.length === 1 ? '' : 's'}`
  return `Delete ${entryDisplayTitle(entry)}? Its summary text will be permanently deleted and its ${entry.sourceIds.length} source ${sourceLabel} will be restored.`
}

function regenerateEntryMessage(entry: SummaryEntry): string {
  return `Regenerate ${entryDisplayTitle(entry)} from its original sources using the current prompt and generation settings? The existing summary will be replaced only if generation succeeds.`
}

function numberField(
  labelText: string,
  value: number,
  options: { min?: number; step?: number; defaultValue?: number } = {},
): { field: HTMLLabelElement; input: HTMLInputElement } {
  const field = element('label', 'summaryplus-field')
  field.appendChild(element('span', 'summaryplus-label', labelText))
  const input = element('input', 'summaryplus-input')
  input.type = 'number'
  input.value = options.defaultValue !== undefined && value === options.defaultValue
    ? ''
    : String(value)
  if (options.defaultValue !== undefined) input.placeholder = String(options.defaultValue)
  if (options.min !== undefined) input.min = String(options.min)
  if (options.step !== undefined) input.step = String(options.step)
  field.appendChild(input)
  return { field, input }
}

export function setup(ctx: SpindleFrontendContext): () => void {
  const removeStyle = ctx.dom.addStyle(STYLES)
  const tab = ctx.ui.registerDrawerTab({
    id: 'summaryplus',
    title: 'SummaryPlus',
    shortName: 'Summary+',
    headerTitle: 'SummaryPlus',
    description: 'Create and edit Chapter, Arc, and Volume summaries.',
    keywords: ['summary', 'memory', 'chapter', 'arc', 'volume'],
    iconSvg: ICON,
  })

  const root = element('div', 'summaryplus-root')
  tab.root.replaceChildren(root)

  let snapshot: Snapshot | null = null
  let screen: Screen = 'summary'
  let filter: SummaryFilter = 'all'
  let promptLevel: SummaryLevel = 'chapter'
  let editingEntryId: string | null = null
  let regeneratingEntryId: string | null = null
  let deletingEntryId: string | null = null
  let draftChatId: string | null = null
  let regexSortable: Sortable | null = null
  const entryDrafts = new Map<string, string>()
  const promptDrafts = new Map<string, Pick<PromptDefinition, 'name' | 'systemPrompt' | 'userPrompt'>>()

  const send = (payload: unknown) => ctx.sendToBackend(payload)

  const destroyRegexSortable = () => {
    regexSortable?.destroy()
    regexSortable = null
    document.body.classList.remove('summaryplus-regex-is-dragging')
  }

  const regexRows = (container: HTMLElement): HTMLElement[] => (
    Array.from(container.children)
      .filter((child): child is HTMLElement => child instanceof HTMLElement)
      .filter((child) => child.classList.contains('summaryplus-regex-row'))
  )

  const regexOrderFromDom = (container: HTMLElement): string[] => (
    regexRows(container)
      .map((row) => row.dataset.regexId)
      .filter((id): id is string => Boolean(id))
  )

  const announceRegexOrder = (message: string) => {
    const liveRegion = root.querySelector<HTMLElement>('[data-summaryplus-regex-status]')
    if (!liveRegion) return
    liveRegion.textContent = ''
    requestAnimationFrame(() => {
      liveRegion.textContent = message
    })
  }

  const saveRegexOrder = (container: HTMLElement) => {
    send({
      type: 'save_settings',
      settings: { regexOrder: regexOrderFromDom(container) },
    })
  }

  const clearRegexDragState = (item?: HTMLElement) => {
    document.body.classList.remove('summaryplus-regex-is-dragging')
    item
      ?.querySelector<HTMLElement>('.summaryplus-regex-drag')
      ?.setAttribute('aria-grabbed', 'false')
  }

  const mountRegexSortable = () => {
    const container = root.querySelector<HTMLElement>('[data-summaryplus-regex-list]')
    if (!container) return
    const rows = regexRows(container)

    for (const row of rows) {
      const handle = row.querySelector<HTMLButtonElement>('.summaryplus-regex-drag')
      if (!handle) continue
      handle.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        const currentRows = regexRows(container)
        const currentIndex = currentRows.indexOf(row)
        const nextIndex = event.key === 'ArrowUp' ? currentIndex - 1 : currentIndex + 1
        const name = row.dataset.regexName || 'Regex'
        if (nextIndex < 0 || nextIndex >= currentRows.length) {
          announceRegexOrder(`${name} is already at the ${event.key === 'ArrowUp' ? 'top' : 'bottom'}.`)
          return
        }
        if (event.key === 'ArrowUp') {
          container.insertBefore(row, currentRows[nextIndex])
        } else {
          container.insertBefore(row, currentRows[nextIndex].nextSibling)
        }
        handle.focus()
        saveRegexOrder(container)
        announceRegexOrder(`${name} moved to position ${nextIndex + 1} of ${currentRows.length}.`)
      })
    }

    if (rows.length < 2) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    regexSortable = Sortable.create(container, {
      draggable: '> .summaryplus-regex-row',
      handle: '.summaryplus-regex-drag',
      direction: 'vertical',
      animation: reducedMotion ? 0 : 170,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      delay: 200,
      delayOnTouchOnly: true,
      touchStartThreshold: 5,
      fallbackTolerance: 4,
      forceFallback: true,
      fallbackOnBody: true,
      scroll: true,
      bubbleScroll: false,
      scrollSensitivity: 24,
      scrollSpeed: 8,
      ghostClass: 'summaryplus-regex-ghost',
      chosenClass: 'summaryplus-regex-chosen',
      dragClass: 'summaryplus-regex-active',
      fallbackClass: 'summaryplus-regex-fallback',
      onStart: (event) => {
        document.body.classList.add('summaryplus-regex-is-dragging')
        event.item
          .querySelector<HTMLElement>('.summaryplus-regex-drag')
          ?.setAttribute('aria-grabbed', 'true')
      },
      onEnd: (event) => {
        clearRegexDragState(event.item)
        if (event.oldIndex === event.newIndex) return
        saveRegexOrder(container)
        const movedRow = event.item
        const movedRows = regexRows(container)
        const movedIndex = movedRows.indexOf(movedRow)
        const name = movedRow.dataset.regexName || 'Regex'
        announceRegexOrder(`${name} moved to position ${movedIndex + 1} of ${movedRows.length}.`)
      },
      onUnchoose: (event) => clearRegexDragState(event.item),
    })
  }

  const updateGenerationProgressDom = (progress: GenerationProgress): boolean => {
    const card = root.querySelector<HTMLElement>('[data-summaryplus-generation]')
    if (!card || card.dataset.summaryplusGeneration !== generationSignature(progress)) {
      return false
    }
    const title = card.querySelector<HTMLElement>('[data-summaryplus-generation-title]')
    const tokens = card.querySelector<HTMLElement>('[data-summaryplus-generation-tokens]')
    const retry = card.querySelector<HTMLElement>('[data-summaryplus-generation-retry]')
    if (!title || !tokens || !retry) return false
    title.textContent = generationTitle(progress)
    tokens.textContent = generationTokenText(progress)
    const retryText = generationRetryText(progress)
    retry.textContent = retryText
    retry.hidden = !retryText
    return true
  }

  const setScreen = (next: Screen, focusTab = false) => {
    screen = next
    render()
    if (focusTab) {
      queueMicrotask(() => root.querySelector<HTMLButtonElement>(`#summaryplus-tab-${next}`)?.focus())
    }
  }

  const syncDrafts = (next: Snapshot) => {
    if (draftChatId !== next.chatId) {
      entryDrafts.clear()
      regeneratingEntryId = null
      deletingEntryId = null
      draftChatId = next.chatId
    }
    if (!next.state) {
      entryDrafts.clear()
      regeneratingEntryId = null
      deletingEntryId = null
    } else {
      const activeById = new Map(activeEntries(next.state).map((entry) => [entry.id, entry]))
      for (const [entryId, draft] of entryDrafts) {
        const entry = activeById.get(entryId)
        if (!entry || entry.content === draft) entryDrafts.delete(entryId)
      }
      if (regeneratingEntryId && !next.processing) regeneratingEntryId = null
      if (deletingEntryId && !activeById.has(deletingEntryId)) deletingEntryId = null
    }
    for (const prompt of next.prompts) {
      if (!promptDrafts.has(prompt.id)) {
        promptDrafts.set(prompt.id, {
          name: prompt.name,
          systemPrompt: prompt.systemPrompt,
          userPrompt: prompt.userPrompt,
        })
      }
    }
    const currentPromptIds = new Set(next.prompts.map((prompt) => prompt.id))
    for (const key of promptDrafts.keys()) {
      if (!currentPromptIds.has(key)) promptDrafts.delete(key)
    }
  }

  const renderNav = (): HTMLElement => {
    const nav = element('nav', 'summaryplus-nav')
    const tabs: Array<{ id: Screen; label: string }> = [
      { id: 'summary', label: 'Summary' },
      { id: 'prompts', label: 'Prompt Library' },
      { id: 'settings', label: 'Settings' },
    ]
    nav.setAttribute('role', 'tablist')
    nav.setAttribute('aria-label', 'SummaryPlus sections')
    for (const tabDefinition of tabs) {
      const tabButton = element(
        'button',
        screen === tabDefinition.id ? 'is-active' : '',
        tabDefinition.label,
      )
      tabButton.type = 'button'
      tabButton.id = `summaryplus-tab-${tabDefinition.id}`
      tabButton.setAttribute('role', 'tab')
      tabButton.setAttribute('aria-controls', 'summaryplus-tabpanel')
      tabButton.setAttribute('aria-selected', String(screen === tabDefinition.id))
      tabButton.tabIndex = screen === tabDefinition.id ? 0 : -1
      tabButton.addEventListener('click', () => setScreen(tabDefinition.id))
      nav.appendChild(tabButton)
    }
    nav.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const currentIndex = tabs.findIndex((tabDefinition) => tabDefinition.id === screen)
      let nextIndex = currentIndex
      if (event.key === 'Home') nextIndex = 0
      if (event.key === 'End') nextIndex = tabs.length - 1
      if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
      if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length
      setScreen(tabs[nextIndex].id, true)
    })
    return nav
  }

  const renderSummary = (data: Snapshot): HTMLElement => {
    const content = element('main', 'summaryplus-content')
    content.id = 'summaryplus-tabpanel'
    content.setAttribute('role', 'tabpanel')
    content.setAttribute('aria-labelledby', 'summaryplus-tab-summary')
    const hero = element('div', 'summaryplus-hero')
    const intro = element('div')
    intro.append(
      element('div', 'summaryplus-eyebrow', 'Story memory'),
      element('h2', 'summaryplus-title', 'Active summary'),
    )
    hero.appendChild(intro)
    content.appendChild(hero)

    if (!data.chatId || !data.state) {
      const empty = element('div', 'summaryplus-empty')
      empty.append(
        element('strong', '', 'No chat is open'),
        element('div', 'summaryplus-help', 'Open a roleplay chat to view or create its summaries.'),
      )
      content.appendChild(empty)
      return content
    }

    if (data.processing) {
      const progress = data.generationProgress
      const generation = element('section', 'summaryplus-generation')
      generation.dataset.summaryplusGeneration = generationSignature(progress)
      generation.setAttribute('data-summaryplus-generation', '')
      generation.setAttribute('aria-live', 'polite')

      const status = element('div', 'summaryplus-generation-status')
      const indicator = element('span', 'summaryplus-generation-indicator')
      indicator.setAttribute('aria-hidden', 'true')
      const title = element('span', '', generationTitle(progress))
      title.setAttribute('data-summaryplus-generation-title', '')
      const dots = element('span', 'summaryplus-generation-dots')
      dots.setAttribute('aria-hidden', 'true')
      dots.append(
        element('span', '', '.'),
        element('span', '', '.'),
        element('span', '', '.'),
      )
      status.append(indicator, title, dots)

      const tokens = element('div', 'summaryplus-generation-tokens', generationTokenText(progress))
      tokens.setAttribute('data-summaryplus-generation-tokens', '')
      const retryText = generationRetryText(progress)
      const retry = element('div', 'summaryplus-generation-retry', retryText)
      retry.setAttribute('data-summaryplus-generation-retry', '')
      retry.hidden = !retryText

      generation.append(
        status,
        retry,
        tokens,
        button(
          'Cancel',
          () => send({ type: 'cancel_processing' }),
          'is-quiet summaryplus-generation-cancel',
        ),
      )
      content.appendChild(generation)
    }

    const stats = element('div', 'summaryplus-stats')
    const statData: Array<[string, number]> = [
      ['Pending', data.pendingMessageCount],
      ['Chapters', data.activeCounts.chapter],
      ['Arcs', data.activeCounts.arc],
      ['Volumes', data.activeCounts.volume],
    ]
    for (const [label, value] of statData) {
      const stat = element('div', 'summaryplus-stat')
      stat.append(element('strong', '', String(value)), element('span', '', label))
      stats.appendChild(stat)
    }
    content.appendChild(stats)

    if (data.state.branchMigration?.status === 'failed') {
      const error = element(
        'div',
        'summaryplus-banner is-error',
        `Branch memory synchronization failed. Automation and SummaryPlus macros are paused. ${data.state.branchMigration.error ?? ''}`.trim(),
      )
      const branchActions = element('div', 'summaryplus-actions')
      branchActions.append(
        button(
          'Retry branch sync',
          () => send({ type: 'retry_branch_migration' }),
          'is-quiet is-tint-primary',
          data.processing,
        ),
        button(
          'Reset branch memory',
          async () => {
            const result = await ctx.ui.showConfirm({
              title: 'Reset branch memory',
              message: 'Delete all SummaryPlus summaries and processing state from this branch only? The original chat will not be changed.',
              variant: 'danger',
              confirmLabel: 'Reset',
            })
            if (result.confirmed) send({ type: 'reset_branch_state' })
          },
          'is-quiet is-tint-danger',
          data.processing,
        ),
      )
      content.append(error, branchActions)
      return content
    }

    if (!data.state.historyApproved) {
      const warning = element('div', 'summaryplus-banner is-warning')
      warning.append(
        element('strong', '', 'Existing chat detected. '),
        document.createTextNode(
          'Automation is paused until you approve catch-up. The complete eligible history will be processed in chronological batches.',
        ),
      )
      const historyActions = element('div', 'summaryplus-actions')
      historyActions.appendChild(button(
        'Process history & enable',
        () => send({ type: 'process_history' }),
        'is-quiet is-tint-primary',
        data.processing,
      ))
      content.append(
        warning,
        historyActions,
      )
      return content
    }

    if (data.state.lastError) {
      const failedLevel = LEVEL_LABEL[data.state.lastError.level]
      const error = element(
        'div',
        'summaryplus-banner is-error',
        `${failedLevel} generation failed after all attempts: ${data.state.lastError.message}`,
      )
      content.appendChild(error)
    }

    const allEntries = activeEntries(data.state)
    const latestEntryId = allEntries[allEntries.length - 1]?.id
    const pendingEdits = allEntries.flatMap((entry) => {
      const content = entryDrafts.get(entry.id)
      return content !== undefined && content !== entry.content
        ? [{ id: entry.id, content }]
        : []
    })
    const hasPendingChanges = pendingEdits.length > 0

    const toolbar = element('div', 'summaryplus-toolbar is-split')
    const filters = element('div', 'summaryplus-toolbar')
    const filterOptions: Array<[SummaryFilter, string]> = [
      ['all', 'All'],
      ['volume', 'Volumes'],
      ['arc', 'Arcs'],
      ['chapter', 'Chapters'],
    ]
    for (const [value, label] of filterOptions) {
      const pill = element('button', `summaryplus-pill ${filter === value ? 'is-active' : ''}`, label)
      pill.type = 'button'
      pill.addEventListener('click', () => {
        filter = value
        render()
      })
      filters.appendChild(pill)
    }
    const toolbarActions = element('div', 'summaryplus-toolbar-actions')
    const flushButton = button(
      'Flush changes',
      () => {
        entryDrafts.clear()
        render()
      },
      'is-quiet is-tint-danger',
      data.processing
        || editingEntryId !== null
        || regeneratingEntryId !== null
        || deletingEntryId !== null
        || !hasPendingChanges,
    )
    const saveButton = button(
      'Save changes',
      () => send({ type: 'save_entries', entries: pendingEdits }),
      'is-quiet is-tint-success',
      data.processing
        || editingEntryId !== null
        || regeneratingEntryId !== null
        || deletingEntryId !== null
        || !hasPendingChanges,
    )
    const processButton = button(
      data.processing ? 'Processing…' : 'Process now',
      () => send({ type: 'process_now' }),
      'is-quiet',
      data.processing
        || editingEntryId !== null
        || regeneratingEntryId !== null
        || deletingEntryId !== null
        || hasPendingChanges,
    )
    toolbarActions.append(flushButton, saveButton, processButton)
    toolbar.append(filters, toolbarActions)
    content.appendChild(toolbar)

    const entries = activeEntries(
      data.state,
      filter === 'all' ? undefined : filter,
    )
    if (!entries.length) {
      const empty = element('div', 'summaryplus-empty')
      empty.append(
        element('strong', '', filter === 'all' ? 'No active summaries yet' : `No active ${filter} summaries`),
        element(
          'div',
          'summaryplus-help',
          'SummaryPlus will create one when enough source items and delay items are available.',
        ),
      )
      content.appendChild(empty)
    } else {
      const stack = element('div', 'summaryplus-stack')
      for (const entry of entries) {
        const title = entryDisplayTitle(entry)
        const draft = entryDrafts.get(entry.id)
        const hasPendingChange = draft !== undefined && draft !== entry.content
        const controlsDisabled = data.processing
          || editingEntryId !== null
          || regeneratingEntryId !== null
          || deletingEntryId !== null
        const card = element(
          'div',
          [
            'summaryplus-entry',
            hasPendingChange ? 'has-pending-change' : '',
            controlsDisabled ? 'is-disabled' : '',
          ].filter(Boolean).join(' '),
        )
        const openEditor = () => {
          editingEntryId = entry.id
          render()
          ctx.sendToBackend({
            type: 'edit_entry',
            entryId: entry.id,
            value: draft ?? entry.content,
          })
        }

        const openButton = element('button', 'summaryplus-entry-open')
        openButton.type = 'button'
        openButton.disabled = controlsDisabled
        openButton.setAttribute('aria-label', `Edit ${title} in expanded editor`)
        openButton.appendChild(element('span', 'summaryplus-entry-label', title))
        openButton.addEventListener('click', openEditor)

        const actions = element('div', 'summaryplus-entry-actions')
        if (entry.id === latestEntryId) {
          const regenerateButton = element('button', 'summaryplus-entry-action is-regenerate')
          regenerateButton.type = 'button'
          regenerateButton.disabled = controlsDisabled
          regenerateButton.title = `Regenerate ${title}`
          regenerateButton.setAttribute('aria-label', `Regenerate ${title}`)
          const regenerateIcon = element('span', 'summaryplus-entry-icon')
          regenerateIcon.innerHTML = REGENERATE_ICON
          regenerateButton.appendChild(regenerateIcon)
          regenerateButton.addEventListener('click', async () => {
            regeneratingEntryId = entry.id
            render()
            let result: Awaited<ReturnType<typeof ctx.ui.showConfirm>>
            try {
              result = await ctx.ui.showConfirm({
                title: `Regenerate ${LEVEL_LABEL[entry.level]}`,
                message: regenerateEntryMessage(entry),
                variant: 'info',
                confirmLabel: 'Regenerate',
              })
            } catch {
              regeneratingEntryId = null
              render()
              return
            }
            if (!result.confirmed) {
              regeneratingEntryId = null
              render()
              return
            }
            entryDrafts.delete(entry.id)
            send({ type: 'regenerate_entry', entryId: entry.id })
          })
          actions.appendChild(regenerateButton)

          const deleteButton = element('button', 'summaryplus-entry-action is-delete')
          deleteButton.type = 'button'
          deleteButton.disabled = controlsDisabled
          deleteButton.title = `Delete ${title}`
          deleteButton.setAttribute('aria-label', `Delete ${title}`)
          const deleteIcon = element('span', 'summaryplus-entry-icon')
          deleteIcon.innerHTML = DELETE_ICON
          deleteButton.appendChild(deleteIcon)
          deleteButton.addEventListener('click', async () => {
            deletingEntryId = entry.id
            render()
            let result: Awaited<ReturnType<typeof ctx.ui.showConfirm>>
            try {
              result = await ctx.ui.showConfirm({
                title: `Delete ${LEVEL_LABEL[entry.level]}`,
                message: deleteEntryMessage(entry),
                variant: 'danger',
                confirmLabel: 'Delete',
              })
            } catch {
              deletingEntryId = null
              render()
              return
            }
            if (!result.confirmed) {
              deletingEntryId = null
              render()
              return
            }
            entryDrafts.delete(entry.id)
            send({ type: 'delete_entry', entryId: entry.id })
          })
          actions.appendChild(deleteButton)
        }

        const expandButton = element('button', 'summaryplus-entry-action')
        expandButton.type = 'button'
        expandButton.disabled = controlsDisabled
        expandButton.title = `Edit ${title}`
        expandButton.setAttribute('aria-label', `Edit ${title} in expanded editor`)
        const expandIcon = element('span', 'summaryplus-entry-icon')
        expandIcon.innerHTML = EXPAND_ICON
        expandButton.appendChild(expandIcon)
        expandButton.addEventListener('click', openEditor)

        actions.appendChild(expandButton)
        card.append(openButton, actions)
        stack.appendChild(card)
      }
      content.appendChild(stack)
    }

    return content
  }

  const renderPrompts = (data: Snapshot): HTMLElement => {
    const content = element('main', 'summaryplus-content')
    content.id = 'summaryplus-tabpanel'
    content.setAttribute('role', 'tabpanel')
    content.setAttribute('aria-labelledby', 'summaryplus-tab-prompts')
    const intro = element('div')
    intro.append(
      element('div', 'summaryplus-eyebrow', 'Generation instructions'),
      element('h2', 'summaryplus-title', 'Prompt Library'),
    )
    content.appendChild(intro)

    const settings = data.settings
    const promptSection = element('section', 'summaryplus-section')

    const levelToolbar = element('div', 'summaryplus-toolbar')
    for (const level of LEVELS) {
      const levelButton = element(
        'button',
        `summaryplus-pill ${promptLevel === level ? 'is-active' : ''}`,
        LEVEL_LABEL[level],
      )
      levelButton.type = 'button'
      levelButton.addEventListener('click', () => {
        promptLevel = level
        render()
      })
      levelToolbar.appendChild(levelButton)
    }
    promptSection.appendChild(levelToolbar)

    const promptsForLevel = data.prompts.filter((prompt) => prompt.level === promptLevel)
    const activePromptId = settings.activePromptIds[promptLevel]
    const selected = promptsForLevel.find((prompt) => prompt.id === activePromptId) ?? promptsForLevel[0]
    if (selected) {
      const promptHead = element('div', 'summaryplus-prompt-head')
      const promptSelect = element('select', 'summaryplus-select')
      for (const prompt of promptsForLevel) {
        const option = element('option', '', prompt.name)
        option.value = prompt.id
        promptSelect.appendChild(option)
      }
      promptSelect.value = selected.id
      promptSelect.addEventListener('change', () => {
        send({
          type: 'select_prompt',
          level: promptLevel,
          promptId: promptSelect.value,
        })
      })
      promptHead.append(
        promptSelect,
        button(
          'New',
          () => send({ type: 'new_prompt', level: promptLevel }),
          'is-quiet',
        ),
        button(
          'Duplicate',
          () => send({ type: 'duplicate_prompt', promptId: selected.id }),
          'is-quiet',
        ),
      )
      if (!selected.builtIn) {
        promptHead.appendChild(button(
          'Delete',
          async () => {
            const result = await ctx.ui.showConfirm({
              title: 'Delete prompt',
              message: `Delete “${selected.name}”? This cannot be undone.`,
              variant: 'danger',
              confirmLabel: 'Delete',
            })
            if (result.confirmed) {
              promptDrafts.delete(selected.id)
              send({ type: 'delete_prompt', promptId: selected.id })
            }
          },
          'is-quiet is-danger',
        ))
      }
      promptSection.appendChild(promptHead)

      if (selected.builtIn) {
        promptSection.appendChild(
          element('span', 'summaryplus-builtin', 'Protected default. Duplicate to edit'),
        )
      }

      const draft = promptDrafts.get(selected.id) ?? {
        name: selected.name,
        systemPrompt: selected.systemPrompt,
        userPrompt: selected.userPrompt,
      }
      const nameField = element('label', 'summaryplus-field')
      nameField.appendChild(element('span', 'summaryplus-label', 'Name'))
      const promptName = element('input', 'summaryplus-input')
      promptName.value = draft.name
      promptName.readOnly = selected.builtIn
      nameField.appendChild(promptName)

      const systemField = element('label', 'summaryplus-field')
      systemField.appendChild(element('span', 'summaryplus-label', 'System prompt'))
      const systemPrompt = element('textarea', 'summaryplus-textarea')
      systemPrompt.value = draft.systemPrompt
      systemPrompt.readOnly = selected.builtIn
      systemPrompt.rows = 8
      systemField.appendChild(systemPrompt)

      const userField = element('label', 'summaryplus-field')
      userField.appendChild(element('span', 'summaryplus-label', 'User prompt'))
      const userPrompt = element('textarea', 'summaryplus-textarea')
      userPrompt.value = draft.userPrompt
      userPrompt.readOnly = selected.builtIn
      userPrompt.rows = 5
      userField.appendChild(userPrompt)

      const updatePromptDraft = () => {
        promptDrafts.set(selected.id, {
          name: promptName.value,
          systemPrompt: systemPrompt.value,
          userPrompt: userPrompt.value,
        })
        if (savePromptButton) {
          savePromptButton.disabled = !hasPromptChanges()
        }
      }
      const hasPromptChanges = () => (
        promptName.value.trim() !== selected.name
        || systemPrompt.value !== selected.systemPrompt
        || userPrompt.value !== selected.userPrompt
      )
      let savePromptButton: HTMLButtonElement | null = null
      promptName.addEventListener('input', updatePromptDraft)
      systemPrompt.addEventListener('input', updatePromptDraft)
      userPrompt.addEventListener('input', updatePromptDraft)
      promptSection.append(nameField, systemField, userField)

      if (!selected.builtIn) {
        savePromptButton = button('Save prompt', () => {
          updatePromptDraft()
          send({
            type: 'save_prompt',
            prompt: {
              id: selected.id,
              name: promptName.value,
              systemPrompt: systemPrompt.value,
              userPrompt: userPrompt.value,
            },
          })
        }, 'is-quiet is-tint-primary', !hasPromptChanges())
        promptSection.appendChild(savePromptButton)
      }
    }

    content.appendChild(promptSection)
    return content
  }

  const renderSettings = (data: Snapshot): HTMLElement => {
    const content = element('main', 'summaryplus-content')
    content.id = 'summaryplus-tabpanel'
    content.setAttribute('role', 'tabpanel')
    content.setAttribute('aria-labelledby', 'summaryplus-tab-settings')
    const intro = element('div')
    intro.append(
      element('div', 'summaryplus-eyebrow', 'Configuration'),
      element('h2', 'summaryplus-title', 'Summary engine'),
    )
    content.appendChild(intro)

    const settings = data.settings
    const defaults = createDefaultSettings()
    const automationSection = element('section', 'summaryplus-section')
    const automationRow = element('label', 'summaryplus-switch')
    const automationText = element('div')
    automationText.append(
      element('div', 'summaryplus-label', 'Automatic processing'),
    )
    const automation = element('input')
    automation.type = 'checkbox'
    automation.checked = settings.automationEnabled
    automationRow.append(automationText, automation)
    automationSection.appendChild(automationRow)

    const batchingSection = element('section', 'summaryplus-section')
    batchingSection.appendChild(element('h3', 'summaryplus-section-title', 'Promotion'))
    const batchingGrid = element('div', 'summaryplus-grid')
    const messagesPerChapter = numberField(
      'Messages per Chapter',
      settings.messagesPerChapter,
      { min: 1, step: 1, defaultValue: defaults.messagesPerChapter },
    )
    const messageDelay = numberField(
      'Message delay',
      settings.messageDelay,
      { min: 0, step: 1, defaultValue: defaults.messageDelay },
    )
    const chaptersPerArc = numberField(
      'Chapters per Arc',
      settings.chaptersPerArc,
      { min: 1, step: 1, defaultValue: defaults.chaptersPerArc },
    )
    const chapterDelay = numberField(
      'Chapter delay',
      settings.chapterDelay,
      { min: 0, step: 1, defaultValue: defaults.chapterDelay },
    )
    const arcsPerVolume = numberField(
      'Arcs per Volume',
      settings.arcsPerVolume,
      { min: 1, step: 1, defaultValue: defaults.arcsPerVolume },
    )
    const arcDelay = numberField(
      'Arc delay',
      settings.arcDelay,
      { min: 0, step: 1, defaultValue: defaults.arcDelay },
    )
    batchingGrid.append(
      messagesPerChapter.field,
      messageDelay.field,
      chaptersPerArc.field,
      chapterDelay.field,
      arcsPerVolume.field,
      arcDelay.field,
    )
    batchingSection.appendChild(batchingGrid)

    const trimmingSection = element('section', 'summaryplus-section')
    trimmingSection.appendChild(element('h3', 'summaryplus-section-title', 'Trimming'))
    const trimmingRow = element('div', 'summaryplus-switch')
    trimmingRow.appendChild(element('div', 'summaryplus-label', 'Hide summarized messages'))
    const trimmingToggle = element(
      'label',
      'summaryplus-regex-toggle summaryplus-settings-toggle',
    )
    const hideSummarizedMessages = element('input')
    hideSummarizedMessages.type = 'checkbox'
    hideSummarizedMessages.checked = settings.hideSummarizedMessages
    hideSummarizedMessages.setAttribute('aria-label', 'Hide summarized messages')
    const trimmingSwitch = element('span', 'summaryplus-regex-switch')
    trimmingSwitch.setAttribute('aria-hidden', 'true')
    trimmingToggle.append(hideSummarizedMessages, trimmingSwitch)
    trimmingRow.appendChild(trimmingToggle)
    const hideDelayChapters = numberField(
      'Hide delay (Chapters)',
      settings.hideDelayChapters,
      { min: 0, step: 1, defaultValue: defaults.hideDelayChapters },
    )
    const ownedHiddenMessageCount = new Set(
      data.state?.entries.flatMap((entry) => entry.autoHiddenSourceIds ?? []) ?? [],
    ).size
    const unhideButton = button(
      'Unhide SummaryPlus messages',
      () => send({ type: 'unhide_summaryplus_messages' }),
      'is-quiet is-tint-primary',
      ownedHiddenMessageCount === 0 || data.processing,
    )
    unhideButton.classList.add('summaryplus-trimming-action')
    trimmingSection.append(trimmingRow, hideDelayChapters.field, unhideButton)

    const modelSection = element('section', 'summaryplus-section')
    modelSection.appendChild(element('h3', 'summaryplus-section-title', 'Generation'))
    const modelGrid = element('div', 'summaryplus-grid')
    const connectionField = element('label', 'summaryplus-field is-wide')
    connectionField.appendChild(element('span', 'summaryplus-label', 'Connection'))
    const connection = element('select', 'summaryplus-select')
    const defaultOption = element('option', '', 'Default Lumiverse connection')
    defaultOption.value = ''
    connection.appendChild(defaultOption)
    let selectedConnectionExists = settings.connectionId === null
    for (const item of data.connections) {
      const details = [item.provider, item.model].filter(Boolean).join(' · ')
      const option = element('option', '', details ? `${item.name} — ${details}` : item.name)
      option.value = item.id
      if (item.id === settings.connectionId) selectedConnectionExists = true
      connection.appendChild(option)
    }
    if (settings.connectionId && !selectedConnectionExists) {
      const unavailable = element('option', '', 'Previously selected connection (unavailable)')
      unavailable.value = settings.connectionId
      connection.appendChild(unavailable)
    }
    connection.value = settings.connectionId ?? ''
    connectionField.appendChild(connection)
    const temperature = numberField(
      'Temperature',
      settings.temperature,
      { min: 0, step: 0.1, defaultValue: defaults.temperature },
    )
    const topP = numberField(
      'Top P',
      settings.topP,
      { min: 0, step: 0.05, defaultValue: defaults.topP },
    )
    topP.input.max = '1'
    const maxTokens = numberField(
      'Maximum response tokens',
      settings.maxTokens,
      { min: 1, step: 1, defaultValue: defaults.maxTokens },
    )
    const retries = numberField(
      'Retries',
      settings.retries,
      { min: 0, step: 1, defaultValue: defaults.retries },
    )
    modelGrid.append(
      connectionField,
      temperature.field,
      topP.field,
      maxTokens.field,
      retries.field,
    )
    modelSection.appendChild(modelGrid)

    const regexSection = element('section', 'summaryplus-section')
    regexSection.appendChild(element('h3', 'summaryplus-section-title', 'Regex preprocessing'))
    if (data.regexScripts.length === 0) {
      regexSection.appendChild(element('div', 'summaryplus-help', 'No prompt regex found.'))
    } else {
      const enabledRegexIds = new Set(settings.regexEnabledIds)
      const regexList = element('div', 'summaryplus-regex-list')
      regexList.dataset.summaryplusRegexList = ''
      for (const script of data.regexScripts) {
        const row = element('div', 'summaryplus-regex-row')
        row.dataset.regexId = script.id
        row.dataset.regexName = script.name

        const dragHandle = element('button', 'summaryplus-regex-drag')
        dragHandle.type = 'button'
        dragHandle.innerHTML = DRAG_ICON
        dragHandle.setAttribute('aria-label', `Reorder ${script.name}. Use the arrow keys or drag.`)
        dragHandle.setAttribute('aria-grabbed', 'false')

        const name = element('span', 'summaryplus-regex-name', script.name)
        name.title = script.name

        const toggle = element('label', 'summaryplus-regex-toggle')
        const checkbox = element('input')
        checkbox.type = 'checkbox'
        checkbox.checked = enabledRegexIds.has(script.id)
        checkbox.setAttribute('aria-label', `Use ${script.name}`)
        const switchControl = element('span', 'summaryplus-regex-switch')
        switchControl.setAttribute('aria-hidden', 'true')
        checkbox.addEventListener('change', () => {
          const nextEnabledIds = checkbox.checked
            ? [...settings.regexEnabledIds.filter((id) => id !== script.id), script.id]
            : settings.regexEnabledIds.filter((id) => id !== script.id)
          send({
            type: 'save_settings',
            settings: { regexEnabledIds: nextEnabledIds },
          })
        })
        toggle.append(checkbox, switchControl)
        row.append(dragHandle, name, toggle)
        regexList.appendChild(row)
      }
      const liveRegion = element('div', 'summaryplus-sr-only')
      liveRegion.dataset.summaryplusRegexStatus = ''
      liveRegion.setAttribute('role', 'status')
      liveRegion.setAttribute('aria-live', 'polite')
      regexSection.append(regexList, liveRegion)
    }

    const readNumber = (input: HTMLInputElement, fallback: number) => (
      Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : fallback
    )
    const applySettings = () => {
      send({
        type: 'save_settings',
        settings: {
          automationEnabled: automation.checked,
          messagesPerChapter: readNumber(messagesPerChapter.input, defaults.messagesPerChapter),
          messageDelay: readNumber(messageDelay.input, defaults.messageDelay),
          chaptersPerArc: readNumber(chaptersPerArc.input, defaults.chaptersPerArc),
          chapterDelay: readNumber(chapterDelay.input, defaults.chapterDelay),
          arcsPerVolume: readNumber(arcsPerVolume.input, defaults.arcsPerVolume),
          arcDelay: readNumber(arcDelay.input, defaults.arcDelay),
          hideSummarizedMessages: hideSummarizedMessages.checked,
          hideDelayChapters: readNumber(
            hideDelayChapters.input,
            defaults.hideDelayChapters,
          ),
          retries: readNumber(retries.input, defaults.retries),
          connectionId: connection.value || null,
          temperature: readNumber(temperature.input, defaults.temperature),
          topP: readNumber(topP.input, defaults.topP),
          maxTokens: readNumber(maxTokens.input, defaults.maxTokens),
        },
      })
    }
    const settingsControls: Array<HTMLInputElement | HTMLSelectElement> = [
      automation,
      messagesPerChapter.input,
      messageDelay.input,
      chaptersPerArc.input,
      chapterDelay.input,
      arcsPerVolume.input,
      arcDelay.input,
      hideSummarizedMessages,
      hideDelayChapters.input,
      connection,
      temperature.input,
      topP.input,
      maxTokens.input,
      retries.input,
    ]
    for (const control of settingsControls) {
      control.addEventListener('change', applySettings)
    }

    content.append(
      automationSection,
      modelSection,
      batchingSection,
      trimmingSection,
      regexSection,
    )
    return content
  }

  function render(): void {
    destroyRegexSortable()
    const shell = element('div', 'summaryplus-shell')
    shell.appendChild(renderNav())
    if (!snapshot) {
      const loading = element('div', 'summaryplus-loading')
      loading.append(element('span', 'summaryplus-dot'), document.createTextNode('Loading SummaryPlus…'))
      shell.appendChild(loading)
    } else {
      const content = screen === 'summary'
        ? renderSummary(snapshot)
        : screen === 'prompts'
          ? renderPrompts(snapshot)
          : renderSettings(snapshot)
      shell.appendChild(content)
    }
    root.replaceChildren(shell)
    if (snapshot && screen === 'settings') mountRegexSortable()
  }

  const unsubscribeBackend = ctx.onBackendMessage((payload) => {
    if (!isBackendMessage(payload)) return
    if (payload.type === 'action_error') {
      editingEntryId = null
      regeneratingEntryId = null
      deletingEntryId = null
      render()
      return
    }
    if (payload.type === 'entry_editor_closed') {
      if (editingEntryId === payload.entryId) editingEntryId = null
      if (!payload.cancelled && snapshot?.chatId === payload.chatId && snapshot.state) {
        const entry = activeEntries(snapshot.state).find((candidate) => candidate.id === payload.entryId)
        if (entry) {
          if (entry.content === payload.text) entryDrafts.delete(entry.id)
          else entryDrafts.set(entry.id, payload.text)
        }
      }
      render()
      return
    }
    if (payload.type === 'generation_progress') {
      if (!snapshot || snapshot.chatId !== payload.chatId) return
      snapshot = {
        ...snapshot,
        processing: true,
        generationProgress: payload.progress,
      }
      if (!updateGenerationProgressDom(payload.progress)) render()
      return
    }
    syncDrafts(payload.snapshot)
    snapshot = payload.snapshot
    render()
  })

  const unsubscribeActivate = tab.onActivate(() => send({ type: 'request_snapshot' }))
  const unsubscribeChatSwitch = ctx.events.on('CHAT_SWITCHED', () => {
    editingEntryId = null
    regeneratingEntryId = null
    deletingEntryId = null
    entryDrafts.clear()
    draftChatId = null
    send({ type: 'request_snapshot' })
  })

  render()
  ctx.ready()
  send({ type: 'request_snapshot' })

  return () => {
    destroyRegexSortable()
    unsubscribeChatSwitch()
    unsubscribeActivate()
    unsubscribeBackend()
    tab.destroy()
    removeStyle()
    ctx.dom.cleanup()
  }
}

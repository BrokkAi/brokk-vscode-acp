import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_IMAGE_TOTAL_BYTES,
  PROMPT_IMAGE_MIME_TYPES,
} from "./images";

export function webviewHtml(webview: vscode.Webview): string {
  const nonce = randomBytes(18).toString("base64");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --border: color-mix(in srgb, var(--vscode-foreground) 13%, transparent);
      --muted-border: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
      --surface: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground));
      --surface-raised: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      --accent-soft: color-mix(in srgb, var(--vscode-focusBorder) 13%, transparent);
    }
    * { box-sizing: border-box; }
    .visually-hidden {
      position: absolute !important;
      width: 1px !important;
      height: 1px !important;
      padding: 0 !important;
      margin: -1px !important;
      overflow: hidden !important;
      clip: rect(0, 0, 0, 0) !important;
      white-space: nowrap !important;
      border: 0 !important;
    }
    html, body { width: 100%; height: 100%; }
    body {
      margin: 0;
      overflow: hidden;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      font: 13px/1.48 var(--vscode-font-family);
    }
    button, select, textarea, input { font: inherit; }
    button {
      border: 0;
      color: inherit;
      cursor: pointer;
    }
    button:disabled { cursor: default; opacity: .45; }
    .icon-button {
      width: 30px;
      height: 30px;
      display: inline-grid;
      place-items: center;
      flex: none;
      border-radius: 5px;
      background: transparent;
      font-size: 17px;
    }
    .icon-button:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground, var(--accent-soft));
    }
    .primary {
      min-height: 34px;
      padding: 7px 13px;
      border-radius: 5px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font-weight: 600;
    }
    .primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .secondary {
      min-height: 32px;
      padding: 6px 11px;
      border-radius: 5px;
      color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground);
    }
    .secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    .app {
      position: relative;
      display: grid;
      grid-template-rows: 46px minmax(0, 1fr);
      width: 100%;
      height: 100%;
    }
    .topbar {
      z-index: 5;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 7px 8px;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border-bottom: 1px solid var(--muted-border);
    }
    .brand {
      min-width: 0;
      flex: 1;
    }
    .brand-title {
      overflow: hidden;
      font-size: 12.5px;
      font-weight: 650;
      line-height: 1.2;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .brand-meta {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      margin-top: 2px;
      color: var(--vscode-descriptionForeground);
      font-size: 10.5px;
      line-height: 1.1;
    }
    .brand-meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status-dot {
      width: 6px;
      height: 6px;
      flex: none;
      border-radius: 50%;
      background: var(--vscode-descriptionForeground);
    }
    .status-dot.ready { background: var(--vscode-testing-iconPassed, #37a76f); }
    .status-dot.running, .status-dot.connecting {
      background: var(--vscode-progressBar-background, #3b8eea);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-progressBar-background, #3b8eea) 18%, transparent);
    }
    .status-dot.error { background: var(--vscode-errorForeground); }
    .main {
      position: relative;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }
    .empty {
      height: 100%;
      overflow: auto;
      padding: clamp(18px, 8vh, 52px) 16px 24px;
    }
    .start-card {
      width: min(100%, 360px);
      margin: 0 auto;
    }
    .mark {
      width: 38px;
      height: 38px;
      display: grid;
      place-items: center;
      margin-bottom: 17px;
      border: 1px solid var(--border);
      border-radius: 9px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font-size: 18px;
      font-weight: 800;
    }
    h1 {
      margin: 0 0 5px;
      font-size: 19px;
      font-weight: 650;
      letter-spacing: -.2px;
    }
    .lede {
      margin: 0 0 24px;
      color: var(--vscode-descriptionForeground);
      font-size: 12.5px;
    }
    .field-label {
      display: block;
      margin-bottom: 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .35px;
      text-transform: uppercase;
    }
    select {
      width: 100%;
      min-height: 34px;
      padding: 5px 28px 5px 8px;
      border: 1px solid var(--vscode-dropdown-border, var(--border));
      border-radius: 4px;
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      outline: none;
    }
    select:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
    .agent-description {
      min-height: 36px;
      margin: 8px 1px 13px;
      color: var(--vscode-descriptionForeground);
      font-size: 11.5px;
    }
    .start-actions { display: flex; gap: 7px; }
    .start-actions .primary { flex: 1; }
    .install-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 28px;
      margin-top: 9px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .text-button {
      padding: 2px 0;
      color: var(--vscode-textLink-foreground);
      background: transparent;
    }
    .text-button:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    .session-view {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      width: 100%;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }
    .session-toolbar {
      flex: none;
      min-height: 34px;
      display: flex;
      align-items: center;
      gap: 7px;
      width: 100%;
      padding: 5px 11px;
      overflow: hidden;
      border-bottom: 1px solid var(--muted-border);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    .config-context {
      flex: none;
      color: var(--vscode-descriptionForeground);
      font-size: 10.5px;
      font-weight: 600;
      white-space: nowrap;
    }
    .config-summary {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      color: var(--vscode-foreground);
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .config-link {
      flex: none;
      padding: 2px 0;
      color: var(--vscode-textLink-foreground);
      background: transparent;
      font-size: 11px;
      white-space: nowrap;
    }
    .config-link:hover {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
    }
    .config-panel {
      flex: none;
      max-height: min(55vh, 420px);
      padding: 12px;
      overflow-x: hidden;
      overflow-y: auto;
      border-bottom: 1px solid var(--border);
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      box-shadow: 0 7px 18px color-mix(in srgb, #000 18%, transparent);
    }
    .config-panel-heading {
      margin-bottom: 10px;
    }
    .config-panel-title {
      font-size: 12.5px;
      font-weight: 650;
    }
    .config-panel-description {
      margin-top: 2px;
      color: var(--vscode-descriptionForeground);
      font-size: 10.5px;
    }
    .config-editor {
      display: grid;
      gap: 9px;
    }
    .config-field,
    .config-switch {
      display: grid;
      grid-template-columns: minmax(96px, .75fr) minmax(0, 1.25fr);
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .config-field-name {
      min-width: 0;
      overflow: hidden;
      font-size: 11px;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .config-field select {
      min-width: 0;
      min-height: 30px;
      height: 30px;
    }
    .config-switch-control {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      font-size: 11px;
    }
    .config-switch-control input {
      width: 14px;
      height: 14px;
      margin: 0;
      accent-color: var(--vscode-button-background);
    }
    .transcript {
      flex: 1 1 0;
      width: 100%;
      min-width: 0;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 17px 12px 24px;
      scroll-behavior: smooth;
    }
    .transcript-inner {
      width: 100%;
      max-width: 720px;
      min-width: 0;
      margin: 0 auto;
    }
    .welcome {
      padding: clamp(24px, 10vh, 68px) 8px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
    .welcome-title {
      margin-bottom: 6px;
      color: var(--vscode-foreground);
      font-size: 15px;
      font-weight: 600;
    }
    .connection-stage {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 440px;
      padding: 7px 10px;
      border: 1px solid var(--muted-border);
      border-radius: 6px;
      background: var(--surface);
      text-align: left;
    }
    .connection-spinner {
      width: 12px;
      height: 12px;
      flex: none;
      border: 2px solid color-mix(in srgb, var(--vscode-progressBar-background, #3b8eea) 24%, transparent);
      border-top-color: var(--vscode-progressBar-background, #3b8eea);
      border-radius: 50%;
      animation: spin .8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .connection-spinner { animation: none; }
    }
    .entry { max-width: 100%; margin: 0 0 17px; overflow-wrap: anywhere; }
    .entry.user { display: flex; justify-content: flex-end; }
    .user-bubble {
      max-width: min(88%, 560px);
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 10px 10px 3px 10px;
      background: var(--vscode-input-background);
      white-space: pre-wrap;
    }
    .user-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-bottom: 6px;
    }
    .user-attachments:last-child { margin-bottom: 0; }
    .user-attachment {
      max-width: 100%;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 6px;
      border: 1px solid var(--muted-border);
      border-radius: 5px;
      color: var(--vscode-descriptionForeground);
      background: var(--surface);
      font-size: 10.5px;
    }
    .user-attachment span:last-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .assistant-body { font-size: 13px; }
    .assistant-body p { margin: 0 0 10px; }
    .assistant-body p:last-child { margin-bottom: 0; }
    .assistant-body h2, .assistant-body h3 {
      margin: 15px 0 7px;
      font-size: 13px;
      font-weight: 650;
    }
    .assistant-body ul, .assistant-body ol { margin: 7px 0; padding-left: 20px; }
    .assistant-body li { margin: 3px 0; }
    .assistant-body pre {
      position: relative;
      margin: 9px 0;
      padding: 9px 10px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--vscode-textCodeBlock-background);
      font: 11.5px/1.5 var(--vscode-editor-font-family, monospace);
      white-space: pre;
    }
    .assistant-body code {
      padding: 1px 3px;
      border-radius: 3px;
      background: var(--vscode-textCodeBlock-background);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: .94em;
    }
    .assistant-body pre code { padding: 0; background: transparent; }
    .streaming-caret::after {
      content: "";
      display: inline-block;
      width: 6px;
      height: 13px;
      margin-left: 2px;
      vertical-align: -2px;
      background: var(--vscode-editorCursor-foreground);
      animation: blink 1s steps(2) infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }
    .thought {
      margin: -6px 0 13px;
      color: var(--vscode-descriptionForeground);
      font-size: 11.5px;
    }
    .thought summary { cursor: pointer; user-select: none; }
    .thought-content {
      margin: 6px 0 0 10px;
      padding-left: 9px;
      border-left: 2px solid var(--border);
      white-space: pre-wrap;
    }
    .tool {
      margin: 7px 0 10px;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
    }
    .tool summary {
      display: flex;
      align-items: center;
      gap: 7px;
      min-height: 34px;
      padding: 6px 8px;
      cursor: pointer;
      list-style: none;
    }
    .tool summary::-webkit-details-marker { display: none; }
    .tool-icon {
      width: 20px;
      height: 20px;
      display: grid;
      place-items: center;
      flex: none;
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      font-size: 11px;
    }
    .tool-title {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      font-size: 11.5px;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tool-status {
      flex: none;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      text-transform: capitalize;
    }
    .tool-status.completed { color: var(--vscode-testing-iconPassed, #37a76f); }
    .tool-status.failed { color: var(--vscode-errorForeground); }
    .tool-body {
      padding: 8px 9px 9px 35px;
      border-top: 1px solid var(--muted-border);
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .tool-body pre {
      max-height: 220px;
      margin: 6px 0 0;
      overflow: auto;
      color: var(--vscode-foreground);
      font: 10.5px/1.45 var(--vscode-editor-font-family, monospace);
      white-space: pre-wrap;
    }
    .location { margin: 2px 0; color: var(--vscode-textLink-foreground); }
    .plan-dock {
      flex: none;
      min-width: 0;
      padding: 7px 10px 0;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    .plan-shell {
      max-width: 720px;
      margin: 0 auto;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--surface);
    }
    .plan-header {
      width: 100%;
      min-height: 32px;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 5px 8px;
      background: transparent;
      text-align: left;
    }
    .plan-header:hover { background: var(--vscode-toolbar-hoverBackground, var(--accent-soft)); }
    .plan-header:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .plan-chevron {
      width: 10px;
      flex: none;
      color: var(--vscode-descriptionForeground);
      font-size: 9px;
      transform: rotate(90deg);
      transition: transform 120ms ease;
    }
    .plan-shell.collapsed .plan-chevron { transform: none; }
    .plan-heading {
      min-width: 0;
      flex: 1;
      font-size: 11.5px;
      font-weight: 650;
    }
    .plan-summary {
      flex: none;
      color: var(--vscode-descriptionForeground);
      font-size: 10.5px;
    }
    .plan-body {
      max-height: min(220px, 34vh);
      overflow-x: hidden;
      overflow-y: auto;
      padding: 3px 0;
      border-top: 1px solid var(--muted-border);
    }
    .plan-row {
      display: grid;
      grid-template-columns: 16px minmax(0, 1fr) auto;
      align-items: start;
      gap: 6px;
      padding: 5px 8px;
      font-size: 11.5px;
    }
    .plan-row + .plan-row { border-top: 1px solid var(--muted-border); }
    .plan-row.in_progress {
      background: var(--accent-soft);
      box-shadow: inset 2px 0 var(--vscode-focusBorder);
    }
    .plan-row.completed { color: var(--vscode-descriptionForeground); }
    .plan-marker {
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
    .plan-row.in_progress .plan-marker { color: var(--vscode-focusBorder); }
    .plan-row.completed .plan-marker {
      color: var(--vscode-testing-iconPassed, #37a76f);
    }
    .plan-copy { min-width: 0; overflow-wrap: anywhere; }
    .plan-priority {
      margin-top: 1px;
      padding: 0 4px;
      border: 1px solid var(--muted-border);
      border-radius: 3px;
      color: var(--vscode-descriptionForeground);
      font-size: 8.5px;
      font-weight: 650;
      letter-spacing: .25px;
      line-height: 16px;
      text-transform: uppercase;
    }
    .plan-priority.high {
      color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
      border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)) 45%, transparent);
    }
    .permission {
      margin: 8px 0 12px;
      padding: 10px;
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background);
    }
    .permission-title { font-weight: 650; }
    .permission-copy { margin: 2px 0 9px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .permission-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .resolved { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .notice, .error {
      margin: 8px 0 12px;
      padding: 7px 9px;
      border-left: 2px solid var(--vscode-descriptionForeground);
      color: var(--vscode-descriptionForeground);
      background: var(--surface);
      font-size: 11.5px;
      white-space: pre-wrap;
    }
    .error { border-left-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
    .composer-wrap {
      z-index: 4;
      flex: none;
      width: 100%;
      min-width: 0;
      padding: 8px 9px 9px;
      background: linear-gradient(transparent, var(--vscode-sideBar-background, var(--vscode-editor-background)) 10px);
    }
    .slash-menu {
      width: 100%;
      max-width: 720px;
      max-height: min(260px, 42vh);
      margin: 0 auto 6px;
      overflow-x: hidden;
      overflow-y: auto;
      border: 1px solid var(--vscode-widget-border, var(--border));
      border-radius: 7px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      box-shadow: 0 6px 18px color-mix(in srgb, #000 24%, transparent);
    }
    .slash-command {
      width: 100%;
      display: block;
      padding: 6px 9px 7px;
      border-radius: 0;
      background: transparent;
      text-align: left;
    }
    .slash-command + .slash-command {
      border-top: 1px solid var(--muted-border);
    }
    .slash-command:hover,
    .slash-command.selected {
      background: var(--vscode-list-activeSelectionBackground, var(--accent-soft));
      color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    }
    .slash-command-line {
      display: flex;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
    }
    .slash-command-name {
      flex: none;
      color: var(--vscode-symbolIcon-functionForeground, var(--vscode-textLink-foreground));
      font: 600 11.5px/1.35 var(--vscode-editor-font-family, monospace);
    }
    .slash-command.selected .slash-command-name {
      color: inherit;
    }
    .slash-command-hint {
      min-width: 0;
      overflow: hidden;
      color: var(--vscode-descriptionForeground);
      font: 10px/1.35 var(--vscode-editor-font-family, monospace);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .slash-command-description {
      display: block;
      margin-top: 1px;
      overflow: hidden;
      color: var(--vscode-descriptionForeground);
      font-size: 10.5px;
      line-height: 1.35;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .slash-command.selected .slash-command-hint,
    .slash-command.selected .slash-command-description {
      color: color-mix(in srgb, currentColor 72%, transparent);
    }
    .composer {
      position: relative;
      width: 100%;
      max-width: 720px;
      margin: 0 auto;
      overflow: hidden;
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 7px;
      background: var(--vscode-input-background);
    }
    .composer:focus-within { border-color: var(--vscode-focusBorder); }
    .composer.drag-active {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }
    .drop-overlay {
      position: absolute;
      z-index: 5;
      inset: 0;
      display: grid;
      place-items: center;
      pointer-events: none;
      border-radius: 6px;
      color: var(--vscode-foreground);
      background: color-mix(
        in srgb,
        var(--vscode-editor-background) 88%,
        var(--vscode-focusBorder)
      );
      font-size: 12px;
      font-weight: 650;
      letter-spacing: .1px;
    }
    .drop-overlay-content {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 7px 10px;
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    }
    .drop-overlay-icon {
      font-size: 17px;
      line-height: 1;
    }
    .image-previews {
      display: flex;
      gap: 7px;
      padding: 8px 9px 1px;
      overflow-x: auto;
    }
    .image-preview {
      position: relative;
      width: 62px;
      flex: 0 0 62px;
    }
    .image-preview img {
      width: 62px;
      height: 48px;
      display: block;
      object-fit: cover;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
    }
    .image-preview-name {
      display: block;
      margin-top: 2px;
      overflow: hidden;
      color: var(--vscode-descriptionForeground);
      font-size: 9px;
      line-height: 1.2;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .image-preview-remove {
      position: absolute;
      top: -5px;
      right: -5px;
      width: 18px;
      height: 18px;
      display: grid;
      place-items: center;
      border: 1px solid var(--border);
      border-radius: 50%;
      color: var(--vscode-foreground);
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      font-size: 12px;
      line-height: 1;
    }
    textarea {
      width: 100%;
      min-height: 52px;
      max-height: 180px;
      display: block;
      resize: none;
      padding: 9px 10px 4px;
      border: 0;
      outline: 0;
      color: var(--vscode-input-foreground);
      background: transparent;
      line-height: 1.42;
    }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    .composer-footer {
      min-height: 30px;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 2px 4px 4px 9px;
    }
    .composer-hint {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      color: var(--vscode-descriptionForeground);
      font-size: 9.5px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .composer-hint.error { color: var(--vscode-errorForeground); }
    .attach-button {
      width: 27px;
      height: 27px;
      display: grid;
      place-items: center;
      flex: none;
      border-radius: 5px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
    }
    .attach-button:hover:not(:disabled) {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground, var(--accent-soft));
    }
    .attach-button svg {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 1.7;
    }
    .send-button {
      width: 27px;
      height: 27px;
      display: grid;
      place-items: center;
      border-radius: 5px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font-size: 15px;
      font-weight: 700;
    }
    .stop-button {
      width: 27px;
      height: 27px;
      display: grid;
      place-items: center;
      border-radius: 5px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-errorForeground);
      font-size: 10px;
    }
    .drawer-backdrop {
      position: absolute;
      z-index: 10;
      inset: 0;
      background: color-mix(in srgb, var(--vscode-editor-background) 36%, transparent);
    }
    .drawer {
      position: absolute;
      z-index: 11;
      inset: 0 auto 0 0;
      width: min(92%, 350px);
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      border-right: 1px solid var(--vscode-widget-border, var(--border));
      box-shadow: 8px 0 24px color-mix(in srgb, #000 22%, transparent);
    }
    .drawer-header {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 46px;
      padding: 7px 8px 7px 12px;
      border-bottom: 1px solid var(--muted-border);
      font-weight: 650;
    }
    .drawer-header span { flex: 1; }
    .drawer-actions { display: flex; gap: 7px; padding: 10px; }
    .drawer-actions .primary { flex: 1; }
    .session-list { overflow-y: auto; padding: 1px 6px 14px; }
    .session-group-label {
      padding: 9px 7px 5px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      font-weight: 650;
      letter-spacing: .35px;
      text-transform: uppercase;
    }
    .session-row {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px;
      padding: 7px 7px;
      border-radius: 5px;
      text-align: left;
      background: transparent;
    }
    .session-row:hover, .session-row.active {
      background: var(--vscode-list-hoverBackground);
    }
    .session-row.active { outline: 1px solid var(--vscode-list-focusOutline, var(--border)); }
    .session-title {
      overflow: hidden;
      font-size: 11.5px;
      font-weight: 550;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .session-meta {
      margin-top: 2px;
      overflow: hidden;
      color: var(--vscode-descriptionForeground);
      font-size: 9.5px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .delete-session {
      align-self: center;
      padding: 3px 5px;
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      opacity: 0;
    }
    .session-row:hover .delete-session { opacity: 1; }
    .delete-session:hover { color: var(--vscode-errorForeground); background: var(--vscode-toolbar-hoverBackground); }
    .drawer-footer {
      padding: 8px 10px;
      border-top: 1px solid var(--muted-border);
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }
    .banner {
      margin: 9px 10px 0;
      padding: 7px 9px;
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 5px;
      color: var(--vscode-errorForeground);
      background: var(--vscode-inputValidation-errorBackground);
      font-size: 11px;
    }
    .auth-card {
      margin: 9px 10px 0;
      padding: 9px;
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background);
      font-size: 11.5px;
    }
    .auth-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .hidden { display: none !important; }
    @media (max-width: 260px) {
      .session-toolbar { padding-inline: 7px; }
      .transcript { padding-inline: 9px; }
      .composer-wrap { padding-inline: 6px; }
      .start-actions { flex-direction: column; }
      .config-context { display: none; }
      .config-field,
      .config-switch {
        grid-template-columns: minmax(0, 1fr);
        gap: 4px;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <button id="sessions-button" class="icon-button" title="Sessions" aria-label="Sessions">☰</button>
      <div class="brand">
        <div id="top-title" class="brand-title">Brokk ACP</div>
        <div class="brand-meta"><i id="status-dot" class="status-dot"></i><span id="top-meta">Open agent coding</span></div>
      </div>
      <button id="new-button" class="icon-button" title="New session" aria-label="New session">＋</button>
    </header>
    <main class="main">
      <section id="empty" class="empty">
        <div class="start-card">
          <div class="mark">B</div>
          <h1>Start an agent session</h1>
          <p class="lede">Use Anvil, a custom server, or any agent from the official ACP registry.</p>
          <label class="field-label" for="agent">ACP agent</label>
          <select id="agent" aria-label="ACP agent"></select>
          <div id="agent-description" class="agent-description"></div>
          <div class="start-actions">
            <button id="start-button" class="primary">New session</button>
            <button id="browse-button" class="secondary" title="Connect and discover sessions from this agent">Sessions</button>
          </div>
          <div id="install-row" class="install-row hidden">
            <span>This registry agent is not installed.</span>
            <button id="install-button" class="text-button">Install agent</button>
          </div>
        </div>
      </section>
      <section id="session-view" class="session-view hidden">
        <div id="session-toolbar" class="session-toolbar" aria-label="Session configuration">
          <span class="config-context">Session</span>
          <span id="config-summary" class="config-summary"></span>
          <button id="config-button" class="config-link" aria-expanded="false" aria-controls="config-panel">Change</button>
        </div>
        <section id="config-panel" class="config-panel hidden" aria-label="Session configuration options">
          <div class="config-panel-heading">
            <div class="config-panel-title">Session configuration</div>
            <div class="config-panel-description">Changes apply immediately to this session.</div>
          </div>
          <div id="config-editor" class="config-editor"></div>
        </section>
        <section id="plan-dock" class="plan-dock hidden" aria-label="Agent plan"></section>
        <div id="transcript" class="transcript"><div id="transcript-inner" class="transcript-inner"></div></div>
        <div class="composer-wrap">
          <div id="slash-menu" class="slash-menu hidden" role="listbox" aria-label="Available agent commands"></div>
          <div id="composer" class="composer">
            <div id="drop-overlay" class="drop-overlay hidden" aria-hidden="true">
              <div class="drop-overlay-content">
                <span class="drop-overlay-icon" aria-hidden="true">▧</span>
                <span>Drop images to attach</span>
              </div>
            </div>
            <div id="image-previews" class="image-previews hidden" aria-label="Attached images"></div>
            <textarea id="prompt" rows="2" placeholder="Ask the agent…" role="combobox" aria-autocomplete="list" aria-controls="slash-menu" aria-expanded="false"></textarea>
            <div class="composer-footer">
              <input id="image-input" class="visually-hidden" type="file" accept="${PROMPT_IMAGE_MIME_TYPES.join(",")}" multiple>
              <button id="attach-button" class="attach-button" title="Attach image" aria-label="Attach image">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 12.5 14.9 6.1a3 3 0 0 1 4.2 4.2l-8.5 8.5a5 5 0 0 1-7.1-7.1l8.2-8.2"/><path d="m6.4 14.6 8.5-8.5"/></svg>
              </button>
              <span id="composer-hint" class="composer-hint">⌘↵ to send</span>
              <button id="send-button" class="send-button" title="Send" aria-label="Send">↑</button>
              <button id="stop-button" class="stop-button hidden" title="Stop" aria-label="Stop">■</button>
            </div>
          </div>
        </div>
      </section>
      <div id="banner" class="banner hidden"></div>
      <div id="auth-card" class="auth-card hidden"></div>
      <div id="drawer-backdrop" class="drawer-backdrop hidden"></div>
      <aside id="drawer" class="drawer hidden" aria-label="Sessions">
        <div class="drawer-header"><span>Sessions</span><button id="close-drawer" class="icon-button" aria-label="Close">×</button></div>
        <div class="drawer-actions">
          <button id="drawer-new" class="primary">＋ New session</button>
          <button id="refresh-sessions" class="icon-button" title="Refresh sessions" aria-label="Refresh sessions">↻</button>
        </div>
        <div id="session-list" class="session-list"></div>
        <div id="drawer-footer" class="drawer-footer">Sessions are provided by each ACP agent.</div>
      </aside>
    </main>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const elements = Object.fromEntries([
      'empty', 'session-view', 'top-title', 'top-meta', 'status-dot', 'agent', 'agent-description',
      'install-row', 'start-button', 'browse-button', 'session-toolbar', 'config-summary',
      'config-button', 'config-panel', 'config-editor', 'plan-dock', 'transcript',
      'transcript-inner', 'composer', 'drop-overlay', 'prompt', 'composer-hint', 'send-button',
      'stop-button', 'banner', 'slash-menu', 'image-previews', 'image-input', 'attach-button',
      'auth-card', 'drawer', 'drawer-backdrop', 'session-list', 'drawer-footer'
    ].map(id => [id, document.getElementById(id)]));
    const imageLimits = ${JSON.stringify({
      count: MAX_PROMPT_IMAGES,
      bytes: MAX_PROMPT_IMAGE_BYTES,
      totalBytes: MAX_PROMPT_IMAGE_TOTAL_BYTES,
      mimeTypes: PROMPT_IMAGE_MIME_TYPES,
    })};
    let appState = { agents: [], selectedAgent: '', connection: { phase: 'idle' }, sessions: [] };
    let drawerOpen = false;
    let configOpen = false;
    let configSessionId;
    let renderPending = false;
    let slashMatches = [];
    let slashSelected = 0;
    let slashDismissedValue;
    let pendingImages = [];
    let attachmentError;
    let attachmentSessionId;
    let imageDragDepth = 0;
    const expandedEntries = new Set();
    const collapsedPlans = new Set();

    function selectedAgent() {
      return appState.agents.find(agent => agent.id === elements.agent.value);
    }

    function post(type, payload = {}) {
      vscode.postMessage({ type, ...payload });
    }

    function setDrawer(open) {
      drawerOpen = open;
      elements.drawer.classList.toggle('hidden', !open);
      elements['drawer-backdrop'].classList.toggle('hidden', !open);
      if (open) renderSessions();
    }

    function setConfigOpen(open) {
      const hasOptions = supportedConfigOptions(appState.active?.configOptions).length > 0;
      configOpen = Boolean(open && hasOptions);
      elements['config-panel'].classList.toggle('hidden', !configOpen);
      elements['config-button'].textContent = configOpen ? 'Done' : 'Change';
      elements['config-button'].setAttribute('aria-expanded', String(configOpen));
    }

    function statusLabel(status) {
      return ({
        connecting: 'Connecting',
        ready: 'Ready',
        running: 'Working',
        disconnected: 'Disconnected',
        error: 'Needs attention'
      })[status] || 'Open agent coding';
    }

    function render() {
      renderPending = false;
      const active = appState.active;
      if (active?.localId !== configSessionId) {
        configOpen = false;
        configSessionId = active?.localId;
      }
      elements.empty.classList.toggle('hidden', Boolean(active));
      elements['session-view'].classList.toggle('hidden', !active);
      elements['top-title'].textContent = active ? active.title : 'Brokk ACP';
      const status = active?.status || appState.connection?.phase || 'idle';
      elements['top-meta'].textContent = active
        ? active.agentName + ' · ' + statusLabel(status)
        : appState.connection?.phase === 'connecting' ? 'Connecting to agent' : 'Open agent coding';
      elements['status-dot'].className = 'status-dot ' + status;
      renderAgentPicker();
      renderSessions();
      renderBanner();
      renderAuth();
      if (active) {
        renderConfig(active.configOptions);
        renderPlanDock(active);
        renderTranscript(active);
        renderComposer(active);
      } else {
        setConfigOpen(false);
      }
    }

    function scheduleRender() {
      if (renderPending) return;
      renderPending = true;
      requestAnimationFrame(render);
    }

    function renderAgentPicker() {
      const current = appState.selectedAgent || elements.agent.value;
      elements.agent.replaceChildren();
      for (const agent of appState.agents || []) {
        const option = document.createElement('option');
        option.value = agent.id;
        option.textContent = agent.name + (agent.version ? ' ' + agent.version : '') + (agent.ready ? '' : ' — install');
        elements.agent.appendChild(option);
      }
      if ((appState.agents || []).some(agent => agent.id === current)) elements.agent.value = current;
      const agent = selectedAgent();
      if (!agent) {
        elements['agent-description'].textContent = 'No ACP agents are available.';
        elements['start-button'].disabled = true;
        return;
      }
      const detail = [agent.description, agent.source === 'registry' && agent.version ? 'v' + agent.version : '', agent.requirement || '']
        .filter(Boolean).join(' · ');
      elements['agent-description'].textContent = detail;
      elements['install-row'].classList.toggle('hidden', !agent.installable);
      elements['start-button'].disabled = !agent.ready;
      elements['browse-button'].disabled = !agent.ready;
    }

    function renderSessions() {
      const list = elements['session-list'];
      list.replaceChildren();
      const sessions = appState.sessions || [];
      if (!sessions.length) {
        const empty = document.createElement('div');
        empty.className = 'welcome';
        empty.textContent = 'No sessions yet.';
        list.appendChild(empty);
        return;
      }
      const groups = new Map();
      for (const session of sessions) {
        const label = dayLabel(session.updatedAt);
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(session);
      }
      for (const [label, values] of groups) {
        const heading = document.createElement('div');
        heading.className = 'session-group-label';
        heading.textContent = label;
        list.appendChild(heading);
        for (const session of values) {
          const row = document.createElement('button');
          row.className = 'session-row' + (appState.active?.localId === session.localId ? ' active' : '');
          const copy = document.createElement('div');
          const title = document.createElement('div');
          title.className = 'session-title';
          title.textContent = session.title;
          const meta = document.createElement('div');
          meta.className = 'session-meta';
          meta.textContent = session.agentName + ' · ' + relativeTime(session.updatedAt);
          copy.append(title, meta);
          row.appendChild(copy);
          if (session.remoteId && appState.connection?.agentId === session.agentId && appState.connection?.canDelete) {
            const remove = document.createElement('button');
            remove.className = 'delete-session';
            remove.title = 'Delete session';
            remove.textContent = '×';
            remove.onclick = event => {
              event.stopPropagation();
              post('delete_session', { local_id: session.localId });
            };
            row.appendChild(remove);
          }
          row.onclick = () => {
            setDrawer(false);
            post('open_session', { local_id: session.localId });
          };
          list.appendChild(row);
        }
      }
    }

    function renderBanner() {
      const message = appState.banner;
      elements.banner.classList.toggle('hidden', !message);
      elements.banner.textContent = message || '';
    }

    function renderAuth() {
      const auth = appState.auth;
      const card = elements['auth-card'];
      card.replaceChildren();
      card.classList.toggle('hidden', !auth);
      if (!auth) return;
      const copy = document.createElement('div');
      copy.textContent = auth.message || 'This agent requires authentication.';
      const actions = document.createElement('div');
      actions.className = 'auth-actions';
      for (const method of auth.methods || []) {
        const button = document.createElement('button');
        button.className = 'primary';
        button.textContent = method.name || 'Sign in';
        button.onclick = () => post('authenticate', { method_id: method.id });
        actions.appendChild(button);
      }
      const retry = document.createElement('button');
      retry.className = 'secondary';
      retry.textContent = 'Retry';
      retry.onclick = () => post('retry_session');
      actions.appendChild(retry);
      card.append(copy, actions);
    }

    function renderConfig(options) {
      const supported = supportedConfigOptions(options);
      const toolbar = elements['session-toolbar'];
      const editor = elements['config-editor'];
      toolbar.classList.toggle('hidden', supported.length === 0);
      editor.replaceChildren();

      const summaryValues = supported.map(configValueLabel).filter(Boolean);
      elements['config-summary'].textContent = summaryValues.join(' · ');
      elements['config-summary'].title = supported
        .map(option => (option.name || option.id) + ': ' + configValueLabel(option))
        .join(' · ');

      for (const option of supported) {
        if (option.type === 'select') {
          const wrapper = document.createElement('label');
          wrapper.className = 'config-field';
          const name = document.createElement('span');
          name.className = 'config-field-name';
          name.textContent = option.name || option.id;
          name.title = option.name || option.id;
          const select = document.createElement('select');
          select.setAttribute('aria-label', option.name || option.id);
          const choices = flattenOptions(option.options).filter(choice =>
            choice && typeof choice.value === 'string'
          );
          for (const choice of choices) {
            const node = document.createElement('option');
            node.value = choice.value;
            node.textContent = String(choice.name || choice.value);
            node.selected = choice.value === option.currentValue;
            select.appendChild(node);
          }
          select.onchange = () => {
            post('set_config', {
              config_id: option.id,
              value: { value: select.value }
            });
          };
          wrapper.append(name, select);
          editor.appendChild(wrapper);
        } else if (option.type === 'boolean') {
          const row = document.createElement('div');
          row.className = 'config-switch';
          const name = document.createElement('span');
          name.className = 'config-field-name';
          name.textContent = option.name || option.id;
          name.title = option.name || option.id;
          const label = document.createElement('label');
          label.className = 'config-switch-control';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = option.currentValue === true;
          const copy = document.createElement('span');
          copy.textContent = checkbox.checked ? 'On' : 'Off';
          checkbox.onchange = () => {
            copy.textContent = checkbox.checked ? 'On' : 'Off';
            post('set_config', {
              config_id: option.id,
              value: { type: 'boolean', value: checkbox.checked }
            });
          };
          label.append(checkbox, copy);
          row.append(name, label);
          editor.appendChild(row);
        }
      }
      setConfigOpen(configOpen);
    }

    function renderTranscript(active) {
      const viewport = elements.transcript;
      const nearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 90;
      const inner = elements['transcript-inner'];
      const visibleEntries = Array.isArray(active.entries)
        ? active.entries.filter(entry => entry?.kind !== 'plan')
        : [];
      inner.replaceChildren();
      if (!visibleEntries.length) {
        const welcome = document.createElement('div');
        welcome.className = 'welcome';
        const title = document.createElement('div');
        title.className = 'welcome-title';
        title.textContent = active.status === 'connecting'
          ? 'Opening ' + active.agentName + '…'
          : 'What would you like to build?';
        if (active.status === 'connecting') {
          const stage = document.createElement('div');
          stage.className = 'connection-stage';
          const spinner = document.createElement('i');
          spinner.className = 'connection-spinner';
          spinner.setAttribute('aria-hidden', 'true');
          const copy = document.createElement('span');
          copy.textContent = appState.connection?.detail || 'Starting the ACP agent…';
          stage.append(spinner, copy);
          welcome.append(title, stage);
        } else {
          const copy = document.createElement('div');
          copy.textContent = 'This conversation is stored with the workspace and can be reopened from Sessions.';
          welcome.append(title, copy);
        }
        inner.appendChild(welcome);
      } else {
        for (const entry of visibleEntries) inner.appendChild(renderEntry(entry, active.status));
      }
      if (nearBottom) viewport.scrollTop = viewport.scrollHeight;
    }

    function renderPlanDock(active) {
      const dock = elements['plan-dock'];
      const entries = Array.isArray(active.currentPlan)
        ? active.currentPlan.filter(item =>
            item &&
            typeof item.content === 'string' &&
            ['high', 'medium', 'low'].includes(item.priority) &&
            ['pending', 'in_progress', 'completed'].includes(item.status)
          )
        : [];
      dock.replaceChildren();
      dock.classList.toggle('hidden', entries.length === 0);
      if (!entries.length) return;

      const collapsed = collapsedPlans.has(active.localId);
      const completed = entries.filter(item => item.status === 'completed').length;
      const inProgress = entries.filter(item => item.status === 'in_progress').length;
      const shell = document.createElement('div');
      shell.className = 'plan-shell' + (collapsed ? ' collapsed' : '');
      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'plan-header';
      header.setAttribute('aria-expanded', String(!collapsed));
      header.setAttribute('aria-controls', 'active-plan-entries');
      header.onclick = () => {
        if (collapsedPlans.has(active.localId)) {
          collapsedPlans.delete(active.localId);
        } else {
          collapsedPlans.add(active.localId);
        }
        renderPlanDock(active);
      };
      const chevron = document.createElement('span');
      chevron.className = 'plan-chevron';
      chevron.textContent = '›';
      chevron.setAttribute('aria-hidden', 'true');
      const heading = document.createElement('span');
      heading.className = 'plan-heading';
      heading.textContent = 'Plan';
      const summary = document.createElement('span');
      summary.className = 'plan-summary';
      summary.setAttribute('aria-live', 'polite');
      summary.textContent = completed + '/' + entries.length + ' complete' +
        (inProgress ? ' · ' + inProgress + ' active' : '');
      header.append(chevron, heading, summary);
      shell.appendChild(header);

      if (!collapsed) {
        const body = document.createElement('div');
        body.id = 'active-plan-entries';
        body.className = 'plan-body';
        for (const item of entries) {
          const row = document.createElement('div');
          row.className = 'plan-row ' + item.status;
          row.setAttribute(
            'aria-label',
            item.status.replace('_', ' ') + ', ' + item.priority + ' priority: ' + item.content
          );
          const marker = document.createElement('span');
          marker.className = 'plan-marker';
          marker.textContent = item.status === 'completed'
            ? '✓'
            : item.status === 'in_progress' ? '●' : '○';
          marker.setAttribute('aria-hidden', 'true');
          const copy = document.createElement('span');
          copy.className = 'plan-copy';
          copy.textContent = item.content;
          const priority = document.createElement('span');
          priority.className = 'plan-priority ' + item.priority;
          priority.textContent = item.priority;
          priority.title = item.priority + ' priority';
          row.append(marker, copy, priority);
          body.appendChild(row);
        }
        shell.appendChild(body);
      }
      dock.appendChild(shell);
    }

    function renderEntry(entry, sessionStatus) {
      const wrapper = document.createElement('div');
      wrapper.className = 'entry ' + entry.kind;
      wrapper.dataset.entryId = entry.id;
      if (entry.kind === 'user') {
        const bubble = document.createElement('div');
        bubble.className = 'user-bubble';
        const attachments = Array.isArray(entry.attachments)
          ? entry.attachments.filter(item => item?.type === 'image')
          : [];
        if (attachments.length) {
          const list = document.createElement('div');
          list.className = 'user-attachments';
          for (const attachment of attachments) {
            const item = document.createElement('span');
            item.className = 'user-attachment';
            const icon = document.createElement('span');
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = '▧';
            const name = document.createElement('span');
            name.textContent = attachment.name || 'Image';
            item.title = attachment.mimeType || 'Image attachment';
            item.append(icon, name);
            list.appendChild(item);
          }
          bubble.appendChild(list);
        }
        if (entry.text) {
          const text = document.createElement('div');
          text.textContent = entry.text;
          bubble.appendChild(text);
        }
        wrapper.appendChild(bubble);
        return wrapper;
      }
      if (entry.kind === 'assistant') {
        const body = document.createElement('div');
        body.className = 'assistant-body' + (entry.status === 'streaming' && sessionStatus === 'running' ? ' streaming-caret' : '');
        renderMarkdown(body, entry.text || '');
        wrapper.appendChild(body);
        return wrapper;
      }
      if (entry.kind === 'thought') {
        const detail = document.createElement('details');
        detail.className = 'thought';
        detail.open = expandedEntries.has(entry.id);
        detail.ontoggle = () => detail.open ? expandedEntries.add(entry.id) : expandedEntries.delete(entry.id);
        const summary = document.createElement('summary');
        summary.textContent = entry.status === 'streaming' ? 'Thinking…' : 'Thought process';
        const body = document.createElement('div');
        body.className = 'thought-content';
        body.textContent = entry.text || '';
        detail.append(summary, body);
        wrapper.appendChild(detail);
        return wrapper;
      }
      if (entry.kind === 'tool') {
        wrapper.appendChild(renderTool(entry));
        return wrapper;
      }
      if (entry.kind === 'permission') {
        wrapper.appendChild(renderPermission(entry));
        return wrapper;
      }
      const message = document.createElement('div');
      message.className = entry.kind === 'error' ? 'error' : 'notice';
      message.textContent = entry.text || '';
      wrapper.appendChild(message);
      return wrapper;
    }

    function renderTool(entry) {
      const detail = document.createElement('details');
      detail.className = 'tool';
      detail.open = expandedEntries.has(entry.id);
      detail.ontoggle = () => detail.open ? expandedEntries.add(entry.id) : expandedEntries.delete(entry.id);
      const summary = document.createElement('summary');
      const icon = document.createElement('span');
      icon.className = 'tool-icon';
      icon.textContent = toolIcon(entry.toolKind);
      const title = document.createElement('span');
      title.className = 'tool-title';
      title.textContent = entry.title || 'Tool call';
      const status = document.createElement('span');
      status.className = 'tool-status ' + (entry.status || '');
      status.textContent = entry.status || 'pending';
      summary.append(icon, title, status);
      const body = document.createElement('div');
      body.className = 'tool-body';
      let hasContent = false;
      for (const location of Array.isArray(entry.locations) ? entry.locations : []) {
        if (!location || typeof location.path !== 'string') continue;
        const node = document.createElement('div');
        node.className = 'location';
        node.textContent = location.path + (location.line ? ':' + location.line : '');
        body.appendChild(node);
        hasContent = true;
      }
      for (const item of Array.isArray(entry.content) ? entry.content : []) {
        const text = toolContentText(item);
        if (!text) continue;
        const pre = document.createElement('pre');
        pre.textContent = text;
        body.appendChild(pre);
        hasContent = true;
      }
      if (entry.rawInput !== undefined || entry.rawOutput !== undefined) {
        const raw = document.createElement('details');
        const rawSummary = document.createElement('summary');
        rawSummary.textContent = 'Raw details';
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify({ input: entry.rawInput, output: entry.rawOutput }, null, 2);
        raw.append(rawSummary, pre);
        body.appendChild(raw);
        hasContent = true;
      }
      if (!hasContent) body.textContent = entry.status === 'in_progress' ? 'Running…' : 'No additional output.';
      detail.append(summary, body);
      return detail;
    }

    function renderPermission(entry) {
      const card = document.createElement('div');
      card.className = 'permission';
      const title = document.createElement('div');
      title.className = 'permission-title';
      title.textContent = entry.title || 'Permission required';
      const copy = document.createElement('div');
      copy.className = 'permission-copy';
      copy.textContent = entry.toolKind ? 'The agent wants to run a ' + entry.toolKind + ' operation.' : 'The agent needs your approval to continue.';
      card.append(title, copy);
      if (entry.resolvedOptionId !== undefined) {
        const resolved = document.createElement('div');
        resolved.className = 'resolved';
        resolved.textContent = entry.resolvedOptionId ? 'Answered: ' + entry.resolvedOptionId : 'Cancelled';
        card.appendChild(resolved);
      } else {
        const actions = document.createElement('div');
        actions.className = 'permission-actions';
        for (const option of entry.options || []) {
          const button = document.createElement('button');
          button.className = String(option?.kind || '').startsWith('reject') ? 'secondary' : 'primary';
          button.textContent = option?.name || option?.optionId || 'Continue';
          button.onclick = () => post('permission_response', {
            request_id: entry.requestId,
            option_id: option?.optionId || null
          });
          actions.appendChild(button);
        }
        card.appendChild(actions);
      }
      return card;
    }

    function imagePromptsSupported() {
      return appState.connection?.canPromptImages === true;
    }

    function canSubmitPrompt(active) {
      return active?.status === 'ready' &&
        (Boolean(elements.prompt.value.trim()) || pendingImages.length > 0);
    }

    function renderImagePreviews() {
      const previews = elements['image-previews'];
      previews.replaceChildren();
      previews.classList.toggle('hidden', pendingImages.length === 0);
      pendingImages.forEach((image, index) => {
        const card = document.createElement('div');
        card.className = 'image-preview';
        const preview = document.createElement('img');
        preview.src = 'data:' + image.mimeType + ';base64,' + image.data;
        preview.alt = image.name;
        const name = document.createElement('span');
        name.className = 'image-preview-name';
        name.textContent = image.name;
        const remove = document.createElement('button');
        remove.className = 'image-preview-remove';
        remove.type = 'button';
        remove.title = 'Remove ' + image.name;
        remove.setAttribute('aria-label', 'Remove ' + image.name);
        remove.textContent = '×';
        remove.onclick = () => {
          pendingImages.splice(index, 1);
          attachmentError = undefined;
          renderComposer(appState.active);
        };
        card.append(preview, name, remove);
        previews.appendChild(card);
      });
    }

    function showAttachmentError(message) {
      attachmentError = message;
      renderComposer(appState.active);
    }

    function readImage(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read ' + file.name + '.'));
        reader.onload = () => {
          if (typeof reader.result !== 'string' || !reader.result.includes(',')) {
            reject(new Error('Could not read ' + file.name + '.'));
            return;
          }
          resolve(reader.result.slice(reader.result.indexOf(',') + 1));
        };
        reader.readAsDataURL(file);
      });
    }

    async function addImageFiles(values) {
      const files = Array.from(values || []);
      if (!files.length) return;
      if (appState.active?.status !== 'ready') {
        showAttachmentError('Wait for the session to be ready before attaching an image.');
        return;
      }
      if (!imagePromptsSupported()) {
        showAttachmentError('This ACP agent does not support image prompts.');
        return;
      }
      if (pendingImages.length + files.length > imageLimits.count) {
        showAttachmentError('Attach at most ' + imageLimits.count + ' images to one prompt.');
        return;
      }

      let totalBytes = pendingImages.reduce((sum, image) => sum + image.size, 0);
      for (const file of files) {
        const mimeType = String(file.type || '').toLowerCase();
        if (!imageLimits.mimeTypes.includes(mimeType)) {
          showAttachmentError(file.name + ' must be PNG, JPEG, GIF, or WebP.');
          continue;
        }
        if (file.size > imageLimits.bytes) {
          showAttachmentError(file.name + ' exceeds the 10 MB limit.');
          continue;
        }
        if (totalBytes + file.size > imageLimits.totalBytes) {
          showAttachmentError('Image attachments exceed the 20 MB total limit.');
          continue;
        }
        try {
          const data = await readImage(file);
          pendingImages.push({
            data,
            mimeType,
            name: file.name || 'Image',
            size: file.size
          });
          totalBytes += file.size;
          attachmentError = undefined;
        } catch (error) {
          showAttachmentError(error instanceof Error ? error.message : String(error));
        }
      }
      renderComposer(appState.active);
    }

    function dragHasFiles(event) {
      const transfer = event.dataTransfer;
      if (!transfer) return false;
      return Array.from(transfer.types || []).includes('Files') ||
        Boolean(transfer.files?.length);
    }

    function setImageDragActive(active) {
      const enabled = Boolean(
        active &&
        appState.active?.status === 'ready' &&
        imagePromptsSupported()
      );
      elements.composer.classList.toggle('drag-active', enabled);
      elements['drop-overlay'].classList.toggle('hidden', !enabled);
    }

    function resetImageDrag() {
      imageDragDepth = 0;
      setImageDragActive(false);
    }

    function renderComposer(active) {
      if (attachmentSessionId !== active.localId) {
        attachmentSessionId = active.localId;
        pendingImages = [];
        attachmentError = undefined;
      }
      if (!imagePromptsSupported() && pendingImages.length) {
        pendingImages = [];
      }
      const running = active.status === 'running';
      const ready = active.status === 'ready';
      if (!ready || !imagePromptsSupported()) resetImageDrag();
      elements.prompt.disabled = false;
      elements['send-button'].classList.toggle('hidden', running);
      elements['stop-button'].classList.toggle('hidden', !running);
      elements['send-button'].disabled = !canSubmitPrompt(active);
      elements['attach-button'].disabled = !ready || !imagePromptsSupported();
      elements['image-input'].disabled = !ready || !imagePromptsSupported();
      elements['attach-button'].title = imagePromptsSupported()
        ? 'Attach image'
        : 'This agent does not advertise image prompt support';
      elements['composer-hint'].classList.toggle('error', Boolean(attachmentError));
      elements['composer-hint'].textContent = defaultComposerHint(active);
      renderImagePreviews();
      updateSlashMenu(active);
    }

    function defaultComposerHint(active) {
      return attachmentError || usageLabel(active?.usage) ||
        (active?.status === 'running' ? 'Agent is working…' : '⌘↵ to send');
    }

    function advertisedSlashCommands(active) {
      const commands = [];
      const seen = new Set();
      for (const value of Array.isArray(active?.availableCommands) ? active.availableCommands : []) {
        if (!value || typeof value !== 'object' || typeof value.name !== 'string') continue;
        const name = value.name.trim().replace(/^\\/+/, '');
        const key = name.toLocaleLowerCase();
        if (!name || /\\s/.test(name) || seen.has(key)) continue;
        seen.add(key);
        const description = typeof value.description === 'string' ? value.description.trim() : '';
        const inputHint =
          value.input && typeof value.input === 'object' && typeof value.input.hint === 'string'
            ? value.input.hint.trim()
            : '';
        commands.push({ name, description, inputHint });
      }
      return commands;
    }

    function slashQuery() {
      const value = elements.prompt.value;
      if (
        !value.startsWith('/') ||
        /\\s/.test(value.slice(1)) ||
        elements.prompt.selectionStart !== value.length ||
        elements.prompt.selectionEnd !== value.length
      ) {
        return;
      }
      return value.slice(1).toLocaleLowerCase();
    }

    function updateSlashMenu(active) {
      const query = slashQuery();
      const previousName = slashMatches[slashSelected]?.name;
      if (
        active?.status !== 'ready' ||
        document.activeElement !== elements.prompt ||
        query === undefined ||
        slashDismissedValue === elements.prompt.value
      ) {
        slashMatches = [];
        slashSelected = 0;
        drawSlashMenu();
        return;
      }

      const commands = advertisedSlashCommands(active);
      const prefixMatches = commands.filter(command =>
        command.name.toLocaleLowerCase().startsWith(query)
      );
      slashMatches = prefixMatches.length
        ? prefixMatches
        : commands.filter(command => command.name.toLocaleLowerCase().includes(query));
      const previousIndex = previousName
        ? slashMatches.findIndex(command => command.name === previousName)
        : -1;
      slashSelected = previousIndex >= 0 ? previousIndex : 0;
      drawSlashMenu();
    }

    function drawSlashMenu() {
      const menu = elements['slash-menu'];
      menu.replaceChildren();
      menu.classList.toggle('hidden', slashMatches.length === 0);
      elements.prompt.setAttribute('aria-expanded', String(slashMatches.length > 0));
      if (!slashMatches.length) {
        elements.prompt.removeAttribute('aria-activedescendant');
        elements['composer-hint'].textContent = defaultComposerHint(appState.active);
        return;
      }

      slashMatches.forEach((command, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.id = 'slash-command-' + index;
        item.className = 'slash-command' + (index === slashSelected ? ' selected' : '');
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(index === slashSelected));
        item.tabIndex = -1;

        const line = document.createElement('span');
        line.className = 'slash-command-line';
        const name = document.createElement('span');
        name.className = 'slash-command-name';
        name.textContent = '/' + command.name;
        line.appendChild(name);
        if (command.inputHint) {
          const hint = document.createElement('span');
          hint.className = 'slash-command-hint';
          hint.textContent = '<' + command.inputHint + '>';
          line.appendChild(hint);
        }
        item.appendChild(line);
        if (command.description) {
          const description = document.createElement('span');
          description.className = 'slash-command-description';
          description.textContent = command.description;
          item.appendChild(description);
        }
        item.onmousedown = event => event.preventDefault();
        item.onmouseenter = () => selectSlashCommand(index);
        item.onclick = () => acceptSlashCommand(index);
        menu.appendChild(item);
      });

      selectSlashCommand(slashSelected);
      elements['composer-hint'].textContent = '↑↓ navigate · Enter or Tab insert · Esc close';
    }

    function selectSlashCommand(index) {
      const menu = elements['slash-menu'];
      if (!slashMatches.length || index < 0 || index >= slashMatches.length) return;
      slashSelected = index;
      Array.from(menu.children).forEach((item, itemIndex) => {
        item.classList.toggle('selected', itemIndex === slashSelected);
        item.setAttribute('aria-selected', String(itemIndex === slashSelected));
      });
      const selected = menu.children[slashSelected];
      if (selected) {
        elements.prompt.setAttribute('aria-activedescendant', selected.id);
        selected.scrollIntoView({ block: 'nearest' });
      }
    }

    function moveSlashSelection(delta) {
      if (!slashMatches.length) return;
      selectSlashCommand((slashSelected + delta + slashMatches.length) % slashMatches.length);
    }

    function acceptSlashCommand(index = slashSelected) {
      const command = slashMatches[index];
      if (!command) return;
      elements.prompt.value = '/' + command.name + ' ';
      slashMatches = [];
      slashSelected = 0;
      slashDismissedValue = elements.prompt.value;
      drawSlashMenu();
      autosizePrompt();
      elements['send-button'].disabled = appState.active?.status !== 'ready';
      elements.prompt.focus();
      elements.prompt.setSelectionRange(elements.prompt.value.length, elements.prompt.value.length);
      renderComposer(appState.active);
    }

    function dismissSlashMenu() {
      slashDismissedValue = elements.prompt.value;
      slashMatches = [];
      slashSelected = 0;
      drawSlashMenu();
      renderComposer(appState.active);
    }

    function submitPrompt() {
      const text = elements.prompt.value.trim();
      const images = pendingImages.map(image => ({
        data: image.data,
        mimeType: image.mimeType,
        name: image.name
      }));
      if ((!text && !images.length) || appState.active?.status !== 'ready') return;
      post('prompt', images.length ? { text, images } : { text });
      elements.prompt.value = '';
      pendingImages = [];
      attachmentError = undefined;
      slashDismissedValue = undefined;
      slashMatches = [];
      autosizePrompt();
      elements['send-button'].disabled = true;
      renderImagePreviews();
      drawSlashMenu();
    }

    function renderMarkdown(target, text) {
      if (!text) return;
      const lines = text.replace(/\\r/g, '').split('\\n');
      let paragraph = [];
      let list = null;
      let code = null;
      const flushParagraph = () => {
        if (!paragraph.length) return;
        const p = document.createElement('p');
        appendInline(p, paragraph.join(' '));
        target.appendChild(p);
        paragraph = [];
      };
      const flushList = () => {
        if (list) target.appendChild(list);
        list = null;
      };
      for (const line of lines) {
        if (line.startsWith('\`\`\`')) {
          flushParagraph();
          flushList();
          if (code) {
            const pre = document.createElement('pre');
            const node = document.createElement('code');
            node.textContent = code.join('\\n');
            pre.appendChild(node);
            target.appendChild(pre);
            code = null;
          } else {
            code = [];
          }
          continue;
        }
        if (code) {
          code.push(line);
          continue;
        }
        const heading = line.match(/^#{1,3}\\s+(.+)$/);
        if (heading) {
          flushParagraph();
          flushList();
          const h = document.createElement('h3');
          appendInline(h, heading[1]);
          target.appendChild(h);
          continue;
        }
        const bullet = line.match(/^\\s*[-*]\\s+(.+)$/);
        const numbered = line.match(/^\\s*\\d+[.)]\\s+(.+)$/);
        if (bullet || numbered) {
          flushParagraph();
          const tag = numbered ? 'ol' : 'ul';
          if (!list || list.tagName.toLowerCase() !== tag) {
            flushList();
            list = document.createElement(tag);
          }
          const li = document.createElement('li');
          appendInline(li, (bullet || numbered)[1]);
          list.appendChild(li);
          continue;
        }
        if (!line.trim()) {
          flushParagraph();
          flushList();
        } else {
          paragraph.push(line.trim());
        }
      }
      flushParagraph();
      flushList();
      if (code) {
        const pre = document.createElement('pre');
        const node = document.createElement('code');
        node.textContent = code.join('\\n');
        pre.appendChild(node);
        target.appendChild(pre);
      }
    }

    function appendInline(target, text) {
      const pattern = new RegExp([
        /(\`+)([^\\n]*?)\\1/.source,
        /(?<!\\*)\\*\\*\\*(?!\\*)(?=\\S)(.+?)(?<=\\S)(?<!\\*)\\*\\*\\*(?!\\*)/.source,
        /(?<![\\w_])___(?!_)(?=\\S)(.+?)(?<=\\S)(?<!_)___(?![\\w_])/.source,
        /(?<!\\*)\\*\\*(?!\\*)(?=\\S)(.+?)(?<=\\S)(?<!\\*)\\*\\*(?!\\*)/.source,
        /(?<![\\w_])__(?!_)(?=\\S)(.+?)(?<=\\S)(?<!_)__(?![\\w_])/.source,
        /(?<!\\*)\\*(?!\\*)(?=\\S)(.+?)(?<=\\S)(?<!\\*)\\*(?!\\*)/.source,
        /(?<![\\w_])_(?!_)(?=\\S)(.+?)(?<=\\S)(?<!_)_(?![\\w_])/.source
      ].join('|'), 'g');
      let offset = 0;
      for (const match of text.matchAll(pattern)) {
        target.appendChild(document.createTextNode(text.slice(offset, match.index)));
        if (match[1]) {
          const code = document.createElement('code');
          code.textContent = match[2];
          target.appendChild(code);
        } else {
          const combined = match[3] || match[4];
          const strongContent = match[5] || match[6];
          const emphasisContent = match[7] || match[8];
          if (combined) {
            const strong = document.createElement('strong');
            const emphasis = document.createElement('em');
            appendInline(emphasis, combined);
            strong.appendChild(emphasis);
            target.appendChild(strong);
          } else if (strongContent) {
            const strong = document.createElement('strong');
            appendInline(strong, strongContent);
            target.appendChild(strong);
          } else if (emphasisContent) {
            const emphasis = document.createElement('em');
            appendInline(emphasis, emphasisContent);
            target.appendChild(emphasis);
          }
        }
        offset = match.index + match[0].length;
      }
      target.appendChild(document.createTextNode(text.slice(offset)));
    }

    function flattenOptions(options) {
      if (!Array.isArray(options)) return [];
      return options.flatMap(entry => entry && Array.isArray(entry.options) ? entry.options : [entry]);
    }

    function supportedConfigOptions(options) {
      if (!Array.isArray(options)) return [];
      return options.filter(option =>
        option && option.id && (option.type === 'select' || option.type === 'boolean')
      );
    }

    function configValueLabel(option) {
      if (option.type === 'boolean') return option.currentValue === true ? 'On' : 'Off';
      const selected = flattenOptions(option.options).find(choice =>
        choice && choice.value === option.currentValue
      );
      return String(selected?.name || selected?.value || option.currentValue || 'Unset');
    }

    function toolContentText(value) {
      if (!value || typeof value !== 'object') return '';
      if (typeof value.text === 'string') return value.text;
      if (value.content && typeof value.content.text === 'string') return value.content.text;
      if (typeof value.diff === 'string') return value.diff;
      if (typeof value.output === 'string') return value.output;
      return '';
    }

    function toolIcon(kind) {
      return ({ read: 'R', edit: 'E', delete: 'D', move: 'M', search: '⌕', execute: '›', think: '·', fetch: '↗' })[kind] || '◇';
    }

    function relativeTime(value) {
      const timestamp = Date.parse(value);
      if (!Number.isFinite(timestamp)) return '';
      const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
      if (seconds < 60) return 'now';
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
      if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
      if (seconds < 604800) return Math.floor(seconds / 86400) + 'd';
      return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    function dayLabel(value) {
      const date = new Date(value);
      const today = new Date();
      if (date.toDateString() === today.toDateString()) return 'Today';
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
      return 'Earlier';
    }

    function usageLabel(usage) {
      if (!usage || typeof usage !== 'object') return '';
      if (Number.isFinite(usage.used) && Number.isFinite(usage.size)) {
        const percent = usage.size ? Math.round(usage.used / usage.size * 100) : 0;
        return percent + '% context';
      }
      return '';
    }

    function autosizePrompt() {
      elements.prompt.style.height = 'auto';
      elements.prompt.style.height = Math.min(elements.prompt.scrollHeight, 180) + 'px';
    }

    document.getElementById('sessions-button').onclick = () => setDrawer(true);
    document.getElementById('new-button').onclick = () => post('show_start');
    document.getElementById('close-drawer').onclick = () => setDrawer(false);
    elements['drawer-backdrop'].onclick = () => setDrawer(false);
    elements['config-button'].onclick = () => setConfigOpen(!configOpen);
    document.getElementById('drawer-new').onclick = () => { setDrawer(false); post('show_start'); };
    document.getElementById('refresh-sessions').onclick = () => post('refresh_sessions');
    document.getElementById('install-button').onclick = () => {
      const agent = selectedAgent();
      if (agent) post('install', { agent_id: agent.id });
    };
    elements.agent.onchange = () => {
      appState.selectedAgent = elements.agent.value;
      post('select_agent', { agent_id: elements.agent.value });
      renderAgentPicker();
    };
    elements['start-button'].onclick = () => {
      const agent = selectedAgent();
      if (agent) post('new_session', { agent_id: agent.id });
    };
    elements['browse-button'].onclick = () => {
      const agent = selectedAgent();
      if (agent) {
        setDrawer(true);
        post('browse_sessions', { agent_id: agent.id });
      }
    };
    elements['send-button'].onclick = submitPrompt;
    elements['stop-button'].onclick = () => post('cancel');
    elements.composer.ondragenter = event => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      imageDragDepth += 1;
      setImageDragActive(true);
    };
    elements.composer.ondragover = event => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect =
          appState.active?.status === 'ready' && imagePromptsSupported()
            ? 'copy'
            : 'none';
      }
      setImageDragActive(true);
    };
    elements.composer.ondragleave = event => {
      if (!dragHasFiles(event)) return;
      imageDragDepth = Math.max(0, imageDragDepth - 1);
      if (imageDragDepth === 0) setImageDragActive(false);
    };
    elements.composer.ondrop = event => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files || []);
      resetImageDrag();
      void addImageFiles(files);
    };
    elements.composer.ondragend = resetImageDrag;
    elements['attach-button'].onclick = () => elements['image-input'].click();
    elements['image-input'].onchange = () => {
      void addImageFiles(elements['image-input'].files);
      elements['image-input'].value = '';
    };
    elements.prompt.oninput = () => {
      if (slashDismissedValue !== elements.prompt.value) {
        slashDismissedValue = undefined;
      }
      attachmentError = undefined;
      autosizePrompt();
      elements['send-button'].disabled = !canSubmitPrompt(appState.active);
      updateSlashMenu(appState.active);
    };
    elements.prompt.onpaste = event => {
      const files = Array.from(event.clipboardData?.files || [])
        .filter(file => String(file.type || '').startsWith('image/'));
      if (!files.length) return;
      event.preventDefault();
      void addImageFiles(files);
    };
    elements.prompt.onkeydown = event => {
      if (slashMatches.length) {
        const unmodified = !event.metaKey && !event.ctrlKey && !event.altKey;
        if (event.key === 'ArrowDown' && unmodified) {
          event.preventDefault();
          moveSlashSelection(1);
          return;
        }
        if (event.key === 'ArrowUp' && unmodified) {
          event.preventDefault();
          moveSlashSelection(-1);
          return;
        }
        if (event.key === 'Tab' && unmodified && !event.shiftKey) {
          event.preventDefault();
          acceptSlashCommand();
          return;
        }
        if (event.key === 'Enter' && unmodified && !event.shiftKey) {
          event.preventDefault();
          acceptSlashCommand();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          dismissSlashMenu();
          return;
        }
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submitPrompt();
      }
    };
    elements.prompt.onselect = () => updateSlashMenu(appState.active);
    elements.prompt.onfocus = () => updateSlashMenu(appState.active);
    elements.prompt.onblur = () => {
      slashMatches = [];
      slashSelected = 0;
      drawSlashMenu();
    };

    window.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !configOpen) return;
      event.preventDefault();
      setConfigOpen(false);
      elements['config-button'].focus();
    });

    window.addEventListener('dragover', event => {
      if (dragHasFiles(event)) event.preventDefault();
    });
    window.addEventListener('drop', event => {
      if (!dragHasFiles(event)) return;
      event.preventDefault();
      if (!elements.composer.contains(event.target)) resetImageDrag();
    });

    window.addEventListener('message', ({ data }) => {
      if (data.type !== 'app_state') return;
      appState = data.state || appState;
      scheduleRender();
    });
    post('ready');
  </script>
</body>
</html>`;
}

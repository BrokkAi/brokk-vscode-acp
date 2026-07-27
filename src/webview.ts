import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export function webviewHtml(webview: vscode.Webview): string {
  const nonce = randomBytes(18).toString("base64");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
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
    .main { position: relative; width: 100%; min-width: 0; min-height: 0; overflow: hidden; }
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
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr) auto;
      width: 100%;
      min-width: 0;
      height: 100%;
      overflow: hidden;
    }
    .session-toolbar {
      min-height: 38px;
      display: flex;
      align-items: center;
      gap: 4px;
      width: 100%;
      padding: 5px 10px;
      overflow: visible;
      border-bottom: 1px solid var(--muted-border);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    }
    .config-bar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
      min-width: 0;
      max-width: 100%;
      overflow: visible;
    }
    .config-control {
      position: relative;
      display: inline-flex;
      min-width: 0;
      flex: none;
    }
    .config-control::after {
      content: "⌄";
      position: absolute;
      top: 50%;
      right: 7px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      line-height: 1;
      pointer-events: none;
      transform: translateY(-57%);
    }
    .config-control select {
      width: var(--config-control-width, 72px);
      min-width: 66px;
      max-width: 220px;
      min-height: 26px;
      height: 26px;
      padding: 2px 21px 2px 8px;
      overflow: hidden;
      appearance: none;
      border: 1px solid var(--muted-border);
      border-radius: 5px;
      color: var(--vscode-foreground);
      background: transparent;
      cursor: pointer;
      font-size: 11px;
      font-weight: 550;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .config-control:hover select {
      border-color: var(--border);
      background: var(--vscode-toolbar-hoverBackground, var(--accent-soft));
    }
    .config-control select:focus {
      border-color: var(--vscode-focusBorder);
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .config-toggle {
      display: flex;
      align-items: center;
      gap: 4px;
      min-height: 26px;
      max-width: 130px;
      padding: 2px 7px;
      overflow: hidden;
      border: 1px solid var(--muted-border);
      border-radius: 5px;
      color: var(--vscode-foreground);
      background: transparent;
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .config-toggle:hover {
      border-color: var(--border);
      background: var(--vscode-toolbar-hoverBackground, var(--accent-soft));
    }
    .transcript {
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
    .plan {
      margin: 7px 0 12px;
      padding: 9px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
    }
    .plan-title {
      margin-bottom: 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 10.5px;
      font-weight: 650;
      letter-spacing: .3px;
      text-transform: uppercase;
    }
    .plan-item {
      display: grid;
      grid-template-columns: 16px 1fr;
      gap: 4px;
      margin: 4px 0;
      font-size: 11.5px;
    }
    .plan-item.completed { color: var(--vscode-descriptionForeground); }
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
      width: 100%;
      min-width: 0;
      padding: 8px 9px 9px;
      background: linear-gradient(transparent, var(--vscode-sideBar-background, var(--vscode-editor-background)) 10px);
    }
    .composer {
      width: 100%;
      max-width: 720px;
      margin: 0 auto;
      overflow: hidden;
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 7px;
      background: var(--vscode-input-background);
    }
    .composer:focus-within { border-color: var(--vscode-focusBorder); }
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
      .config-bar { display: none; }
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
          <div id="config-bar" class="config-bar"></div>
        </div>
        <div id="transcript" class="transcript"><div id="transcript-inner" class="transcript-inner"></div></div>
        <div class="composer-wrap">
          <div class="composer">
            <textarea id="prompt" rows="2" placeholder="Ask the agent…"></textarea>
            <div class="composer-footer">
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
      'install-row', 'start-button', 'browse-button', 'config-bar', 'transcript',
      'transcript-inner', 'prompt', 'composer-hint', 'send-button', 'stop-button', 'banner',
      'auth-card', 'drawer', 'drawer-backdrop', 'session-list', 'drawer-footer'
    ].map(id => [id, document.getElementById(id)]));
    let appState = { agents: [], selectedAgent: '', connection: { phase: 'idle' }, sessions: [] };
    let drawerOpen = false;
    let renderPending = false;
    const expandedEntries = new Set();

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
        renderTranscript(active);
        renderComposer(active);
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
      const bar = elements['config-bar'];
      bar.replaceChildren();
      for (const option of Array.isArray(options) ? options : []) {
        if (!option || !option.id) continue;
        if (option.type === 'select') {
          const wrapper = document.createElement('label');
          wrapper.className = 'config-control';
          const select = document.createElement('select');
          select.setAttribute('aria-label', option.name || option.id);
          const choices = flattenOptions(option.options).filter(choice =>
            choice && typeof choice.value === 'string'
          );
          for (const choice of choices) {
            const node = document.createElement('option');
            node.value = choice.value;
            node.textContent = compactConfigValue(choice);
            node.selected = choice.value === option.currentValue;
            select.appendChild(node);
          }
          syncConfigControl(wrapper, select, option, choices);
          select.onchange = () => {
            syncConfigControl(wrapper, select, option, choices);
            post('set_config', {
              config_id: option.id,
              value: { value: select.value }
            });
          };
          wrapper.appendChild(select);
          bar.appendChild(wrapper);
        } else if (option.type === 'boolean') {
          const label = document.createElement('label');
          label.className = 'config-toggle';
          label.title = option.name || option.id;
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = option.currentValue === true;
          checkbox.onchange = () => post('set_config', {
            config_id: option.id,
            value: { type: 'boolean', value: checkbox.checked }
          });
          const copy = document.createElement('span');
          copy.textContent = option.name || option.id;
          label.append(checkbox, copy);
          bar.appendChild(label);
        }
      }
    }

    function renderTranscript(active) {
      const viewport = elements.transcript;
      const nearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 90;
      const inner = elements['transcript-inner'];
      inner.replaceChildren();
      if (!active.entries?.length) {
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
        for (const entry of active.entries) inner.appendChild(renderEntry(entry, active.status));
      }
      if (nearBottom) viewport.scrollTop = viewport.scrollHeight;
    }

    function renderEntry(entry, sessionStatus) {
      const wrapper = document.createElement('div');
      wrapper.className = 'entry ' + entry.kind;
      wrapper.dataset.entryId = entry.id;
      if (entry.kind === 'user') {
        const bubble = document.createElement('div');
        bubble.className = 'user-bubble';
        bubble.textContent = entry.text || '';
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
      if (entry.kind === 'plan') {
        wrapper.appendChild(renderPlan(entry));
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

    function renderPlan(entry) {
      const plan = document.createElement('div');
      plan.className = 'plan';
      const heading = document.createElement('div');
      heading.className = 'plan-title';
      heading.textContent = 'Plan';
      plan.appendChild(heading);
      for (const item of Array.isArray(entry.plan) ? entry.plan : []) {
        const row = document.createElement('div');
        row.className = 'plan-item ' + (item?.status || '');
        const marker = document.createElement('span');
        marker.textContent = item?.status === 'completed' ? '✓' : item?.status === 'in_progress' ? '●' : '○';
        const copy = document.createElement('span');
        copy.textContent = item?.content || item?.title || 'Plan item';
        row.append(marker, copy);
        plan.appendChild(row);
      }
      return plan;
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

    function renderComposer(active) {
      const running = active.status === 'running';
      const ready = active.status === 'ready';
      elements.prompt.disabled = false;
      elements['send-button'].classList.toggle('hidden', running);
      elements['stop-button'].classList.toggle('hidden', !running);
      elements['send-button'].disabled = !ready || !elements.prompt.value.trim();
      elements['composer-hint'].textContent = usageLabel(active.usage) || (running ? 'Agent is working…' : '⌘↵ to send');
    }

    function submitPrompt() {
      const text = elements.prompt.value.trim();
      if (!text || appState.active?.status !== 'ready') return;
      post('prompt', { text });
      elements.prompt.value = '';
      autosizePrompt();
      elements['send-button'].disabled = true;
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
      const pattern = /\`([^\`]+)\`/g;
      let offset = 0;
      for (const match of text.matchAll(pattern)) {
        target.appendChild(document.createTextNode(text.slice(offset, match.index)));
        const code = document.createElement('code');
        code.textContent = match[1];
        target.appendChild(code);
        offset = match.index + match[0].length;
      }
      target.appendChild(document.createTextNode(text.slice(offset)));
    }

    function flattenOptions(options) {
      if (!Array.isArray(options)) return [];
      return options.flatMap(entry => entry && Array.isArray(entry.options) ? entry.options : [entry]);
    }

    function compactConfigValue(choice) {
      let value = String(choice.name || choice.value || '');
      value = value.replace(/^Default\\s*\\(([^)]+)\\)$/i, 'Default · $1');
      return value;
    }

    function syncConfigControl(wrapper, select, option, choices) {
      const selected = choices.find(choice => choice.value === select.value);
      const fullValue = selected ? String(selected.name || selected.value) : select.value;
      const compactValue = selected ? compactConfigValue(selected) : select.value;
      const label = option.name || option.id;
      wrapper.title = label + ': ' + fullValue;
      const width = Math.min(220, Math.max(66, Math.ceil(compactValue.length * 6.35 + 39)));
      select.style.setProperty('--config-control-width', width + 'px');
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
    elements.prompt.oninput = () => {
      autosizePrompt();
      elements['send-button'].disabled = appState.active?.status !== 'ready' || !elements.prompt.value.trim();
    };
    elements.prompt.onkeydown = event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submitPrompt();
      }
    };

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

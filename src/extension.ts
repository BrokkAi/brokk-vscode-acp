import * as path from "node:path";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as readline from "node:readline";
import * as vscode from "vscode";

type HostEvent = { type: string; [key: string]: unknown };

class RustHost implements vscode.Disposable {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly events = new vscode.EventEmitter<HostEvent>();
  private readonly output = vscode.window.createOutputChannel("Brokk ACP");
  readonly onEvent = this.events.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  connect(): void {
    if (this.child) {
      return;
    }
    const config = vscode.workspace.getConfiguration("brokkAcp");
    const override = config.get<string>("host.path", "").trim();
    const executable = override || this.defaultExecutable();
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspace) {
      throw new Error("Open a workspace before connecting to an ACP agent.");
    }

    const child = spawn(executable, [], { cwd: workspace, stdio: "pipe" });
    this.child = child;
    child.on("error", (error) => {
      this.events.fire({ type: "error", message: `Rust host failed: ${error.message}` });
      if (this.child === child) {
        this.child = undefined;
      }
    });
    child.on("exit", (code, signal) => {
      this.events.fire({ type: "disconnected", code, signal });
      if (this.child === child) {
        this.child = undefined;
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      this.output.append(text);
      this.events.fire({ type: "log", text });
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        this.events.fire(JSON.parse(line) as HostEvent);
      } catch {
        this.events.fire({ type: "error", message: `Invalid host output: ${line}` });
      }
    });

    this.send({
      type: "connect",
      command: config.get<string>("agent.command", "anvil"),
      args: config.get<string[]>("agent.args", []),
      cwd: workspace,
    });
  }

  send(command: object): void {
    if (!this.child) {
      throw new Error("Not connected to the Rust host.");
    }
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  disconnect(): void {
    const child = this.child;
    if (child) {
      child.stdin.write(`${JSON.stringify({ type: "disconnect" })}\n`, () => child.stdin.end());
      const forceKill = setTimeout(() => child.kill(), 1_000);
      forceKill.unref();
      child.once("exit", () => clearTimeout(forceKill));
      this.child = undefined;
    }
  }

  dispose(): void {
    this.disconnect();
    this.events.dispose();
    this.output.dispose();
  }

  private defaultExecutable(): string {
    const name = process.platform === "win32" ? "brokk-acp-host.exe" : "brokk-acp-host";
    const packaged = path.join(this.context.extensionPath, "bin", `${process.platform}-${process.arch}`, name);
    const development = path.join(this.context.extensionPath, "target", "debug", name);
    return this.context.extensionMode === vscode.ExtensionMode.Development ? development : packaged;
  }
}

class ChatView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly host: RustHost) {
    this.subscription = host.onEvent((event) => this.view?.webview.postMessage(event));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = chatHtml();
    view.webview.onDidReceiveMessage(async (message) => {
      try {
        if (message.type === "connect") {
          this.host.connect();
        } else if (message.type === "prompt") {
          this.host.send({ type: "prompt", text: message.text });
        } else if (message.type === "cancel") {
          this.host.send({ type: "cancel" });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(message);
      }
    });
  }

  dispose(): void {
    this.subscription.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const host = new RustHost(context);
  const chat = new ChatView(host);
  context.subscriptions.push(
    host,
    chat,
    vscode.window.registerWebviewViewProvider("brokkAcp.chat", chat),
    vscode.commands.registerCommand("brokkAcp.connect", () => host.connect()),
    vscode.commands.registerCommand("brokkAcp.disconnect", () => host.disconnect()),
  );
}

function chatHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); padding: 12px; }
    #status { color: var(--vscode-descriptionForeground); margin-bottom: 10px; }
    #messages { display: flex; flex-direction: column; gap: 9px; margin: 12px 0; white-space: pre-wrap; }
    .message { border-left: 3px solid var(--vscode-focusBorder); padding-left: 9px; }
    .thought { color: var(--vscode-descriptionForeground); font-style: italic; }
    textarea { box-sizing: border-box; width: 100%; min-height: 80px; resize: vertical; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); padding: 8px; }
    .actions { display: flex; gap: 8px; margin-top: 8px; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 6px 12px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div id="status">Disconnected</div>
  <button id="connect">Connect</button>
  <div id="messages"></div>
  <textarea id="prompt" placeholder="Ask the agent…"></textarea>
  <div class="actions"><button id="send">Send</button><button id="cancel">Stop</button></div>
  <script>
    const vscode = acquireVsCodeApi();
    const status = document.getElementById('status');
    const messages = document.getElementById('messages');
    const prompt = document.getElementById('prompt');
    let assistant;
    document.getElementById('connect').onclick = () => vscode.postMessage({ type: 'connect' });
    document.getElementById('send').onclick = () => {
      const text = prompt.value.trim();
      if (!text) return;
      const user = document.createElement('div');
      user.className = 'message'; user.textContent = 'You\n' + text; messages.appendChild(user);
      assistant = document.createElement('div'); assistant.className = 'message'; assistant.textContent = 'Agent\n'; messages.appendChild(assistant);
      vscode.postMessage({ type: 'prompt', text }); prompt.value = '';
    };
    document.getElementById('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
    window.addEventListener('message', ({ data }) => {
      if (data.type === 'connecting') status.textContent = 'Connecting to ' + data.command + '…';
      if (data.type === 'connected') status.textContent = 'Connected to ' + (data.agent || 'ACP agent');
      if (data.type === 'session_started') status.textContent += ' · session ' + data.session_id;
      if (data.type === 'message_chunk') { if (!assistant) { assistant = document.createElement('div'); assistant.className = 'message'; messages.appendChild(assistant); } assistant.textContent += data.text; }
      if (data.type === 'thought_chunk') { const node = document.createElement('div'); node.className = 'thought'; node.textContent = data.text; messages.appendChild(node); }
      if (data.type === 'turn_completed') status.textContent = 'Ready · ' + data.stop_reason;
      if (data.type === 'error') { status.textContent = 'Error'; const node = document.createElement('div'); node.textContent = data.message; messages.appendChild(node); }
      if (data.type === 'disconnected') status.textContent = 'Disconnected';
    });
  </script>
</body>
</html>`;
}

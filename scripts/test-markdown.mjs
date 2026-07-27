import assert from "node:assert/strict";
import vm from "node:vm";
import { resolve } from "node:path";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: [resolve("src/webview.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  plugins: [
    {
      name: "vscode-test-stub",
      setup(context) {
        context.onResolve({ filter: /^vscode$/ }, () => ({
          path: "vscode",
          namespace: "vscode-test-stub",
        }));
        context.onLoad({ filter: /.*/, namespace: "vscode-test-stub" }, () => ({
          contents: "export {};",
          loader: "js",
        }));
      },
    },
  ],
});

const source = bundle.outputFiles[0].text;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const { webviewHtml } = await import(moduleUrl);
const html = webviewHtml({ cspSource: "vscode-webview://markdown-test" });
const rendererStart = html.indexOf("    function renderMarkdown");
const rendererEnd = html.indexOf("    function flattenOptions", rendererStart);
assert.ok(rendererStart >= 0 && rendererEnd > rendererStart, "markdown renderer is missing");

const context = {
  document: {
    createElement,
    createTextNode,
  },
};
vm.createContext(context);
vm.runInContext(
  `${html.slice(rendererStart, rendererEnd)}
globalThis.renderMarkdownForTest = renderMarkdown;`,
  context,
);

assert.equal(renderInline("**Anvil Recap**"), "<p><strong>Anvil Recap</strong></p>");
assert.equal(renderInline("*Stop: completed*"), "<p><em>Stop: completed</em></p>");
assert.equal(
  renderInline("Before **bold with _italics_ and `code`** after."),
  "<p>Before <strong>bold with <em>italics</em> and <code>code</code></strong> after.</p>",
);
assert.equal(
  renderInline("`**literal markers**` and session_start_notice"),
  "<p><code>**literal markers**</code> and session_start_notice</p>",
);
assert.equal(
  renderInline("***bold italics*** and ___also both___"),
  "<p><strong><em>bold italics</em></strong> and <strong><em>also both</em></strong></p>",
);
assert.equal(
  renderInline("Unmatched **markers and *stay visible"),
  "<p>Unmatched **markers and *stay visible</p>",
);

const recap = createElement("div");
context.renderMarkdownForTest(
  recap,
  [
    "**Anvil Recap**",
    "",
    "- Updated `src/acp.rs` for successful sessions.",
    "- *Stop: completed*.",
    "- *Tools: 24 calls (23 succeeded, 1 failed)*.",
    "- *Files changed: src/acp.rs*.",
  ].join("\n"),
);
assert.equal(
  serialize(recap),
  [
    "<div>",
    "<p><strong>Anvil Recap</strong></p>",
    "<ul>",
    "<li>Updated <code>src/acp.rs</code> for successful sessions.</li>",
    "<li><em>Stop: completed</em>.</li>",
    "<li><em>Tools: 24 calls (23 succeeded, 1 failed)</em>.</li>",
    "<li><em>Files changed: src/acp.rs</em>.</li>",
    "</ul>",
    "</div>",
  ].join(""),
);

console.log("Markdown emphasis tests passed");

function renderInline(markdown) {
  const target = createElement("div");
  context.renderMarkdownForTest(target, markdown);
  return target.childNodes.map(serialize).join("");
}

function createElement(tagName) {
  return {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    childNodes: [],
    appendChild(child) {
      this.childNodes.push(child);
      return child;
    },
    set textContent(value) {
      this.childNodes = [createTextNode(value)];
    },
    get textContent() {
      return this.childNodes.map((child) => child.textContent).join("");
    },
  };
}

function createTextNode(value) {
  return {
    nodeType: 3,
    textContent: String(value),
  };
}

function serialize(node) {
  if (node.nodeType === 3) {
    return escapeHtml(node.textContent);
  }
  const tag = node.tagName.toLowerCase();
  return `<${tag}>${node.childNodes.map(serialize).join("")}</${tag}>`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

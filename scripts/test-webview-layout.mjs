import assert from "node:assert/strict";
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
const html = webviewHtml({ cspSource: "vscode-webview://layout-test" });

const mainStyles = cssRule(html, ".main");
assert.match(
  mainStyles,
  /height:\s*100%/,
  "the session containing block must have a definite height",
);
assert.match(mainStyles, /min-height:\s*0/, "the main grid row must be allowed to shrink");
assert.match(mainStyles, /overflow:\s*hidden/, "content must remain inside the webview");

const sessionStyles = cssRule(html, ".session-view");
assert.match(
  sessionStyles,
  /position:\s*absolute/,
  "the session must be pinned to the webview containing block",
);
assert.match(sessionStyles, /inset:\s*0/, "the session must fill the containing block");
assert.match(
  sessionStyles,
  /grid-template-rows:\s*auto auto minmax\(0,\s*1fr\) auto/,
  "only the transcript row may consume remaining height",
);
assert.match(sessionStyles, /min-height:\s*0/, "the session grid must be allowed to shrink");
assert.match(sessionStyles, /overflow:\s*hidden/, "the session must clip overflowing children");

const transcriptStyles = cssRule(html, ".transcript");
assert.match(
  transcriptStyles,
  /overflow-y:\s*auto/,
  "long content must scroll inside the transcript row",
);
assert.match(transcriptStyles, /min-height:\s*0/, "the transcript row must be shrinkable");

const sessionMarkup = html.slice(
  html.indexOf('<section id="session-view"'),
  html.indexOf('<div id="banner"'),
);
assert.ok(
  sessionMarkup.indexOf('id="transcript"') < sessionMarkup.indexOf('class="composer-wrap"'),
  "the composer must remain after the scrollable transcript",
);

console.log("Webview layout containment tests passed");

function cssRule(value, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = value.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `missing ${selector} CSS rule`);
  return match[1];
}

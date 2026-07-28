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
const script = html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)?.[1];
assert.ok(script, "the webview must include its client script");
assert.doesNotThrow(
  () => new Function(script),
  "the generated webview client script must remain valid JavaScript",
);

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
  /display:\s*flex/,
  "the loaded session must use a column layout that preserves intrinsic controls",
);
assert.match(
  sessionStyles,
  /flex-direction:\s*column/,
  "the session toolbar, transcript, and composer must remain vertically ordered",
);
assert.match(sessionStyles, /min-height:\s*0/, "the session layout must be allowed to shrink");
assert.match(sessionStyles, /overflow:\s*hidden/, "the session must clip overflowing children");

const transcriptStyles = cssRule(html, ".transcript");
assert.match(
  transcriptStyles,
  /flex:\s*1 1 0/,
  "only the transcript may consume or release remaining session height",
);
assert.match(
  transcriptStyles,
  /overflow-y:\s*auto/,
  "long content must scroll inside the transcript row",
);
assert.match(transcriptStyles, /min-height:\s*0/, "the transcript row must be shrinkable");

for (const selector of [".session-toolbar", ".config-panel", ".plan-dock", ".composer-wrap"]) {
  assert.match(
    cssRule(html, selector),
    /flex:\s*none/,
    `${selector} must retain its intrinsic height when a loaded transcript is long`,
  );
}

const sessionMarkup = html.slice(
  html.indexOf('<section id="session-view"'),
  html.indexOf('<div id="banner"'),
);
assert.ok(
  sessionMarkup.indexOf('id="session-toolbar"') <
    sessionMarkup.indexOf('id="config-panel"') &&
    sessionMarkup.indexOf('id="config-panel"') < sessionMarkup.indexOf('id="transcript"'),
  "the session configuration editor must expand between its summary and the transcript",
);
assert.ok(
  sessionMarkup.indexOf('id="transcript"') < sessionMarkup.indexOf('class="composer-wrap"'),
  "the composer must remain after the scrollable transcript",
);
assert.match(
  sessionMarkup,
  /id="config-summary"[\s\S]+aria-controls="config-panel"/,
  "session options must be summarized behind a single configuration action",
);
assert.match(
  sessionMarkup,
  /id="config-panel"[\s\S]+id="config-editor"/,
  "the full option controls must live in the dedicated configuration editor",
);
assert.ok(
  !sessionMarkup.includes('id="config-bar"'),
  "session option controls must not remain permanently visible in the toolbar",
);

const toolbarStyles = cssRule(html, ".session-toolbar");
assert.match(
  toolbarStyles,
  /overflow:\s*hidden/,
  "long session configuration summaries must not widen the sidebar",
);

const panelStyles = cssRule(html, ".config-panel");
assert.match(
  panelStyles,
  /max-height:\s*min\(55vh,\s*420px\)/,
  "the configuration editor must not consume the entire chat height",
);
assert.match(
  panelStyles,
  /overflow-y:\s*auto/,
  "large configuration sets must scroll inside the editor",
);

console.log("Webview layout containment tests passed");

function cssRule(value, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = value.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `missing ${selector} CSS rule`);
  return match[1];
}

# GroveMd

I don't think this is a *googd* idea

&#8203;

GroveMd is a local-first Markdown workspace for writing directly from the files
you already own. Open a local folder in the browser, write in a Typora-style
live Markdown editor, and keep the source as plain `.md` files instead of
pushing notes through an app-specific storage model.

⁠![GroveMd local-first Markdown workspace](docs/grovemd-workspace.png)

GroveMd is built for a small set of workflows that should stay simple:

- **Local first**: grant access to a folder, edit Markdown in place, autosave
locally, and keep images beside the document in normal workspace assets.
- **Easy sync**: keep working from the local folder or connect Dropbox when a
cloud-backed workspace is useful.
- **No app install**: run the editor as a web app while still using browser
file access for real local files.
- **Collaboration**: share a single file link through the Grove relay so guests
can co-edit without access to the owner's local folder or Dropbox workspace.
- **Instant live Markdown**: headings, tables, task lists, code fences, KaTeX,
Mermaid, and images render inline while the document remains editable.

Under the GroveMd app, this repository contains CodeMirror Tree-sitter, a
Lezer-free CodeMirror 6 workspace backed by Tree-sitter through
`web-tree-sitter`. It reimplements the editor-facing CodeMirror packages that
normally depend on Lezer and publishes them under the
`@codemirror-treesitter/*` scope so they can be installed beside the official
`@codemirror/*` packages.

The repository also contains LiveMD, a Tree-sitter-powered Markdown editor that
ships as both a programmatic editor API and a `<live-md-editor>` web component,
plus demo and benchmark apps for comparing behavior, performance, and
collaboration flows.

## Current Stack

- **Runtime and package manager**: Bun `1.3.14` through Vite+ `vp install`,
with Node.js `>=26.0.0` required by the workspace.
- **Toolchain**: Vite+ (`vp`) wraps Vite, Rolldown, Vitest, tsdown, Oxlint,
Oxfmt, and Vite Task. Root formatting, linting, type-aware checks, task
caching, and shared aliases are configured in `vite.config.ts`.
- **Language and build config**: TypeScript 6.x, native TypeScript preview
dependencies in packages, ES modules everywhere, shared `tsconfig.*` files,
and package builds through `vp pack`.
- **Editor foundation**: Official `@codemirror/state`, `@codemirror/view`,
`@codemirror/search`, and `@codemirror/lint` remain direct dependencies where
Lezer is not part of the contract.
- **Parser layer**: `web-tree-sitter`, Tree-sitter grammar packages, bundled
WASM assets, highlight queries, incremental reparsing, and included ranges
for nested languages.
- **Markdown product layer**: LiveMD composes the local language, commands,
autocomplete, basic setup, language-data, and Gruvbox theme packages with
KaTeX, Mermaid, and `beautiful-mermaid`.
- **Collaboration and workspace layer**: Optional LiveMD Loro bindings use
`loro-crdt` and `loro-codemirror`. Grove's local workspace app supports local
folders, Dropbox through the OpenDAL browser WASM wrapper, local image
assets, and shared-file hosting. Grove's relay runs as the `grove-relay`
Cloudflare Worker with Durable Object persistence, WebSocket sync, Wrangler,
and the Cloudflare Vite plugin. The `collab-editor` app remains a separate
Cloudflare collaboration demo.

## Quickstart


```html
<body>
  <live-md-editor autofocus placeholder="Start writing..."></live-md-editor>
  <script type="module">
    import "@codemirror-treesitter/live-md/register";
  </script>
</body>
```

A single import registers the `<live-md-editor>` web component with
Tree-sitter-powered Markdown parsing, syntax highlighting, live Markdown
decorations, Shadow DOM styling, and Gruvbox theming. See
[Web Component](#web-component) for the full API.

The programmatic API exposes the same runtime without custom elements:


```ts
import { createLiveMdEditor } from "@codemirror-treesitter/live-md";

const editor = createLiveMdEditor({
  parent: document.body,
  placeholder: "Start writing...",
});

await editor.ready;
```

## What This Project Implements

- A Tree-sitter-backed replacement for the CodeMirror language layer, including
`Language`, `LanguageSupport`, `LRLanguage`, `ParseContext`, syntax tree
wrappers, language data facets, mixed-language parsing, highlighting,
indentation, folding, bracket matching, bidi isolates, and stream-parser
compatibility.
- A language-data registry that mirrors CodeMirror language metadata while
lazily loading Tree-sitter WASM grammars and highlight queries.
- Lezer-free implementations of CodeMirror commands, autocompletion, close
brackets, basic setup, merge views, LSP integration, and Gruvbox themes.
- LiveMD, a Markdown editor runtime built from the local Tree-sitter packages,
exposed through `createLiveMdEditor()`, `liveMarkdown()`,
`liveMdCodeFenceHighlighting()`, `defineLiveMdEditor()`, and
`<live-md-editor>`.
- Optional LiveMD collaboration bindings for Loro documents, presence, custom
text containers, and collaborative undo/redo.
- Validation tooling and apps that check public export parity, package
dependency boundaries, language-data coverage, example coverage, benchmark
coverage, and runtime behavior against official CodeMirror/Lezer packages.

The implementation packages intentionally do not depend on Lezer. The examples
app is the comparison surface and is allowed to depend on official CodeMirror
and Lezer packages so it can compare local behavior with upstream behavior side
by side.

## Architecture

The workspace keeps the official CodeMirror editor primitives where Lezer is
not part of the contract: `@codemirror/state`, `@codemirror/view`,
`@codemirror/search`, and `@codemirror/lint` are used directly. The packages in
this repository replace the language-aware layers above those primitives.

1. **Tree-sitter language runtime**:
`@codemirror-treesitter/language` adapts `web-tree-sitter` into
CodeMirror's language interfaces. It owns parser scheduling, incremental
parsing, syntax-tree wrappers, nested parsing, syntax highlighting,
indentation, folding, bracket matching, bidi isolation, and stream-parser
support.
2. **Language registry**:
`@codemirror-treesitter/language-data` builds `LanguageDescription` entries
on top of the language runtime. Each entry owns aliases, filename and
extension metadata, WASM grammar loading, optional highlight-query loading,
language data, and nested parser setup.
3. **Editor feature packages**:
`commands`, `autocomplete`, `merge`, and `lsp-client` reimplement the
CodeMirror feature packages that need syntax information. They depend on the
local language runtime instead of `@codemirror/language` or Lezer.
4. **Assembly and styling**:
`basic-setup` assembles a CodeMirror setup from local feature packages, and
`theme-gruvbox` provides editor themes and highlight styles using local
highlight tags.
5. **Product surface**:
`live-md` composes the local packages into a Markdown editor with live block
widgets, code-fence highlighting, KaTeX and Mermaid rendering, Shadow DOM
web component integration, persistence, selection APIs, and benchmark
fixtures.
6. **Workspace and collaboration surface**:
`live-md-loro` provides optional CRDT bindings, `apps/local-md-workspace`
provides the Grove local/Dropbox Markdown workspace and shared-file host or
guest UI, `apps/grove-relay` hosts Grove shared-file relay APIs with
Cloudflare Durable Objects and WebSocket transport, and `apps/collab-editor`
remains a separate shareable collaborative editor demo.

## Workspace Structure

| Path              | Purpose                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `package.json`    | Private Bun/Vite+ workspace, catalog versions, root scripts, and engine constraints.                  |
| `vite.config.ts`  | Shared Vite+ config for aliases, formatting, linting, type-aware checks, and run caching.             |
| `vite.shared.ts`  | Workspace import aliases used by packages and apps during local development.                          |
| `tsconfig*.json`  | Shared TypeScript settings for package and app builds.                                                |
| `packages/*`      | Workspace `@codemirror-treesitter/*` implementation and experimental packages.                        |
| `apps/*`          | Local browser, benchmark, comparison, Grove, relay, demo, and Cloudflare collaboration apps.          |
| `tools/audit.mjs` | Repository audit for package names, Lezer-free boundaries, upstream parity, coverage, and app wiring. |
| `bun.lock`        | Bun lockfile generated by `vp install`.                                                               |

## Packages

| Directory                       | Package                                       | Role                                                                                                                            |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/language`             | `@codemirror-treesitter/language`             | Tree-sitter parser integration and CodeMirror-compatible language infrastructure.                                               |
| `packages/language-data`        | `@codemirror-treesitter/language-data`        | Lazy language metadata, Tree-sitter WASM loading, highlight-query loading, and mixed-language parser wiring.                    |
| `packages/commands`             | `@codemirror-treesitter/commands`             | Cursor movement, selection, deletion, indentation, commenting, history, and keymaps.                                            |
| `packages/autocomplete`         | `@codemirror-treesitter/autocomplete`         | Completion contexts, sources, results, tooltip UI, filtering, snippets, word completion, and close brackets.                    |
| `packages/codemirror`           | `@codemirror-treesitter/basic-setup`          | `basicSetup` and `minimalSetup` assembled from the local Tree-sitter packages.                                                  |
| `packages/theme-gruvbox`        | `@codemirror-treesitter/theme-gruvbox`        | Gruvbox dark/light editor themes, highlight styles, combined extensions, and palettes.                                          |
| `packages/merge`                | `@codemirror-treesitter/merge`                | Diff, split merge view, unified merge view, chunks, and accept/reject commands.                                                 |
| `packages/lsp-client`           | `@codemirror-treesitter/lsp-client`           | LSP client, workspace mapping, diagnostics, completions, hover, formatting, rename, definition, references, and signature help. |
| `packages/live-md`              | `@codemirror-treesitter/live-md`              | Live Markdown editor runtime, web component, registration entry, fixtures, and CSS export.                                      |
| `packages/live-md-loro`         | `@codemirror-treesitter/live-md-loro`         | Optional Loro collaboration bindings for LiveMD documents, presence, custom text containers, and collaborative undo/redo.       |
| `packages/opendal-wasm-browser` | `@codemirror-treesitter/opendal-wasm-browser` | Experimental browser WASM wrapper for OpenDAL-backed cloud workspace storage.                                                   |

Each package directory has its own README with local responsibilities, public
entry points, dependency boundaries, source layout, and validation notes.

## Apps and Tools

- `apps/basic-editor`: Minimal Tree-sitter-only editor that imports
`@codemirror-treesitter/live-md/register` and renders one
`<live-md-editor>` element.
- `apps/local-md-workspace`: Grove React, Vite+, shadcn/radix local-first
Markdown workspace that opens a browser-granted local folder, edits `.md`
files with LiveMD, supports Dropbox storage through OpenDAL WASM and OAuth
PKCE, supports image insert/paste/drop through sibling `assets/` directories,
supports file/folder create, rename, delete, tree browsing, and autosave, and
can host or join Grove shared-file sessions through `apps/grove-relay`.
- `apps/grove-relay`: Grove shared-file relay Worker with Durable Object
persistence, share create/session/rotate/revoke APIs, WebSocket Loro sync,
bounded relay queues, share expiration cleanup, and Wrangler deploy/types
tasks.
- `apps/examples`: Side-by-side workbench comparing the local Tree-sitter
implementation with official CodeMirror/Lezer behavior on parser-relevant
examples, package coverage, merge/LSP behavior, and benchmark metrics.
- `apps/live-md-benchmark`: LiveMD performance benchmark harness for rendering,
editing, deletion, clipboard, and selection workflows.
- `apps/live-md-loro-demo`: Two-peer LiveMD collaboration demo with simulated
latency, offline queueing, and Loro snapshot resync.
- `apps/collab-editor`: Cloudflare Workers app with a Durable Object room,
WebSocket Loro sync, local snapshot recovery, hash-based room URLs,
standalone share lifecycle APIs, and deployment/types tasks through Wrangler.
- `tools/audit.mjs`: Repository audit that checks package names, Lezer-free
guarantees, public export parity, command and autocomplete stubs, basic setup
parity, language-data metadata/load coverage, example coverage, merge/LSP
usage, and benchmark app wiring.

## Web Component

The `<live-md-editor>` custom element wraps a Tree-sitter-backed CodeMirror
Markdown editor in Shadow DOM. Import the register entry point once, then use
the element anywhere in your HTML.


```ts
import "@codemirror-treesitter/live-md/register";
import "@codemirror-treesitter/live-md/style.css";
```

### Attributes

| Attribute       | Type    | Description                                                                    |
| --------------- | ------- | ------------------------------------------------------------------------------ |
| `autofocus`     | boolean | Focus the editor when it connects to the DOM.                                  |
| `default-value` | string  | Initial Markdown content. If omitted, trimmed light-DOM `textContent` is used. |
| `persist-key`   | string  | `localStorage` key for persisting editor content.                              |
| `placeholder`   | string  | Placeholder text when the editor is empty.                                     |
| `readonly`      | boolean | Disable editing while keeping content selectable/readable.                     |

### Properties

| Property         | Type                | Description                                                  |
| ---------------- | ------------------- | ------------------------------------------------------------ |
| `value`          | `string`            | Current Markdown content, read/write.                        |
| `defaultValue`   | `string`            | Initial content, read/write.                                 |
| `persistKey`     | `string | null`     | `localStorage` key, read/write.                              |
| `placeholder`    | `string`            | Placeholder text, read/write.                                |
| `readOnly`       | `boolean`           | Whether the editor is read-only, read/write.                 |
| `dirty`          | `boolean`           | Whether content has changed since `markClean()`.             |
| `selectionStart` | `number`            | Selection anchor position, read/write.                       |
| `selectionEnd`   | `number`            | Selection head position, read/write.                         |
| `view`           | `EditorView | null` | The underlying CodeMirror `EditorView` instance.             |
| `extensions`     | `Extension`         | Optional CodeMirror extensions configured from JavaScript.   |
| `ready`          | `Promise<void>`     | Resolves after Markdown and code-fence languages are loaded. |

### Methods

| Method                          | Description                                       |
| ------------------------------- | ------------------------------------------------- |
| `focus()`                       | Focus the editor.                                 |
| `blur()`                        | Blur the editor.                                  |
| `markClean()`                   | Mark current content as clean, resetting `dirty`. |
| `setSelectionRange(start, end)` | Programmatically set the selection range.         |
| `select()`                      | Select all content.                               |

### Events

| Event           | Detail      | Description                                                   |
| --------------- | ----------- | ------------------------------------------------------------- |
| `input`         | -           | Fires on every content change and bubbles through Shadow DOM. |
| `change`        | -           | Fires after blur when content changed since the last blur.    |
| `live-md-ready` | `{ view }`  | Fires when async editor setup completes.                      |
| `live-md-error` | `{ error }` | Fires if editor initialization or async setup fails.          |
| `select`        | -           | Fires when the selection changes through user selection APIs. |

### CSS Custom Properties

The editor styles are installed into the Shadow DOM and can be themed with CSS
custom properties on the host element.

| Property                | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `--live-md-bg`          | Editor background.                                             |
| `--live-md-text`        | Primary text color.                                            |
| `--live-md-muted`       | Secondary text and widget label color.                         |
| `--live-md-accent`      | Primary accent for links, checks, focus, and Mermaid defaults. |
| `--live-md-accent-2`    | Secondary accent used by the caret and emphasis details.       |
| `--live-md-border`      | Border color for widgets and block surfaces.                   |
| `--live-md-code-bg`     | Code block and inline-code background.                         |
| `--live-md-code-text`   | Code text color.                                               |
| `--live-md-code-muted`  | Code gutter/header muted color.                                |
| `--live-md-code-border` | Code block border color.                                       |
| `--live-md-font-body`   | Markdown body font stack.                                      |
| `--live-md-font-ui`     | UI and widget label font stack.                                |
| `--live-md-font-code`   | Code font stack.                                               |
| `--live-md-mermaid-*`   | Optional Mermaid-specific color and font overrides.            |

## Programmatic API


```ts
import { createLiveMdEditor, liveMdCodeFenceHighlighting } from "@codemirror-treesitter/live-md";
import { gruvboxDarkHighlightStyle } from "@codemirror-treesitter/theme-gruvbox";

const imageAssetUrlMap = new Map<string, string>();
const controller = createLiveMdEditor({
  parent: document.body,
  defaultValue: "# Draft",
  imageSource(source) {
    return imageAssetUrlMap.get(source) ?? source;
  },
  linkBaseUrl: "https://docs.example/notes/current.md",
  placeholder: "Start writing...",
  persistKey: "draft",
  extensions: [liveMdCodeFenceHighlighting(gruvboxDarkHighlightStyle)],
  onChange({ value }) {
    console.log(value);
  },
});

await controller.ready;
controller.setReadOnly(false);
controller.setValue("# Updated");
controller.destroy();
```

`createLiveMdEditor()` accepts `value`, `doc`, `defaultValue`, `persistKey`,
`placeholder`, `readOnly`, `autofocus`, `focus`, `root`, `extensions`,
`imageSource`, `linkBaseUrl`, `onChange`, and `onBlur`. `imageSource` maps
normalized Markdown image destinations to preview URLs, which host apps can use
for local blob URLs or uploaded assets. `linkBaseUrl` is used to resolve
relative Markdown links for Shift-click link jumps. The controller exposes
`view`, `value`, `ready`, `setValue()`, `setExtensions()`, `setPersistKey()`,
`setPlaceholder()`, `setReadOnly()`, and `destroy()`.
`liveMdCodeFenceHighlighting(...)` can be passed through `extensions` to align
fenced code token colors with a host theme.

## Optional Loro Collaboration

Install `@codemirror-treesitter/live-md-loro` when a LiveMD editor should bind
to a Loro CRDT document. The default LiveMD package does not import Loro.


```ts
import { createLiveMdEditor } from "@codemirror-treesitter/live-md";
import { liveMdLoroCollaboration } from "@codemirror-treesitter/live-md-loro";
import { LoroDoc } from "loro-crdt";

const doc = new LoroDoc();
doc.getText("markdown").insert(0, "# Shared document");
doc.commit();

createLiveMdEditor({
  parent: document.body,
  extensions: [liveMdLoroCollaboration({ doc })],
});
```

Web Component users opt in through the JavaScript-only `extensions` property:


```ts
const editor = document.createElement("live-md-editor");
editor.extensions = [liveMdLoroCollaboration({ doc })];
document.body.append(editor);
```

The collaboration helper also supports custom Loro text containers, presence
through `EphemeralStore`, and optional Loro undo managers.

## Implementation Notes

- Tree-sitter incremental reparsing edits the previous `Tree` with CodeMirror
change data and passes the edited tree back into `Parser.parse(...)`.
- Parsing honors CodeMirror-style time budgets through Tree-sitter's
`progressCallback`, allowing large parses to stop and resume.
- Mixed-language parsing uses Tree-sitter `includedRanges` for nested regions.
HTML and Vue currently nest JavaScript in `<script>` blocks and CSS in
`<style>` blocks, and nested parser sources can defer async parser loads via
`ParseContext.getSkippingParser(...)`.
- `language-data` lazy-loads grammar WASM files and published highlight
queries, so `LanguageDescription.load()` only resolves assets needed for the
selected language.
- The syntax tree wrapper preserves CodeMirror-facing names such as `Tree`,
`SyntaxNode`, `NodeType`, and `TreeCursor`, while exposing
Tree-sitter-backed navigation, status, field, descendant, and error helpers.
- `HighlightStyle`, `syntaxHighlighting`, `tags`, and `tagHighlighter` are
implemented locally and map Tree-sitter capture names into CodeMirror-style
highlight tags.
- Indentation, folding, bracket matching, bidi isolates, comment tokens, and
stream-parser language support are implemented without Lezer.
- Some upstream `language-data` entries that only have legacy stream modes are
covered with compact in-repo grammar/style shims.
- `grove-relay` persists Durable Object snapshots and bounded update logs for
Grove shared files. `collab-editor` keeps the separate generated-room demo
behavior.

## Parity Targets

The goal is source-compatible behavior for the CodeMirror surfaces this
workspace reimplements, not identical internals. `tools/audit.mjs` enforces the
main contract:

- `@codemirror-treesitter/language` exports every public name from upstream
`@codemirror/language`'s index and exposes local Tree-sitter highlight
helpers.
- `@codemirror-treesitter/commands` exports every public name from upstream
`@codemirror/commands`, `comment`, and `history`, and does not leave known
no-op command placeholders.
- `@codemirror-treesitter/autocomplete` exports every public name from upstream
`@codemirror/autocomplete`, and does not leave known completion-context
placeholders.
- `@codemirror-treesitter/basic-setup` matches upstream `basicSetup`,
`minimalSetup`, and basic keymap ordering.
- `@codemirror-treesitter/language-data` mirrors upstream language metadata and
all built language entries load a parser.
- `@codemirror-treesitter/theme-gruvbox` exports both dark and light Gruvbox
themes and imports syntax highlighting from the local Tree-sitter language
package.
- `@codemirror-treesitter/merge` and
`@codemirror-treesitter/lsp-client` expose upstream-compatible public
surfaces and use the local Tree-sitter language/highlighting packages.
- Parser-relevant official examples are implemented in `apps/examples` or
explicitly classified as out of scope.

## Development

Use Vite+ from the workspace root:


```bash
vp install
vp check
vp run -r test
vp run -r build
vp run audit
```

The root script `vp run ready` runs the full local validation path:


```bash
vp run ready
```

Useful task selectors:


```bash
vp run @codemirror-treesitter/language#test
vp run @codemirror-treesitter/live-md#build
vp run @codemirror-treesitter/opendal-wasm-browser#auth:dropbox-token
vp run @codemirror-treesitter/opendal-wasm-browser#validate:dropbox
vp run local-md-workspace#dev
vp run local-md-workspace#test
vp run local-md-workspace#smoke:ui
vp run grove-relay#dev
vp run grove-relay#test
vp run grove-relay#types
vp run examples#dev
vp run live-md-benchmark#benchmark
vp run live-md-loro-demo#dev
vp run collab-editor#dev
vp run collab-editor#test
vp run collab-editor#types
```

`vp run` with no task lists all available package and app tasks.

`vp run local-md-workspace#dev` starts both the local Markdown workspace
frontend and the local `apps/grove-relay` shared-file relay. The default relay
origin is `http://127.0.0.1:8787`, and the frontend receives it through
`VITE_LOCAL_MD_SHARE_RELAY_ORIGIN`. Run `vp dev` from
`apps/local-md-workspace` or `vp run local-md-workspace#dev:frontend` only when
you intentionally want the frontend without the local relay. To test against a
deployed relay in local dev, pass
`vp run local-md-workspace#dev -- --relay-origin <deployed relay origin>`.

Production Grove deploys use the Cloudflare Pages project `grove` at
`https://app.grovemd.net`, with `https://grovemd.net` redirecting to that app
origin, and the `grove-relay` Worker custom domain at
`https://relay.grovemd.net`. The Grove CI/CD workflow enforces
`VITE_DROPBOX_REDIRECT_URI=https://app.grovemd.net/` for Dropbox OAuth and
builds the frontend against the relay custom domain. CI deploys the relay Worker
with `apps/grove-relay/wrangler.worker.ci.jsonc`; the custom-domain route is kept
in `apps/grove-relay/wrangler.worker.jsonc` for one-time provisioning by a token
with zone route permissions.

`vp run local-md-workspace#smoke:ui` expects the local Markdown workspace dev
server to be running at `http://127.0.0.1:5173/` by default. Start that dev
server with a Dropbox app key, for example
`VITE_DROPBOX_APP_KEY=smoke-dropbox-app`, so the credential-free mock Dropbox
workspace smoke can enter through the normal OAuth UI. It runs without cloud
credentials for the local workspace and mock Dropbox workspace checks. To include
the credential-gated real Dropbox app flow, set
`LOCAL_MD_WORKSPACE_DROPBOX_ACCESS_TOKEN` or `OPENDAL_DROPBOX_ACCESS_TOKEN`;
`LOCAL_MD_WORKSPACE_DROPBOX_ROOT` can limit the temporary smoke file to a
specific Dropbox workspace root. These access-token variables are only for local
smoke tests that need to exercise real Dropbox file IO. They are not product
configuration, are not required for collaboration, and do not replace the
app's Dropbox OAuth flow. Set `CHROME_PATH` if Chromium is not available in a
standard app path or the Playwright browser cache.

## Documentation Map

- `AGENTS.md`: contributor and coding-agent workflow, stack snapshot,
validation expectations, package boundaries, and app task notes.
- `packages/*/README.md`: package-local API, source layout, dependencies, and
validation commands.
- `packages/live-md-loro/README.md`: optional collaboration binding docs.
- `packages/opendal-wasm-browser/README.md`: browser OpenDAL WASM wrapper API,
build commands, and validation notes.
- `packages/opendal-wasm-browser/PLAN.md`: cloud workspace integration plan.
- `apps/local-md-workspace/COLLABORATION_PLAN.md`: owner-backed single-file
collaboration plan, Dropbox workspace semantics, and cleanup/implementation
phases.
- This README: repository-level architecture, workspace structure, apps, and
LiveMD web component/API reference.
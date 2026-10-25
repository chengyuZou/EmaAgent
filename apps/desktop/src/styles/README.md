# Desktop styles

[中文](./README-zh.md)

These styles connect Desktop pages to the shared UI theme and adapt third-party viewers. The shared design variables, reset, animations, and reusable component styles come from [the UI package](../../../../src/ui/styles/index.css). Desktop-specific layout and state rules live here.

## Loading

`index.css` imports the shared UI styles first, Desktop domain styles next, and global third-party styles and adapters last. Both window entries load this stylesheet.

There are two additional loading cases:

- `TerminalPanel.tsx` imports xterm's own stylesheet with the terminal component.
- File trees and diff viewers render inside shadow roots. Page CSS cannot reach their contents. Trees receive `vendors/fileTree.css` as an inline string through `unsafeCSS`; Review and file tools share the diff CSS exported by Builtin Tools.

Do not move a shadow-root adapter into the global import list and expect it to style the viewer.

## Find the relevant rule

| Change | Location |
| --- | --- |
| Colors, fonts, spacing, shared animations, or reusable UI skins | `src/ui/styles/foundation` or `src/ui/styles/primitives` at the repository root |
| Main window title bar, navigation rail, and hidden views | `domains/main.css` |
| Session sidebar, workspace tabs, and resize feedback | `domains/workspace.css` |
| Chat history, input, tool rows, or tool terminal output | The corresponding `domains/chat*.css`, `toolRow.css`, or `terminalCard.css` |
| Wallpaper opacity, blur, and material surfaces | `material.css`, `materialSurfaces.css`, `chatMaterial.css`, and `wallpaper.css` |
| Memory, storage, stage, files, or review | The matching domain file |
| Third-party class names or shadow-root tree content | `vendors` |

Simple local layout can stay in TSX utility classes. Put grouped state selectors, pseudo-elements, masks, animations, and third-party adapters in the relevant stylesheet. Use shared theme variables for ordinary UI colors and dimensions. Hue gradients and explicit image/viewer geometry have their own values where the behavior needs them.

## Boundaries that matter

### Hidden views and resizing

Chat and Settings remain mounted. An inactive view keeps its layout size, hides both visibility and opacity, and is made inert by the component. This avoids recalculating message positions and textarea height from a zero-sized view. Native browser WebViews still need explicit visibility calls; CSS only hides page content.

The session sidebar disables its width transition during pointer resizing. Workspace panels do the same for the proportion written by `react-resizable-panels`. Reintroducing a size transition during dragging makes the separator lag behind the pointer. Expand/collapse transitions resume after dragging ends.

### Chat and tool content

Chat Markdown wraps long lines within the content column. Tool input also wraps and is limited to 8rem in height.

Tool output preserves its line structure unless its chosen viewer provides wrapping. Each text result, Markdown document, progress message, and error uses an explicit `.ema-tool-text-scroll` region. The region scrolls on both axes as needed and uses `--ema-tool-body-max-height`, normally `min(60vh, 24rem)`. Input regions use 8rem and wrap long lines. `.ema-tool-result-details` supplies padding independently of scrolling.

Standalone `CodeViewer`, HTML, diff, and terminal viewers own their scroll areas. `ToolPane` only arranges content and its toolbar; it never selects a scroll policy by looking for descendants. A code fence inside Markdown therefore leaves the document's scroll bounds intact. A result followed by an error has two independent regions, so their combined height may exceed one region's limit. Narrative timelines also keep separate viewers. Adding a plain-text result branch requires an explicit text scroll region, including when another branch returns a viewer.

`ToolCallBlock` owns the title, status, duration, and expansion. `ToolPane` owns the input/output toolbar and copy control. Tool-specific `UI.tsx` supplies content. Embedded code viewers do not add another title and copy toolbar.

Read source views and new-file Write results share code typography and line-number gutters. Write passes the full created content to `CodeViewer`; its summary stays in the output toolbar. Toolbar labels stay on one line, summaries wrap within the remaining width, and actions keep their width. The toolbar does not scroll with the document.

Collapsible long bodies stay mounted for the closing animation, then release the loaded content. Review diff heights follow the viewer's virtual layout rather than an additional height animation.

Turn failures use `.ema-turn-error` after the reply and tool content. They wrap as plain text and are separate from tool-output scrolling.

### Materials and images

`material.css` defines fill and blur parameters; `materialSurfaces.css` applies them to structural surfaces and overlays. Nested cards do not each add blur. Background alpha is separate from container opacity so text and images are not faded with the background.

Only the main window loads the wallpaper image. Stage bubbles, permission cards, and menus use local material classes. They share theme settings without loading a wallpaper or changing the stage document's material attributes.

Image replacement waits for the new image to be ready. Outgoing and active image states have separate animation rules so rapid selections do not leave a blank surface.

### Third-party viewers

Review, workspace files, and Memory share the tree adapter and the dependency patch described in [patches](../../../../patches/README.md). The whole tree viewport owns horizontal scrolling, not individual rows.

Code colors follow `--ema-syntax-*`. The highlight adapter keeps its background transparent so the containing code surface controls the fill. Inline code follows paragraph line height rather than the block-code line height.

## Check a style change

Run the Desktop build to catch CSS and import errors. Then inspect the real page in light and dark themes, narrow and wide windows, keyboard focus, and reduced-motion mode. For resize or native browser changes, test the Tauri window itself. A successful build does not prove that scrolling, transitions, or native visibility feel correct.

Run `pnpm --filter @ema-agent/desktop test:tool-scroll` for the opt-in browser regression. It renders real tool cards and Desktop styles with static results, checks horizontal and vertical scrolling at two widths, and blocks application-backend and external requests. It uses installed Edge on Windows and Playwright Chromium on other platforms. It does not start the native application or require model credentials.

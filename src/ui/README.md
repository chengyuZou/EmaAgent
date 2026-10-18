# UI

[中文](./README-zh.md)

Shared React controls, overlays, content renderers and theme styles for the desktop app and tool result views. Callers pass values and content through props, then handle callbacks such as `onChange` and `onSelect`. The package also provides browser-level theme helpers and Provider icon lookup.

## Use in an application

Import components from `@ema-agent/ui` and theme helpers from `@ema-agent/ui/utils`.

```tsx
import { CodeViewer, Markdown, TooltipProvider } from '@ema-agent/ui';

<TooltipProvider>
  <Markdown source={'# Report\n\nCompleted.'} />
  <CodeViewer source={'{"completed":true}'} language="json" />
</TooltipProvider>
```

Components do not automatically load the application's styles. In this workspace, [Desktop styles](../../apps/desktop/src/styles/index.css) import `src/ui/styles/index.css`, and the application loads `virtual:uno.css`. Entries that display formulas also need `katex/dist/katex.min.css`.

[Desktop's UnoCSS configuration](../../apps/desktop/uno.config.ts) shows the actual setup: `emaSharedPreset`, `emaSharedTheme`, `emaSharedShortcuts` and `emaSharedSafelist` from `@ema-agent/ui/uno.config`, plus application icon collections and source scanning. Include the shared component sources in the scan, not just the application's own files. A complete literal class such as `w-[500px]` can be scanned; a class assembled from runtime values needs a safelist entry or another explicit style.

The shared CSS loads theme variables and base rules before component styles. It includes fonts, surfaces, colors, focus indicators, overlays, scrolling, Markdown and reduced-motion rules. App-specific layouts load afterward.

## Controls and callbacks

| Entry | Important contract |
| --- | --- |
| Button, IconButton | Default to `type="button"`. Loading disables activation. IconButton requires a readable `label`; tooltips are supplied separately. |
| Field | Takes one control and adds its label, description and error associations. A custom child must forward `id` and `aria-*` to the actual focusable element. |
| FilePicker | Enhances one button and returns browser `File[]` through `onSelect`. Native input state is cleared so selecting the same file again still triggers a change. Native path selection belongs to the host's dialog flow. |
| Dialog | Requires either a visible `title` or `ariaLabel`. ConfirmDialog and PromptDialog use it for confirmation and text entry. |
| Tooltip, Popover, DropdownMenu | Trigger children must accept DOM refs and events. Use `triggerTooltip` for menu and Popover hints, rather than replacing their trigger with a second button. |
| Select, Combobox | Callers supply stable option values. Combobox skips disabled options during keyboard navigation; `allowFreeText` writes typed text directly. Filtered results are not virtualized. |
| Slider, Tabs, Progress | Unknown selections and invalid numbers have explicit empty or fallback states. Slider calls `onChange` during movement and optional `onCommit` when the value is committed. |

TooltipProvider defaults to a 200 ms hover delay. Tooltip content is read-only; use Popover for interactive content. A disabled or empty Tooltip keeps its child unchanged. Dropdown menus scroll within the available window height, and submenus open by click rather than hover.

Textarea measures content and width changes to maintain its automatic height. CursorFloating updates transforms and CSS variables directly during mouse movement; entrance animations must be on an outer element so their transforms do not override the tilt.

## Markdown and media

`Markdown` receives source text and optional `streaming`. Its normal rendering order is:

```text
Markdown, GFM, math and fence tokens
  -> raw HTML
  -> sanitization
  -> KaTeX and code highlighting
  -> React elements and Mermaid blocks
```

Raw HTML cannot supply layout classes, IDs, inline styles or event handlers. Code language classes remain available for highlighting. Mermaid fences are identified through the existing Markdown parser tokens, including fences inside lists or quotes.

`MarkdownRendererProvider` lets the host supply media components, link actions and a `urlTransform`. Supplied components override only their matching tags. The custom URL transform takes over protocol filtering for `href` and `src`, so it must reject script URLs and other unsupported protocols. Other HTML sanitization remains enabled. Local file loading and navigation happen in the host's handlers.

`MarkdownLink` preserves link behavior and displays the address through Tooltip. The default renderer and Desktop's custom links share it. Place TooltipProvider above those renderers.

While streaming, an unclosed Mermaid fence shows source and a waiting state. Once the message is complete, an EOF-terminated fence may also render.

## Mermaid rendering

A block approaching the viewport loads Mermaid and ELK on demand. Rendering waits for document fonts and uses a temporary DOM container for text measurement. The container is removed afterward.

Mermaid initialization and rendering run together in a serial queue because initialization changes shared configuration. The cache key contains the block ID, source and resolved theme; at most 50 entries retain pending or completed results, including failures. Different blocks do not share SVG strings containing element IDs.

The renderer uses strict SVG sanitization and does not bind diagram script callbacks. Protected diagram settings cannot override the application's theme or safety settings. Parse or layout failures show source with an error message. Theme changes redraw the diagram; panel width changes only scale the resulting SVG through CSS.

Flowcharts use ELK with this project's node and arrow appearance. Other diagram types keep Mermaid's renderer. [The ELK adapter patch](../../patches/@mermaid-js__layout-elk@0.2.2.patch) passes node and rank spacing to the library; layout algorithms remain in the dependency.

## Read-only text and JSON

`CodeViewer` uses CodeMirror 6 for plain text or JSON. It receives the full source, renders the visible region and nearby lines, and copies the full source. `embedded` removes its outer title and copy controls. `wrapLines={false}` keeps horizontal and vertical scrolling in the same viewport.

Source changes update the existing editor; language and wrapping changes reconfigure it. Unmounting destroys the editor. Mount it when details open and unmount it when they close, rather than retaining hidden editors for every history item.

This reduces rendered DOM, not the size of API responses, parsed JSON or retained source strings.

## Themes and icons

`setThemeHue` and `setThemeRadius` update root CSS variables. Hue wraps to `[0, 360)`; radius is limited to `[0, 3]`. The caller saves preferences and restores them at startup. Light mode uses `data-theme="light"`; syntax color schemes use `data-syntax-theme`.

Provider icon identities map to classes in [the registry](./icons/providers/registry.ts). The exported safelist covers registered classes and the fallback. The host supplies icon collections and safelists additional user-selectable icons that static scanning cannot discover.

## Read and verify

Start with the component's props and callback flow, then its CSS rules. For content rendering, read Markdown, MermaidBlock, mermaidRender and CodeViewer together. The `components/*.stories.tsx` files provide interactive examples.

```bash
pnpm --filter @ema-agent/ui typecheck
pnpm --filter @ema-agent/ui test
pnpm --filter @ema-agent/ui build
pnpm --filter @ema-agent/ui ladle
```

Tests cover accessible names, field associations, selection boundaries, tooltips, automatic textarea sizing, Markdown sanitization, CodeViewer lifecycle and Mermaid queuing. The Mermaid integration test uses the real libraries but substitutes missing jsdom SVG measurements. Scrolling, colors, animations and native-window behavior still need browser or desktop verification.

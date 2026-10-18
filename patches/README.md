# Dependency patches

These patches change two installed dependencies used by the desktop interface. The root [package.json](../package.json) registers their exact versions under `pnpm.patchedDependencies`, and [pnpm-lock.yaml](../pnpm-lock.yaml) records the patch paths and hashes. pnpm applies them during dependency installation.

## File tree scrolling

[@pierre/trees 1.0.0-beta.6](./@pierre__trees@1.0.0-beta.6.patch) fixes viewport measurement and fractional-height scrolling in virtualized file trees.

The dependency measures the viewport to decide how far a focused row needs to scroll. Its original measurements include the native horizontal scrollbar, treating that space as available for rows. The last row can consequently remain partly hidden behind the scrollbar.

The patch changes two measurements in `dist/render/focusHelpers.js`:

- Direct measurements use `clientHeight` instead of `getBoundingClientRect().height`.
- ResizeObserver updates use `contentRect.height` instead of `borderBoxSize`.

It also adds this rule to the shared core styles in `dist/utils/cssWrappers.js`:

```css
:host([data-file-tree-virtualized="true"]) {
  max-height: round(down, 100%, 1px);
}
```

Rounding the maximum height down to a whole pixel addresses drawing jitter when scrolling at the bottom of a container with fractional height. Using `max-height` keeps the tree responsive to its parent without stretching a deliberately smaller tree or freezing a measured height.

The shared dependency styles apply this change to the desktop's [review tree](../apps/desktop/src/chat/sidePanel/tabs/review/reviewFileTree.tsx), [workspace tree](../apps/desktop/src/chat/sidePanel/tabs/files/workspaceFileTree.tsx), and [Memory tree](../apps/desktop/src/settings/memory/memoryFileTree.tsx).

## Mermaid ELK spacing

[@mermaid-js/layout-elk 0.2.2](./@mermaid-js__layout-elk@0.2.2.patch) passes Mermaid's node and layer spacing values to ELK. Without these assignments, changing the flowchart spacing does not reach the corresponding ELK layout options.

The patch adds two options to the layout configuration in the dependency's bundled renderer:

| Mermaid layout value | ELK option |
| --- | --- |
| `data4Layout.nodeSpacing` | `elk.spacing.nodeNode` |
| `data4Layout.rankSpacing` | `elk.layered.spacing.nodeNodeBetweenLayers` |

[mermaidRender.ts](../src/ui/components/mermaidRender.ts) loads the ELK renderer and supplies the application's flowchart defaults. The patch lets those settings, including supported diagram-level spacing overrides, affect the generated positions.

## Updating a patched dependency

Check whether the new upstream version fixes the same behavior before carrying a patch forward. Remove a patch that is no longer needed. Otherwise, regenerate it against the new version using pnpm's patch workflow; the bundled filenames and surrounding code may have changed.

Keep the patch file, root `pnpm.patchedDependencies` entry, and lockfile in sync through pnpm. Editing an installed `node_modules` file alone does not preserve the change for another installation or a release build.

For Mermaid, run:

```sh
pnpm --filter @ema-agent/ui test tests/mermaidRender.test.ts tests/mermaidIntegration.test.ts
```

The integration test uses the real Mermaid and ELK packages and checks that increasing `rankSpacing` changes node positions. Its simulated SVG text measurements do not establish visual correctness in a browser.

For Trees, check the actual desktop WebView with long filenames, a horizontal scrollbar, and fractional container heights. Scroll and move keyboard focus to the last row, then resize the panel and check that the row remains visible and the bottom does not jitter. Check Mermaid appearance in the actual page as well.


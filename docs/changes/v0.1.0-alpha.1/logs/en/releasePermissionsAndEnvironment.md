# Native theme permissions and Server environment

[中文](../zh/releasePermissionsAndEnvironment.md)

## Findings

The frontend called Tauri's native `setTheme` operation for both the main window and the character stage. Their capabilities did not grant `core:window:allow-set-theme`. The bridge also swallowed rejected calls, hiding the failure while the page's CSS theme changed.

The installed Server inherited its parent's Node environment. Release preparation tested with `NODE_ENV=production` and removed `NODE_OPTIONS` and `NODE_PATH`, but the native launcher did not apply those same rules. Server's rejection of the development-only Bash sandbox override depends on `NODE_ENV`.

These findings were confirmed from the call paths and focused checks. They are separate from the confirmed file-tree CSP failure; missing native theme permission is not presented as its cause.

## Changes

- Both [main](../../../../../apps/desktop/src-tauri/capabilities/main.json) and [stage](../../../../../apps/desktop/src-tauri/capabilities/stage.json) grant the specific native theme operation.
- [tauriBridge.ts](../../../../../apps/desktop/src/lib/tauri/tauriBridge.ts) propagates a rejected theme change. The theme store reports that failure without undoing the page's CSS theme.
- [child.rs](../../../../../apps/desktop/src-tauri/src/processes/child.rs) sets `NODE_ENV` from the native build: development for debug builds and production for release builds. Release children do not inherit `NODE_OPTIONS` or `NODE_PATH`, so a developer's loaders and module search paths do not change the installed Server.

The existing Server authentication, tool approval flow and Bash sandbox checks remain enabled. This change does not grant external browser panels access to application commands.

## Verification

Focused temporary checks confirmed both capability entries and propagation of a rejected native theme operation. A Rust release-mode test checked the constructed command's production environment and explicit removal of the two Node variables. Desktop and Server type checks passed.

The temporary checks were removed after use. This pass did not launch a rebuilt native host or installer. Native title-bar colors, startup from the user's usual environment and installed-app behavior still need manual verification. Frontend HMR alone cannot load these native changes.

## Follow-system theme regression

After native theme permission was enabled, selecting an explicit color and then selecting "Follow system" could retain that explicit color. For example, with a dark system theme, selecting light and then system left the page light. The reverse also occurred with a light system theme.

The theme store resolved `system` through `matchMedia('(prefers-color-scheme: dark)')` and passed the resulting light or dark value to Tauri. However, Tauri's Windows implementation also applies the window theme to WebView2. That changes the preference observed by `matchMedia`. The next system selection therefore read Ema's own override and wrote it back as another explicit override. The media-query listener repeated the same native write.

This changes the application's window and WebView appearance, not the Windows desktop theme. The newly granted permission exposed an existing incorrect argument; previously the native operation was rejected and its error was swallowed.

The [theme store](../../../../../apps/desktop/src/stores/theme.ts) now passes `null` for system mode, as required by [Tauri's window theme API](https://v2.tauri.app/reference/javascript/api/namespacewindow/#settheme). After that call completes, it reads the media query again if system mode is still selected. Later media-query changes update only the page, without saving settings, broadcasting them or setting another native override. Explicit light and dark selections still update the native window. The bridge accepts `null` and keeps reporting native failures.

A temporary test exercised the real theme store and Tauri bridge with a simulated native window and media query. Before the fix, both system-color cases failed: light was retained instead of dark, and dark instead of light. After the fix, all four checks passed, covering return from both explicit colors, later system changes without native writes, and explicit mode ignoring system changes. This is a simulated boundary check, not a native-window acceptance test. The temporary test file was deleted after verification.

The user subsequently confirmed in the Windows installed application that returning from either explicit color to system mode matched the system preference and that Ema's theme selection did not change Windows' theme. Changing the OS preference while Ema is following it was not tried and remains open. Native title-bar behavior, both-window coverage and the installed child's environment were not independently established by those checks. The exact installer identifier was not recorded. Frontend changes still require the earlier native theme capability to be present in the running host.

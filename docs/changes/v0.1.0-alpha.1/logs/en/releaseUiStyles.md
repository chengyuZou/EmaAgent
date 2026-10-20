# Release UI styles and Markdown media

[中文](../zh/releaseUiStyles.md)

## Problem

The installed application showed a dark file-tree panel even with the light theme selected. The same page looked correct in development. This affected the Memory file page's appearance, not its storage or maintenance behavior.

## Reproduction and cause

A temporary browser page rendered the actual Memory file tree, Diff view and xterm terminal. Development and a production Vite build both accepted their styles. Adding the style nonce that Tauri inserts during packaging reproduced the black tree panel. Its computed background changed from transparent to `rgb(20, 20, 21)`, and injected Diff and terminal style elements no longer had an accepted stylesheet.

The application allowed inline styles, but Tauri added a nonce to `style-src` and to bundled HTML styles. When a nonce is present, the browser ignores `unsafe-inline`. The libraries create additional style elements at runtime without that nonce, so those styles were blocked. The missing tree override exposed the library's own dark background.

## Change

[tauri.conf.json](../../../../../apps/desktop/src-tauri/tauri.conf.json) disables automatic asset CSP modification only for `style-src`. The explicit `style-src 'self' 'unsafe-inline'` remains in effect for the renderers' dynamic styles. Other directives still receive Tauri's normal processing.

JavaScript `unsafe-eval` remains disabled. The existing Live2D workaround and `wasm-unsafe-eval` permission remain unchanged. This is not a global CSP disable and does not grant file tools additional permissions.

`img-src` now accepts HTTP and HTTPS images for Markdown. `media-src` already accepted network audio and remains unchanged. Local Markdown audio continues through the authenticated Server audio route with byte-range support; it is not exposed through a general unauthenticated file URL.

## Verification

The temporary production browser check passed with the corrected policy. It verified the transparent tree override, accepted Diff and terminal styles, a remote Markdown image, and playback and seeking for local and remote Markdown audio. The media responses were test fixtures, with no external provider calls or user profile access.

The temporary check was removed after diagnosis and verification. It is not a persistent release gate. An expanded fixture containing the complete Settings panel did not complete because it omitted Cubism Core, which the normal application HTML loads. That attempt is not counted as a successful Settings-page check.

The user subsequently confirmed file preview/Diff highlighting, the Memory file page and the dedicated screen-capture sidebar entry in the Windows installed application. This supplements the earlier fixture checks without turning them into a complete media acceptance result. Real Markdown media and all related release styles still require verification. The exact installed build identifier was not recorded. Later reports of low-contrast chat-sidebar text and a native-looking HTML-preview scrollbar remain separate issues; these checks do not close them.

export const CAPTURE_DESCRIPTION = `Capture one screenshot of the user's display.

Takes no arguments. Does not select windows, crop, record video, or record audio.
Returns the screenshot and its saved local path in the current session's attachments.
Use when the task requires seeing the desktop, including identifying a covering window or investigating activation failure. Use ListWindows to obtain window ids and ObserveWindow to inspect a specific target.
This tool is independent of automatic screen capture settings and follows tool permission rules.`;

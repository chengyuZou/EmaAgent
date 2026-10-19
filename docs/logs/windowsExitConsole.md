# 0.1.0-alpha.1

## Problem

A console window briefly appeared when quitting the Windows release build. The development build did not show the same flash.

## Cause and change

The native host already used `CREATE_NO_WINDOW` when starting the Server. Its exit path started `taskkill` without that flag. A console-less GUI application can therefore create a console for its cleanup command.

[NativeProcessTree.terminate](../../apps/desktop/src-tauri/src/processes/platform/windows.rs) now prepares the `taskkill` command with the same no-window flag before starting it. Process-tree termination, child waiting, and the Job Object exit fallback remain in place.

The missing flag was confirmed in the implementation. Its effect on the originally reported flash still needs an installed-app check.

The later Dev/Release audit found another `taskkill` launch in [Sandbox's process runner](../../src/sandbox/process/processRunner.ts). It already hid the main command window, but not the command used to stop its process tree. That termination call now also sets `windowsHide: true`. This covers tool cancellation and Server shutdown cleanup without changing which process tree is stopped.

## Verification

The Windows Rust regression starts a real temporary child process, attaches it to the Job Object, and verifies that termination reaps it. Calling termination again after it exits also completes. Native release compilation passed.

The isolated native acceptance attempt did not confirm the expected exit log: the final assertion read empty log content. That attempt is not counted as a successful exit check, and the empty read alone does not establish a new shutdown defect.

Still to confirm with the rebuilt installer: quit the whole application, check that no console appears, and check that its Server process exits. Closing the main chat window only hides it and is not the same operation.

The Sandbox follow-up passed its temporary launch-option check and the existing real-process tests, including stopping a child tree and stopping a command when output storage fails. The temporary test file was removed after verification. The absence of a visible console flash still requires the installed-app check above.

use super::*;

#[test]
fn holds_selection_until_native_completion_and_allows_retry() {
    let state = FileDialogState::default();
    let selection = state.acquire().unwrap();
    assert!(state.acquire().is_err());
    drop(selection);
    assert!(state.acquire().is_ok());
}

#[test]
fn abandoned_receiver_does_not_release_the_native_selection() {
    let state = FileDialogState::default();
    let guard = state.acquire().unwrap();
    let (sender, receiver) = tokio::sync::oneshot::channel::<()>();
    let complete = move || {
        drop(guard);
        let _ = sender.send(());
    };
    drop(receiver);
    assert!(state.acquire().is_err());
    complete();
    assert!(state.acquire().is_ok());
}

#[test]
fn selection_defaults_to_one_file_and_accepts_explicit_folders() {
    let options: SelectPathsOptions = serde_json::from_str("{}").unwrap();
    assert!(!options.directory);
    assert!(!options.multiple);
    assert!(options.filters.is_empty());
    let folders: SelectPathsOptions =
        serde_json::from_str(r#"{"directory":true,"multiple":true}"#).unwrap();
    assert!(folders.directory);
    assert!(folders.multiple);
}

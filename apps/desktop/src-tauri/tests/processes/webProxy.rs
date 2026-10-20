use super::{configure_web_proxy, read_windows_proxy, SystemWebProxy};
use tokio::process::Command;

#[test]
fn web_proxy_serialization_matches_server_fields() {
    let settings = SystemWebProxy {
        proxy: "127.0.0.1:7890".into(),
        bypass: "<local>;*.example.test".into(),
        automatic: false,
        read_failed: false,
    };
    assert_eq!(
        serde_json::to_value(settings).unwrap(),
        serde_json::json!({
            "proxy": "127.0.0.1:7890",
            "bypass": "<local>;*.example.test",
            "automatic": false,
            "readFailed": false
        })
    );
}

#[test]
#[ignore = "Reads current-user Windows proxy settings without changing them"]
fn windows_proxy_is_passed_only_to_web_tools() {
    let settings = read_windows_proxy();
    assert!(!settings.read_failed);
    let mut command = Command::new("unused");
    configure_web_proxy(&mut command);
    let variables: Vec<_> = command.as_std().get_envs().collect();
    assert_eq!(variables.len(), 1);
    assert_eq!(variables[0].0, "EMA_WEB_SYSTEM_PROXY");
    let value: serde_json::Value =
        serde_json::from_str(variables[0].1.unwrap().to_str().unwrap()).unwrap();
    assert!(value["proxy"].is_string());
    println!(
        "Windows proxy read: fixed={}, automatic={}, bypass={}",
        !settings.proxy.is_empty(),
        settings.automatic,
        !settings.bypass.is_empty()
    );
}

#[test]
#[ignore = "Uses Node and built builtin-tools to GET the public Brave homepage through Windows proxy settings"]
fn windows_web_fetch_reaches_public_site() {
    let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut command = Command::new("node");
    command
        .args(["--input-type=module", "--eval"])
        .arg(
            r#"
            import { pathToFileURL } from 'node:url';
            const { closeWebRequests } = await import(pathToFileURL(process.argv[1]));
            const { fetchPublicPage } = await import(pathToFileURL(process.argv[2]));
            try {
                const page = await fetchPublicPage(
                    'https://search.brave.com/',
                    AbortSignal.timeout(15000),
                    { raw: true },
                );
                console.log(JSON.stringify({ receivedHTTP: true, status: page.status, bytes: page.bytes }));
            } catch (error) {
                const match = /^web\/http_(\d{3})$/.exec(error.code ?? '');
                console.log(JSON.stringify({ receivedHTTP: Boolean(match), code: error.code ?? error.name }));
                if (!match) process.exitCode = 1;
            } finally {
                await closeWebRequests();
            }
            "#,
        )
        .arg(workspace.join("src/builtin-tools/dist/tools/WebFetchTool/network/webRequests.js"))
        .arg(workspace.join("src/builtin-tools/dist/tools/WebFetchTool/network/httpClient.js"));
    // Exercise the native system settings, not an explicit proxy inherited by the test runner.
    for name in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ] {
        command.env_remove(name);
    }
    configure_web_proxy(&mut command);
    let output = command
        .as_std_mut()
        .output()
        .expect("Node must be installed for this opt-in test");
    println!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(
        output.status.success(),
        "Web request did not receive HTTP. {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

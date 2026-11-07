use super::*;
use crate::server::{ServerConnection, ServerProcess, State};
use tokio::io::AsyncWriteExt;

#[tokio::test]
async fn reads_only_ready_notifications_and_skips_oversized_output() {
    let (mut input, output) = tokio::io::duplex(128);
    let (sender, mut ready) = mpsc::unbounded_channel();
    let reader = tokio::spawn(read_output(output, sender));
    input
        .write_all(&vec![b'x'; MAX_CONTROL_LINE_BYTES + 1])
        .await
        .unwrap();
    input.write_all(b"\nordinary output\n").await.unwrap();
    input
        .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"server.ready\",\"params\":")
        .await
        .unwrap();
    input.write_all(b"{\"port\":4567}}\n").await.unwrap();
    input.shutdown().await.unwrap();
    assert_eq!(ready.recv().await, Some(4567));
    reader.await.unwrap().unwrap();
    assert_eq!(ready.recv().await, None);
}

#[tokio::test]
async fn starts_node_reads_its_port_and_terminates_the_process_tree() {
    let process = ServerProcess::new().unwrap();
    let mut spawned = spawn_server(
        ChildLaunch {
            executable: which::which("node").expect("Node is required for the Server process test"),
            args: vec![
                "-e".into(),
                "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'server.ready',params:{port:4567}})+'\\n'); setInterval(()=>{},1000);".into(),
            ],
            working_dir: std::env::temp_dir(),
        },
        "fake-control-secret-for-process-test",
        false,
        &process.0.process_tree,
    ).await.unwrap();
    let port = tokio::time::timeout(Duration::from_secs(10), spawned.ready.recv())
        .await
        .unwrap()
        .unwrap();
    *process.0.server.lock().await = Some(spawned.child);
    *process.0.output.lock().await = Some(spawned.output);
    *process.0.state.write().await = State::Ready(ServerConnection {
        port,
        secret: "fake-control-secret-for-process-test".into(),
    });
    tokio::time::timeout(Duration::from_secs(12), process.shutdown())
        .await
        .unwrap();
    assert!(process.0.server.lock().await.is_none());
    assert!(process.0.output.lock().await.is_none());
    assert!(matches!(*process.0.state.read().await, State::Stopped));
}

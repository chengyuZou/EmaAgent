use super::*;
use std::process::Stdio;

#[tokio::test]
async fn termination_reaps_a_running_windows_process() {
    let tree = NativeProcessTree::new().unwrap();
    let mut command = Command::new("cmd.exe");
    // 保持 stdin 打开让进程等待输入, 不依赖网络或机器上安装的开发工具.
    command.args(["/D", "/C", "set /p EMA_TEST_INPUT="]);
    command.stdin(Stdio::piped());
    command.stdout(Stdio::null());
    command.stderr(Stdio::null());
    command.kill_on_drop(true);
    tree.prepare_command(&mut command);
    let mut child = command.spawn().unwrap();
    tree.attach(child.id().unwrap()).unwrap();
    assert!(child.try_wait().unwrap().is_none());

    timeout(Duration::from_secs(10), tree.terminate(&mut child))
        .await
        .expect("process termination timed out");
    assert!(child.try_wait().unwrap().is_some());
    tree.terminate(&mut child).await;
}

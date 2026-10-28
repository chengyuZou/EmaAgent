mod types;

#[cfg(windows)]
mod windows;

use std::io::{self, BufRead, Write};
use std::sync::{mpsc, Arc};

use types::{Request, WireMessage};

fn main() {
    let (output, responses) = mpsc::channel::<WireMessage>();
    // 所有回应和状态通知都交给这个线程写 stdout, 避免两个线程把 JSON 写到同一行里.
    // 日志只能写 stderr, Node 会把 stdout 的每一行都当作 JSON 消息.
    let writer = std::thread::spawn(move || {
        let mut stdout = io::BufWriter::new(io::stdout().lock());
        for response in responses {
            if serde_json::to_writer(&mut stdout, &response).is_err()
                || stdout.write_all(b"\n").is_err()
                || stdout.flush().is_err()
            {
                break;
            }
        }
    });

    #[cfg(windows)]
    {
        match windows::ComputerUse::new(output.clone()) {
            Ok(computer) => {
                let computer = Arc::new(computer);
                let (commands, jobs) = mpsc::channel();
                let worker = computer.clone();
                let worker_thread = std::thread::spawn(move || worker.run(jobs));

                for line in io::stdin().lock().lines() {
                    let Ok(line) = line else { break };
                    let request = match serde_json::from_str::<Request>(&line) {
                        Ok(request) => request,
                        Err(error) => {
                            let _ =
                                output.send(WireMessage::error(None, -32700, &error.to_string()));
                            continue;
                        }
                    };
                    // 取消和结束在这里立即处理. 如果也排到工作线程后面, 它执行完才知道要停.
                    if computer.handle_control_request(&request) {
                        continue;
                    }
                    if commands.send(request).is_err() {
                        break;
                    }
                }

                computer.disconnect();
                drop(commands);
                let _ = worker_thread.join();
                computer.close_desktop_ui();
            }
            Err(error) => {
                let _ = output.send(WireMessage::error(None, -32000, &error));
            }
        }
    }

    #[cfg(not(windows))]
    for line in io::stdin().lock().lines().map_while(Result::ok) {
        let id = serde_json::from_str::<Request>(&line)
            .ok()
            .and_then(|request| request.id);
        let _ = output.send(WireMessage::error(
            id,
            -32000,
            "Computer use is supported on Windows only.",
        ));
    }

    drop(output);
    let _ = writer.join();
}

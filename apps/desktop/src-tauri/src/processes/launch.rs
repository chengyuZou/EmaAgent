// 解析开发环境与正式安装包中的 Server、Narrative Bridge 启动位置。
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

#[derive(Debug)]
pub struct ChildLaunch {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub working_dir: PathBuf,
}

pub fn resolve_server_launch(app: &AppHandle) -> Result<ChildLaunch, String> {
    if cfg!(debug_assertions) {
        let workspace = locate_workspace_root()?;
        return Ok(ChildLaunch {
            executable: which::which("pnpm")
                .map_err(|error| format!("pnpm not on PATH: {error}"))?,
            args: vec![
                "--filter".to_string(),
                "@ema-agent/server".to_string(),
                "dev".to_string(),
            ],
            working_dir: workspace,
        });
    }

    if let Ok(path) = std::env::var("EMA_SERVER_EXECUTABLE") {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|error| format!("resolve resource directory: {error}"))?;
        return server_launch(PathBuf::from(path), resource_dir.join("server").join("app"));
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("resolve resource directory: {error}"))?;
    let executable = std::env::current_exe()
        .map_err(|error| format!("resolve desktop executable: {error}"))?
        .parent()
        .map(|directory| directory.join(platform_executable_name("ema-server")))
        .ok_or_else(|| "desktop executable has no parent directory".to_string())?;
    server_launch(executable, resource_dir.join("server").join("app"))
}

pub fn resolve_narrative_launch(app: &AppHandle) -> Result<ChildLaunch, String> {
    if cfg!(debug_assertions) {
        return Ok(ChildLaunch {
            executable: which::which("uv").map_err(|error| format!("uv not on PATH: {error}"))?,
            args: vec!["run".to_string(), "ema-narrative-bridge".to_string()],
            working_dir: locate_workspace_root()?.join("bridges").join("narrative"),
        });
    }

    let executable = if let Ok(path) = std::env::var("EMA_NARRATIVE_BRIDGE_EXECUTABLE") {
        PathBuf::from(path)
    } else {
        app.path()
            .resource_dir()
            .map_err(|error| format!("resolve resource directory: {error}"))?
            .join("narrative-bridge")
            .join(platform_executable_name("ema-narrative-bridge"))
    };
    launch_existing(executable, Vec::new())
}

fn server_launch(executable: PathBuf, server_root: PathBuf) -> Result<ChildLaunch, String> {
    let entry = server_root.join("dist").join("main.js");
    if !entry.is_file() {
        return Err(format!(
            "bundled Server entry not found: {}",
            entry.display()
        ));
    }
    if !executable.is_file() {
        return Err(format!(
            "bundled Server executable not found: {}",
            executable.display()
        ));
    }
    Ok(ChildLaunch {
        executable,
        args: vec![entry.to_string_lossy().into_owned()],
        working_dir: server_root,
    })
}

fn launch_existing(executable: PathBuf, args: Vec<String>) -> Result<ChildLaunch, String> {
    if !executable.is_file() {
        return Err(format!(
            "executable does not exist: {}",
            executable.display()
        ));
    }
    let working_dir = executable
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("executable has no parent: {}", executable.display()))?;
    Ok(ChildLaunch {
        executable,
        args,
        working_dir,
    })
}

fn platform_executable_name(base: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

fn locate_workspace_root() -> Result<PathBuf, String> {
    let start =
        std::env::current_dir().map_err(|error| format!("read current directory: {error}"))?;
    start
        .ancestors()
        .find(|directory| directory.join("pnpm-workspace.yaml").is_file())
        .map(Path::to_path_buf)
        .ok_or_else(|| "workspace root not found".to_string())
}

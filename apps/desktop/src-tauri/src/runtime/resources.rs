// 解析开发命令与各平台安装包内的 Core、Bridge 可执行资源。
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use super::types::RuntimeService;

#[derive(Debug)]
pub struct ServiceLaunch {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub working_dir: PathBuf,
}

pub fn resolve_service_launch(
    app: &AppHandle,
    service: RuntimeService,
) -> Result<ServiceLaunch, String> {
    if cfg!(debug_assertions) {
        return resolve_development_launch(service);
    }
    resolve_bundled_launch(app, service)
}

pub fn resolve_narrative_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // 大体积世界观数据可以独立于安装包更新，显式路径始终优先于平台资源目录。
    if let Ok(path) = std::env::var("EMA_NARRATIVE_DIR") {
        return Ok(PathBuf::from(path));
    }
    if cfg!(debug_assertions) {
        return Ok(locate_workspace_root()?
            .join("apps")
            .join("bridge")
            .join("data")
            .join("narrative"));
    }
    app.path()
        .resource_dir()
        .map(|root| root.join("narrative"))
        .map_err(|error| format!("resolve bundled narrative directory: {error}"))
}

fn resolve_development_launch(service: RuntimeService) -> Result<ServiceLaunch, String> {
    let workspace_root = locate_workspace_root()?;
    match service {
        RuntimeService::Core => Ok(ServiceLaunch {
            executable: which::which("pnpm")
                .map_err(|error| format!("pnpm not on PATH: {error}"))?,
            args: vec![
                "--filter".to_string(),
                "@ema-agent/core".to_string(),
                "dev".to_string(),
            ],
            working_dir: workspace_root,
        }),
        RuntimeService::Bridge => Ok(ServiceLaunch {
            executable: which::which("uv").map_err(|error| format!("uv not on PATH: {error}"))?,
            args: vec!["run".to_string(), "ema-bridge".to_string()],
            working_dir: workspace_root.join("apps").join("bridge"),
        }),
    }
}

fn resolve_bundled_launch(
    app: &AppHandle,
    service: RuntimeService,
) -> Result<ServiceLaunch, String> {
    let env_key = match service {
        RuntimeService::Core => "EMA_CORE_EXECUTABLE",
        RuntimeService::Bridge => "EMA_BRIDGE_EXECUTABLE",
    };
    if let Ok(explicit) = std::env::var(env_key) {
        return launch_for_existing(PathBuf::from(explicit), Vec::new());
    }

    let base_name = format!("ema-{}", service.as_str());
    let executable_name = platform_executable_name(&base_name);
    let target_name =
        platform_executable_name(&format!("{base_name}-{}", env!("EMA_TARGET_TRIPLE"),));
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("resolve resource directory: {error}"))?;
    let executable_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));

    let mut candidates = vec![
        resource_dir.join("binaries").join(&executable_name),
        resource_dir.join("binaries").join(&target_name),
        resource_dir.join(&executable_name),
        resource_dir.join(&target_name),
    ];
    if let Some(directory) = executable_dir {
        candidates.push(directory.join(&executable_name));
        candidates.push(directory.join(&target_name));
    }

    let executable = candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| format!("bundled {} executable not found", service.as_str()))?;
    launch_for_existing(executable, Vec::new())
}

fn launch_for_existing(executable: PathBuf, args: Vec<String>) -> Result<ServiceLaunch, String> {
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
    Ok(ServiceLaunch {
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
    let manifest = std::env::var("CARGO_MANIFEST_DIR")
        .map_err(|_| "CARGO_MANIFEST_DIR not set".to_string())?;
    let start = PathBuf::from(manifest);
    let mut current = start.as_path();
    loop {
        if current.join("pnpm-workspace.yaml").is_file() {
            return Ok(current.to_path_buf());
        }
        current = current
            .parent()
            .ok_or_else(|| "workspace root not found".to_string())?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_executable_has_expected_suffix() {
        let name = platform_executable_name("ema-core");
        if cfg!(target_os = "windows") {
            assert_eq!(name, "ema-core.exe");
        } else {
            assert_eq!(name, "ema-core");
        }
    }
}

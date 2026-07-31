// 解析开发命令与各平台安装包内的 LocalHost、Bridge 可执行资源。
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use super::narrative::provision_narrative_seed;
use super::types::RuntimeService;

#[derive(Debug)]
pub struct ServiceLaunch {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub working_dir: PathBuf,
    /// spawn 出的进程是否即服务本体。
    /// 打包直启 exe 为 true(readiness PID 必须与 spawn PID 相等);
    /// 开发期经 pnpm/uv 包装器为 false(真实服务是包装器的子进程,PID 不参与校验)。
    pub launcher_is_service: bool,
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

pub async fn resolve_narrative_dir(app: &AppHandle) -> Result<PathBuf, String> {
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
    let seed_root = app
        .path()
        .resource_dir()
        .map(|root| root.join("narrative-seed"))
        .map_err(|error| format!("resolve bundled Narrative seed: {error}"))?;
    let destination = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("resolve writable Narrative directory: {error}"))?
        .join("narrative")
        .join("worlds")
        .join("default");
    provision_narrative_seed(seed_root, destination).await
}

fn resolve_development_launch(service: RuntimeService) -> Result<ServiceLaunch, String> {
    let workspace_root = locate_workspace_root()?;
    match service {
        RuntimeService::LocalHost => Ok(ServiceLaunch {
            executable: which::which("pnpm")
                .map_err(|error| format!("pnpm not on PATH: {error}"))?,
            args: vec![
                "--filter".to_string(),
                "@ema-agent/local-host".to_string(),
                "dev".to_string(),
            ],
            working_dir: workspace_root,
            launcher_is_service: false,
        }),
        RuntimeService::Bridge => Ok(ServiceLaunch {
            executable: which::which("uv").map_err(|error| format!("uv not on PATH: {error}"))?,
            args: vec!["run".to_string(), "ema-bridge".to_string()],
            working_dir: workspace_root.join("apps").join("bridge"),
            launcher_is_service: false,
        }),
    }
}

fn resolve_bundled_launch(
    app: &AppHandle,
    service: RuntimeService,
) -> Result<ServiceLaunch, String> {
    let env_key = match service {
        RuntimeService::LocalHost => "EMA_LOCAL_HOST_EXECUTABLE",
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

    if service == RuntimeService::Bridge {
        let bridge_executable = resource_dir
            .join("bridge-runtime")
            .join(platform_executable_name("ema-bridge"));
        if bridge_executable.is_file() {
            return launch_for_existing(bridge_executable, Vec::new());
        }
    }

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
    if service == RuntimeService::LocalHost {
        let runtime_root = resource_dir.join("local-host-runtime").join("app");
        let entry = runtime_root.join("dist").join("index.js");
        if !entry.is_file() {
            return Err(format!(
                "bundled LocalHost entry not found: {}",
                entry.display()
            ));
        }
        return launch_for_existing_at(
            executable,
            vec![entry.to_string_lossy().into_owned()],
            runtime_root,
        );
    }
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
    launch_for_existing_at(executable, args, working_dir)
}

fn launch_for_existing_at(
    executable: PathBuf,
    args: Vec<String>,
    working_dir: PathBuf,
) -> Result<ServiceLaunch, String> {
    if !working_dir.is_dir() {
        return Err(format!(
            "runtime working directory does not exist: {}",
            working_dir.display()
        ));
    }
    Ok(ServiceLaunch {
        executable,
        args,
        working_dir,
        launcher_is_service: true,
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
        let name = platform_executable_name("ema-local-host");
        if cfg!(target_os = "windows") {
            assert_eq!(name, "ema-local-host.exe");
        } else {
            assert_eq!(name, "ema-local-host");
        }
    }
}

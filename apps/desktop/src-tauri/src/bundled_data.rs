// 在 Server 启动前准备随包角色和模型目录.
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::desktop::profile::profile_root;

pub async fn prepare_models_catalog(app: &AppHandle) -> Result<(), String> {
    let destination = profile_root()?.join("profile").join("models-dev.json");
    if destination.exists() {
        return Ok(());
    }
    let source = bundled_resources_dir(app)?.join("models-dev.json");
    tokio::task::spawn_blocking(move || install_models_catalog(&source, &destination))
        .await
        .map_err(|error| format!("Model catalog install task failed: {error}"))?
}

fn install_models_catalog(source: &Path, destination: &Path) -> Result<(), String> {
    // 用户已下载的目录由 Server 维护, 安装或升级时不覆盖.
    if destination.exists() {
        return Ok(());
    }
    let parent = destination.parent().expect("model catalog has a parent directory");
    fs::create_dir_all(parent)
        .map_err(|error| format!("create model catalog directory: {error}"))?;
    fs::copy(source, destination)
        .map_err(|error| format!("install bundled model catalog: {error}"))?;
    Ok(())
}

/// 返回是否需要由 Server 初始化内置角色数据库行.
/// `profile.db` 是角色配置的事实源 它已经存在时不再复制或补种内置角色
/// 因而用户主动删除艾玛后 后续启动不会把她恢复出来
pub async fn prepare_builtin_characters(app: &AppHandle) -> Result<bool, String> {
    let profile_root = profile_root()?;
    if profile_root.join("profile.db").exists() {
        return Ok(false);
    }

    let source = bundled_resources_dir(app)?.join("characters");
    let destination = profile_root.join("characters");
    tokio::task::spawn_blocking(move || install_builtin_characters(&source, &destination))
        .await
        .map_err(|error| format!("Character install task failed: {error}"))??;
    Ok(true)
}

fn bundled_resources_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(locate_workspace_root()?
            .join("apps")
            .join("desktop")
            .join("src-tauri")
            .join("resources"));
    }

    Ok(app
        .path()
        .resource_dir()
        .map_err(|error| format!("resolve application resources: {error}"))?)
}

fn install_builtin_characters(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Err(format!(
            "bundled Character directory not found: {}",
            source.display()
        ));
    }

    fs::create_dir_all(destination)
        .map_err(|error| format!("create Character directory: {error}"))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("read bundled Character directory: {error}"))?
    {
        let entry = entry.map_err(|error| format!("read bundled Character entry: {error}"))?;
        let target = destination.join(entry.file_name());
        if target.exists() {
            continue;
        }
        copy_directory(&entry.path(), &target)?;
    }
    Ok(())
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    if source.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create resource directory: {error}"))?;
        }
        fs::copy(source, destination)
            .map_err(|error| format!("copy resource file {}: {error}", source.display()))?;
        return Ok(());
    }

    fs::create_dir_all(destination)
        .map_err(|error| format!("create resource directory: {error}"))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("read resource directory {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("read resource entry: {error}"))?;
        copy_directory(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_catalog_is_installed_once_independently_of_profile_database() {
        let root = std::env::temp_dir().join(format!(
            "ema-catalog-{}-{}", std::process::id(), rand::random::<u64>()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("profile.db"), b"existing database").unwrap();
        let source = root.join("bundled.json");
        let destination = root.join("profile").join("models-dev.json");
        fs::write(&source, b"bundled catalog").unwrap();
        install_models_catalog(&source, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"bundled catalog");
        fs::write(&destination, b"user refreshed catalog").unwrap();
        install_models_catalog(&source, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"user refreshed catalog");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copies_character_resources_into_unicode_directory() {
        let root = std::env::temp_dir().join(format!(
            "ema-character-test-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let source = root.join("source");
        let model = source.join("樱羽艾玛").join("live2d").join("ema");
        fs::create_dir_all(&model).unwrap();
        fs::write(model.join("ema.model3.json"), b"model").unwrap();

        let destination = root.join("characters");
        install_builtin_characters(&source, &destination).unwrap();
        assert_eq!(
            fs::read(
                destination
                    .join("樱羽艾玛")
                    .join("live2d")
                    .join("ema")
                    .join("ema.model3.json")
            )
            .unwrap(),
            b"model"
        );
        fs::remove_dir_all(root).unwrap();
    }

}

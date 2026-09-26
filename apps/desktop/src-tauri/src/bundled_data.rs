// 在子进程启动前把随包角色资源和可写 Narrative 数据铺到用户目录.
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::desktop::profile::profile_root;

const TIMELINES: [&str; 3] = ["1st_Loop", "2nd_Loop", "3rd_Loop"];

/// 返回是否需要由 Server 初始化内置角色数据库行.
/// `profile.db` 是角色配置的事实源 它已经存在时不再复制或补种内置角色
/// 因而用户主动删除艾玛后 后续启动不会把她恢复出来
pub async fn prepare_builtin_characters(app: &AppHandle) -> Result<bool, String> {
    let profile_root = profile_root()?;
    if profile_root.join("profile.db").exists() {
        return Ok(false);
    }

    let source = bundled_characters_source(app)?;
    let destination = profile_root.join("characters");
    tokio::task::spawn_blocking(move || install_builtin_characters(&source, &destination))
        .await
        .map_err(|error| format!("Character install task failed: {error}"))??;
    Ok(true)
}

pub async fn prepare_narrative_data(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("EMA_NARRATIVE_DIR") {
        let path = PathBuf::from(path);
        validate_world(&path)?;
        return Ok(path);
    }

    let destination = profile_root()?
        .join("narrative")
        .join("data")
        .join("witch-trial");
    if destination.exists() {
        validate_world(&destination)?;
        return Ok(destination);
    }

    let source = bundled_narrative_source(app)?;
    tokio::task::spawn_blocking(move || install_narrative(&source, &destination))
        .await
        .map_err(|error| format!("Narrative install task failed: {error}"))?
}

fn bundled_characters_source(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(locate_workspace_root()?
            .join("apps")
            .join("desktop")
            .join("src-tauri")
            .join("resources")
            .join("characters"));
    }

    Ok(app
        .path()
        .resource_dir()
        .map_err(|error| format!("resolve application resources: {error}"))?
        .join("characters"))
}

fn bundled_narrative_source(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(locate_workspace_root()?
            .join("bridges")
            .join("narrative")
            .join("data")
            .join("witch-trial"));
    }

    Ok(app
        .path()
        .resource_dir()
        .map_err(|error| format!("resolve application resources: {error}"))?
        .join("narrative")
        .join("witch-trial"))
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

fn install_narrative(source: &Path, destination: &Path) -> Result<PathBuf, String> {
    validate_world(source)?;
    let parent = destination
        .parent()
        .ok_or_else(|| "Narrative destination has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create Narrative data directory: {error}"))?;

    // Bridge 会修改这份数据。先复制完整目录再改名，避免它看到半铺设的数据集。
    let installing = parent.join(".witch-trial-installing");
    if installing.exists() {
        fs::remove_dir_all(&installing)
            .map_err(|error| format!("clear unfinished Narrative install: {error}"))?;
    }

    let result = copy_directory(source, &installing)
        .and_then(|_| validate_world(&installing))
        .and_then(|_| {
            fs::rename(&installing, destination)
                .map_err(|error| format!("finish Narrative install: {error}"))?;
            Ok(destination.to_path_buf())
        });
    if result.is_err() {
        let _ = fs::remove_dir_all(&installing);
    }
    result
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

fn validate_world(path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!(
            "Narrative data directory not found: {}",
            path.display()
        ));
    }
    for timeline in TIMELINES {
        let timeline_path = path.join(timeline);
        if !timeline_path.is_dir() {
            return Err(format!(
                "Narrative timeline not found: {}",
                timeline_path.display()
            ));
        }
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

    #[test]
    fn installs_writable_narrative_directory() {
        let root = std::env::temp_dir().join(format!(
            "ema-narrative-test-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let source = root.join("source");
        for timeline in TIMELINES {
            let directory = source.join(timeline);
            fs::create_dir_all(&directory).unwrap();
            fs::write(
                directory.join("graph_chunk_entity_relation.graphml"),
                b"graph",
            )
            .unwrap();
        }

        let destination = root.join("data").join("witch-trial");
        let installed = install_narrative(&source, &destination).unwrap();
        assert_eq!(installed, destination);
        validate_world(&installed).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}

// 把安装包中的 witch-trial ZIP 首次安装到用户的 Narrative 数据目录。
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use zip::ZipArchive;

const TIMELINES: [&str; 3] = ["1st_Loop", "2nd_Loop", "3rd_Loop"];

pub async fn prepare_narrative_data(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("EMA_NARRATIVE_DIR") {
        let path = PathBuf::from(path);
        validate_world(&path)?;
        return Ok(path);
    }

    if cfg!(debug_assertions) {
        let path = locate_workspace_root()?
            .join("bridges")
            .join("narrative")
            .join("data")
            .join("witch-trial");
        validate_world(&path)?;
        return Ok(path);
    }

    let archive = app
        .path()
        .resource_dir()
        .map_err(|error| format!("resolve application resources: {error}"))?
        .join("narrative")
        .join("witch-trial.zip");
    let destination = ema_data_root()?
        .join("narrative")
        .join("data")
        .join("witch-trial");

    if destination.exists() {
        validate_world(&destination)?;
        return Ok(destination);
    }

    tokio::task::spawn_blocking(move || install_archive(&archive, &destination))
        .await
        .map_err(|error| format!("Narrative install task failed: {error}"))?
}

fn ema_data_root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".ema-agent"))
        .ok_or_else(|| "cannot resolve user home directory".to_string())
}

fn install_archive(archive: &Path, destination: &Path) -> Result<PathBuf, String> {
    if !archive.is_file() {
        return Err(format!(
            "Narrative archive not found: {}",
            archive.display()
        ));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "Narrative destination has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create Narrative data directory: {error}"))?;

    let installing = parent.join(".witch-trial-installing");
    if installing.exists() {
        fs::remove_dir_all(&installing)
            .map_err(|error| format!("clear unfinished Narrative install: {error}"))?;
    }
    fs::create_dir_all(&installing)
        .map_err(|error| format!("create Narrative install directory: {error}"))?;

    let result = extract_archive(archive, &installing)
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

fn extract_archive(archive: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|error| format!("open Narrative archive: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("read Narrative archive: {error}"))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("read Narrative archive entry: {error}"))?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| format!("invalid Narrative archive path: {}", entry.name()))?;
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|error| format!("create Narrative directory: {error}"))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create Narrative directory: {error}"))?;
        }
        let mut target =
            File::create(&output).map_err(|error| format!("create Narrative file: {error}"))?;
        io::copy(&mut entry, &mut target)
            .map_err(|error| format!("write Narrative file: {error}"))?;
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
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    #[test]
    fn installs_three_timelines_from_archive() {
        let root = std::env::temp_dir().join(format!(
            "ema-narrative-test-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("witch-trial.zip");
        let file = File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        for timeline in TIMELINES {
            archive
                .start_file(
                    format!("{timeline}/graph_chunk_entity_relation.graphml"),
                    SimpleFileOptions::default(),
                )
                .unwrap();
            archive.write_all(b"graph").unwrap();
        }
        archive.finish().unwrap();

        let destination = root.join("data").join("witch-trial");
        let installed = install_archive(&archive_path, &destination).unwrap();
        assert_eq!(installed, destination);
        validate_world(&installed).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}

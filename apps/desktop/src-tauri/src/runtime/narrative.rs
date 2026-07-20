// 把安装包内只读 Narrative 种子校验并原子配置到用户可写数据目录。
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NarrativeSeedManifest {
    schema_version: u32,
    content_version: String,
    files: BTreeMap<String, NarrativeSeedFile>,
}

#[derive(Deserialize)]
struct NarrativeSeedFile {
    size: u64,
    sha256: String,
}

pub async fn provision_narrative_seed(
    seed_root: PathBuf,
    destination: PathBuf,
) -> Result<PathBuf, String> {
    if destination.is_dir() {
        return Ok(destination);
    }

    tokio::task::spawn_blocking(move || provision_sync(&seed_root, &destination))
        .await
        .map_err(|error| format!("Narrative seed 配置任务失败: {error}"))?
}

fn provision_sync(seed_root: &Path, destination: &Path) -> Result<PathBuf, String> {
    let manifest_path = seed_root.join("release-manifest.json");
    let manifest_bytes = fs::read(&manifest_path)
        .map_err(|error| format!("读取 Narrative seed manifest 失败: {error}"))?;
    let manifest: NarrativeSeedManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("解析 Narrative seed manifest 失败: {error}"))?;
    if manifest.schema_version != 1 || manifest.content_version.trim().is_empty() {
        return Err("Narrative seed manifest 版本无效".to_string());
    }

    let parent = destination
        .parent()
        .ok_or_else(|| format!("Narrative 目标目录没有父目录: {}", destination.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建 Narrative 数据父目录失败: {error}"))?;
    let staging = parent.join(format!(
        ".narrative-install-{}-{}",
        std::process::id(),
        manifest.content_version
    ));
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|error| format!("清理 Narrative 临时目录失败: {error}"))?;
    }
    fs::create_dir_all(&staging)
        .map_err(|error| format!("创建 Narrative 临时目录失败: {error}"))?;

    let result = copy_manifest_files(seed_root, &staging, &manifest).and_then(|_| {
        fs::write(staging.join(".installed-manifest.json"), &manifest_bytes)
            .map_err(|error| format!("写入 Narrative 安装清单失败: {error}"))?;
        match fs::rename(&staging, destination) {
            Ok(()) => Ok(destination.to_path_buf()),
            Err(_) if destination.is_dir() => {
                let _ = fs::remove_dir_all(&staging);
                Ok(destination.to_path_buf())
            }
            Err(error) => Err(format!("提交 Narrative 数据目录失败: {error}")),
        }
    });
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn copy_manifest_files(
    seed_root: &Path,
    staging: &Path,
    manifest: &NarrativeSeedManifest,
) -> Result<(), String> {
    for (relative, expected) in &manifest.files {
        let relative_path = portable_relative_path(relative)?;
        let source = seed_root.join(&relative_path);
        let destination = staging.join(&relative_path);
        let metadata = fs::symlink_metadata(&source).map_err(|error| {
            format!("读取 Narrative seed 文件失败 {}: {error}", source.display())
        })?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(format!(
                "Narrative seed 只允许普通文件: {}",
                source.display()
            ));
        }
        if metadata.len() != expected.size {
            return Err(format!(
                "Narrative seed 文件大小不匹配: {}",
                source.display()
            ));
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建 Narrative seed 子目录失败: {error}"))?;
        }
        copy_and_hash(&source, &destination, &expected.sha256)?;
    }
    Ok(())
}

fn portable_relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.contains('\\') || value.contains(':') {
        return Err(format!("Narrative seed 路径不可移植: {value}"));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("Narrative seed 路径越界: {value}"));
    }
    Ok(path.to_path_buf())
}

fn copy_and_hash(source: &Path, destination: &Path, expected_hash: &str) -> Result<(), String> {
    let mut input =
        File::open(source).map_err(|error| format!("打开 Narrative seed 文件失败: {error}"))?;
    let mut output = File::create(destination)
        .map_err(|error| format!("创建 Narrative 数据文件失败: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| format!("读取 Narrative seed 文件失败: {error}"))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("写入 Narrative 数据文件失败: {error}"))?;
        digest.update(&buffer[..read]);
    }
    output
        .sync_all()
        .map_err(|error| format!("同步 Narrative 数据文件失败: {error}"))?;
    let actual_hash = format!("{:x}", digest.finalize());
    if actual_hash != expected_hash.to_ascii_lowercase() {
        return Err(format!(
            "Narrative seed 文件摘要不匹配: {}",
            source.display()
        ));
    }
    Ok(())
}

//! 独立、有容量上限的磁盘缓存，不写空间资源库或 MongoDB。
use axum::body::Bytes;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};

#[derive(Clone, Serialize, Deserialize)]
pub struct Metadata {
    pub saved: u64,
    pub expires: u64,
    pub content_type: String,
}

pub struct DiskCache {
    directory: PathBuf,
    capacity: u64,
    writes: Mutex<()>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl DiskCache {
    pub fn new(directory: PathBuf, capacity: u64) -> Self {
        Self {
            directory,
            capacity,
            writes: Mutex::new(()),
        }
    }

    pub async fn get(
        &self,
        key: &str,
        max_bytes: usize,
        max_age: u64,
    ) -> Option<(Metadata, Bytes)> {
        if self.capacity == 0 {
            return None;
        }
        let path = self.directory.join(key);
        let mut file = fs::File::open(&path).await.ok()?;
        if file.metadata().await.ok()?.len() > max_bytes as u64 + 4096 {
            return None;
        }
        let size = file.read_u32().await.ok()? as usize;
        if size > 4096 {
            return None;
        }
        let mut meta = vec![0; size];
        file.read_exact(&mut meta).await.ok()?;
        let meta: Metadata = serde_json::from_slice(&meta).ok()?;
        if now_ms() >= meta.expires.min(meta.saved.saturating_add(max_age * 1000)) {
            let _ = fs::remove_file(path).await;
            return None;
        }
        let mut bytes = Vec::new();
        file.take(max_bytes as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .ok()?;
        (bytes.len() <= max_bytes).then(|| (meta, Bytes::from(bytes)))
    }

    pub async fn put(&self, key: &str, meta: &Metadata, bytes: &Bytes) -> std::io::Result<()> {
        if self.capacity == 0 {
            return Ok(());
        }
        let data = serde_json::to_vec(meta)?;
        let incoming = bytes.len() as u64 + data.len() as u64 + 4;
        if incoming > self.capacity {
            return Ok(());
        }
        let _lock = self.writes.lock().await;
        fs::create_dir_all(&self.directory).await?;
        let mut entries = fs::read_dir(&self.directory).await?;
        let mut files = Vec::new();
        let mut total = 0;
        while let Some(entry) = entries.next_entry().await? {
            let metadata = entry.metadata().await?;
            if !metadata.is_file() {
                continue;
            }
            // 目录为本功能专用；清理中断写入留下的临时文件。
            if entry.file_name().to_string_lossy().ends_with(".tmp") || entry.file_name() == key {
                fs::remove_file(entry.path()).await?;
                continue;
            }
            total += metadata.len();
            files.push((
                metadata.modified().unwrap_or(UNIX_EPOCH),
                metadata.len(),
                entry.path(),
            ));
        }
        files.sort_by_key(|entry| entry.0);
        for (_, size, path) in files {
            if total + incoming <= self.capacity {
                break;
            }
            match fs::remove_file(path).await {
                Ok(()) => total -= size,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => total -= size,
                Err(e) => return Err(e),
            }
        }
        let temporary = self.directory.join(format!("{key}.tmp"));
        let mut file = fs::File::create(&temporary).await?;
        file.write_u32(data.len() as u32).await?;
        file.write_all(&data).await?;
        file.write_all(bytes).await?;
        file.flush().await?;
        fs::rename(temporary, self.directory.join(key)).await
    }
}

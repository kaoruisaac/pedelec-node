//! Provider artifact intake. The Worker only copies a Provider's raw output into the
//! SDK-chosen same-filesystem staging directory and reports its metadata; the SDK
//! validates, names and lands the file. Bytes never travel in an IPC frame.
use crate::event_sink::EventSink;
use pedelec_core::MAX_ASSET_UPLOAD_BYTES;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

const MAX_DEDUPE_KEYS: usize = 4096;

pub(crate) struct ArtifactMeta<'a> {
    pub(crate) turn_id: &'a str,
    pub(crate) source: &'a str,
    pub(crate) provider_artifact_id: Option<&'a str>,
    pub(crate) tool_call_id: Option<&'a str>,
    pub(crate) filename: &'a str,
    pub(crate) mime_type: &'a str,
}

struct Inner {
    session_id: String,
    directory: Option<PathBuf>,
    next: AtomicU64,
    seen: Mutex<HashSet<String>>,
    sink: EventSink,
}

#[derive(Clone)]
pub(crate) struct ArtifactStage(Arc<Inner>);

pub(crate) fn kind_from_mime(mime_type: &str) -> &'static str {
    let mime = mime_type.split(';').next().unwrap_or_default().trim();
    let mime = mime.to_ascii_lowercase();
    if mime.starts_with("image/") {
        "image"
    } else if mime.starts_with("audio/") {
        "audio"
    } else if mime.starts_with("video/") {
        "video"
    } else {
        "file"
    }
}

/// Provider image payloads are trusted only as far as their leading bytes.
pub(crate) fn sniff_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", "image.png"))
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(("image/jpeg", "image.jpg"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("image/webp", "image.webp"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("image/gif", "image.gif"))
    } else {
        None
    }
}

pub(crate) fn extension_for_mime(mime_type: &str) -> &'static str {
    match mime_type.split(';').next().unwrap_or_default().trim() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "bin",
    }
}

fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || "._-".contains(*ch))
        .take(128)
        .collect();
    let cleaned = cleaned.trim_matches('.');
    if cleaned.is_empty() {
        "artifact".to_string()
    } else {
        cleaned.to_string()
    }
}

impl ArtifactStage {
    pub(crate) fn new(session_id: &str, directory: Option<PathBuf>, sink: &EventSink) -> Self {
        Self(Arc::new(Inner {
            session_id: session_id.to_string(),
            directory,
            next: AtomicU64::new(1),
            seen: Mutex::new(HashSet::new()),
            sink: sink.clone(),
        }))
    }

    pub(crate) fn bytes(&self, meta: ArtifactMeta<'_>, bytes: &[u8]) {
        self.accept(meta, |target| {
            if bytes.len() as u64 > MAX_ASSET_UPLOAD_BYTES {
                return Err(io::Error::other("artifact exceeds the size limit"));
            }
            let mut output = create_private(target)?;
            output.write_all(bytes)?;
            output.sync_all()?;
            Ok((bytes.len() as u64, hex(&Sha256::digest(bytes))))
        });
    }

    pub(crate) fn file(&self, meta: ArtifactMeta<'_>, source: &Path) {
        self.accept(meta, |target| copy_regular_file(source, target));
    }

    /// Reports a Provider artifact that could not be read as metadata only.
    pub(crate) fn failed(&self, turn_id: &str, code: &str) {
        let _ = self.0.sink.emit(
            &self.0.session_id,
            "artifact-failed",
            json!({"turnId": turn_id, "code": code}),
        );
    }

    fn accept(
        &self,
        meta: ArtifactMeta<'_>,
        write: impl FnOnce(&Path) -> io::Result<(u64, String)>,
    ) {
        if let Some(id) = meta.provider_artifact_id {
            let key = format!("{}\0{}", meta.turn_id, id);
            let duplicate = self.0.seen.lock().map_or(true, |mut seen| {
                if seen.len() >= MAX_DEDUPE_KEYS {
                    seen.clear();
                }
                !seen.insert(key)
            });
            if duplicate {
                return;
            }
        }
        let Some(directory) = &self.0.directory else {
            self.failed(meta.turn_id, "ARTIFACT_DIRECTORY_UNAVAILABLE");
            return;
        };
        // Created on demand, so a Session without artifacts leaves no trace in its workdir.
        let Ok(directory) = ready_directory(directory) else {
            self.failed(meta.turn_id, "ARTIFACT_STORAGE_FAILED");
            return;
        };
        let index = self.0.next.fetch_add(1, Ordering::Relaxed);
        let staged = directory.join(format!("{index:06}-{}", safe_name(meta.filename)));
        let partial = staged.with_extension(format!(
            "{}.part",
            staged
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("bin")
        ));
        let written = write(&partial).and_then(|summary| {
            fs::rename(&partial, &staged)?;
            Ok(summary)
        });
        let (bytes, sha256) = match written {
            Ok(summary) => summary,
            Err(_) => {
                let _ = fs::remove_file(&partial);
                self.failed(meta.turn_id, "ARTIFACT_STORAGE_FAILED");
                return;
            }
        };
        let event: Value = json!({
            "turnId": meta.turn_id,
            "kind": kind_from_mime(meta.mime_type),
            "source": meta.source,
            "providerArtifactId": meta.provider_artifact_id,
            "toolCallId": meta.tool_call_id,
            "filename": safe_name(meta.filename),
            "mimeType": meta.mime_type,
            "bytes": bytes,
            "sha256": sha256,
            "stagedPath": staged.to_string_lossy(),
        });
        if self
            .0
            .sink
            .emit(&self.0.session_id, "artifact", event)
            .is_err()
        {
            let _ = fs::remove_file(&staged);
        }
    }
}

fn ready_directory(directory: &Path) -> io::Result<PathBuf> {
    fs::create_dir_all(directory)?;
    let metadata = fs::symlink_metadata(directory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::other("artifact staging is not a directory"));
    }
    directory.canonicalize()
}

fn create_private(path: &Path) -> io::Result<File> {
    #[allow(unused_mut)]
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.write(true).create_new(true).open(path)
}

fn copy_regular_file(source: &Path, target: &Path) -> io::Result<(u64, String)> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(io::Error::other("artifact source is not a regular file"));
    }
    if metadata.len() > MAX_ASSET_UPLOAD_BYTES {
        return Err(io::Error::other("artifact exceeds the size limit"));
    }
    let mut input = File::open(source)?.take(MAX_ASSET_UPLOAD_BYTES + 1);
    let mut output = create_private(target)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > MAX_ASSET_UPLOAD_BYTES {
            return Err(io::Error::other("artifact exceeds the size limit"));
        }
        hash.update(&buffer[..count]);
        output.write_all(&buffer[..count])?;
    }
    output.sync_all()?;
    Ok((total, hex(&hash.finalize())))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_stay_inside_the_staging_directory() {
        assert_eq!(safe_name("../../etc/passwd"), "etcpasswd");
        assert_eq!(safe_name("..."), "artifact");
        assert_eq!(safe_name("圖.png"), "png");
    }

    #[test]
    fn mime_and_image_detection_follow_content() {
        assert_eq!(kind_from_mime("IMAGE/PNG; x=1"), "image");
        assert_eq!(kind_from_mime("application/pdf"), "file");
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\n").unwrap().0, "image/png");
        assert!(sniff_image(b"plain").is_none());
    }

    #[test]
    fn symlink_sources_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.png");
        fs::write(&real, b"x").unwrap();
        #[cfg(unix)]
        {
            let link = dir.path().join("link.png");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert!(copy_regular_file(&link, &dir.path().join("out")).is_err());
        }
        let (bytes, _) = copy_regular_file(&real, &dir.path().join("copy")).unwrap();
        assert_eq!(bytes, 1);
    }
}

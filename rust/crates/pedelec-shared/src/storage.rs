//! Private SDK storage protocol shared by the lock keeper, Worker and Ollama writer.
use same_file::Handle;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read},
    path::{Component, Path, PathBuf},
};

pub const OWNER_LOCK: &str = ".owner.lock";
pub const WORKER_LOCK: &str = ".workers.lock";
pub const SEALED: &str = ".deleting";
pub const ROOT_ENV: &str = "PEDELEC_STORAGE_ROOT";
pub const INSTANCE_ENV: &str = "PEDELEC_STORAGE_INSTANCE";
pub const SESSION_ENV: &str = "PEDELEC_STORAGE_SESSION";

pub fn refused() -> io::Error {
    io::Error::other("unsafe SDK storage")
}

pub fn is_instance(id: &str) -> bool {
    uuid::Uuid::parse_str(id)
        .is_ok_and(|uuid| uuid.get_version_num() == 4 && uuid.hyphenated().to_string() == id)
}

pub fn session_segment(id: &str) -> String {
    let reserved = matches!(id, "aux" | "con" | "nul" | "prn")
        || ((id.starts_with("com") || id.starts_with("lpt"))
            && id.len() == 4
            && id.as_bytes()[3].is_ascii_digit());
    if !id.is_empty()
        && id.len() <= 128
        && !reserved
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'-' | b'_'))
    {
        return id.to_owned();
    }
    format!("~{:x}", Sha256::digest(id.as_bytes()))
}

pub fn is_session_segment(segment: &str) -> bool {
    session_segment(segment) == segment
        || segment.strip_prefix('~').is_some_and(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        })
}

pub fn reparse(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

/// Check every component, including ancestors, before touching a managed path.
pub fn directory(path: &Path) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(refused());
    }
    let mut cursor = PathBuf::new();
    for part in path.components() {
        if matches!(part, Component::ParentDir | Component::CurDir) {
            return Err(refused());
        }
        cursor.push(part);
        if matches!(part, Component::Normal(_)) {
            let meta = fs::symlink_metadata(&cursor)?;
            if !meta.is_dir() || reparse(&meta) {
                return Err(refused());
            }
        }
    }
    Ok(())
}

pub fn create_directory(path: &Path) -> io::Result<()> {
    directory(path.parent().ok_or_else(refused)?)?;
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => (),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error),
    }
    directory(path)
}

pub fn present(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub fn plain_file(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || reparse(&meta) {
        return Err(refused());
    }
    Ok(())
}

fn open_lock(path: &Path) -> io::Result<File> {
    directory(path.parent().ok_or_else(refused)?)?;
    if present(path)? {
        plain_file(path)?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path)?;
    check_lock(&file, path)?;
    Ok(file)
}

pub fn check_lock(file: &File, path: &Path) -> io::Result<()> {
    directory(path.parent().ok_or_else(refused)?)?;
    plain_file(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || reparse(&meta)
        || Handle::from_file(file.try_clone()?)? != Handle::from_path(path)?
    {
        return Err(refused());
    }
    Ok(())
}

/// The anchor detects a replaced lock pathname even in a process that never opened the old inode.
pub fn anchored_lock(parent: &Path, name: &str, create: bool) -> io::Result<File> {
    let path = parent.join(name);
    let anchor = parent.join(format!("{name}.anchor"));
    if create && !present(&path)? && !present(&anchor)? {
        directory(parent)?;
        // Publish both names before anyone may use this lock. A partially initialized pair is refused.
        let created = OpenOptions::new().write(true).create_new(true).open(&path);
        match created {
            Ok(_) => fs::hard_link(&path, &anchor)?,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error),
        }
    }
    let file = open_lock(&path)?;
    verify_anchor(&file, parent, name)?;
    Ok(file)
}

pub fn verify_anchor(file: &File, parent: &Path, name: &str) -> io::Result<()> {
    check_lock(file, &parent.join(name))?;
    check_lock(file, &parent.join(format!("{name}.anchor")))
}

pub const INSTANCE_MARKER: &str = ".owner";

pub fn marker(instances: &Path, id: &str) -> PathBuf {
    instances.join(format!(".{id}.owner"))
}

pub fn owns_instance(instances: &Path, id: &str) -> io::Result<bool> {
    let path = marker(instances, id);
    if !present(&path)? {
        return Ok(false);
    }
    let file = open_lock(&path)?;
    check_lock(&file, &instances.join(id).join(INSTANCE_MARKER))?;
    let mut bytes = Vec::new();
    file.take(37).read_to_end(&mut bytes)?;
    Ok(bytes == id.as_bytes())
}

const SESSION_PROOF: &str = ".pedelec-owned";

pub fn session_proof(leases: &Path, session: &str) -> PathBuf {
    leases.join(format!(".{session}.proof"))
}

pub fn mark_session_directory(proof: &Path, directory: &Path) -> io::Result<()> {
    fs::hard_link(proof, directory.join(SESSION_PROOF))
}

pub fn verify_session_directory(proof: &Path, path: &Path) -> io::Result<()> {
    directory(path)?;
    check_lock(&open_lock(proof)?, &path.join(SESSION_PROOF))
}

pub struct StorageLease {
    pub instance: PathBuf,
    pub session: String,
    _workers: File,
    _session: File,
}

impl StorageLease {
    pub fn provider_state(&self) -> PathBuf {
        self.instance
            .join("provider-state")
            .join("ollama")
            .join(&self.session)
    }

    /// Every process that can write the private store holds both shared locks for its entire lifetime.
    pub fn from_env() -> io::Result<Option<Self>> {
        let Some(root) = std::env::var_os(ROOT_ENV).map(PathBuf::from) else {
            if std::env::var_os(INSTANCE_ENV).is_some() || std::env::var_os(SESSION_ENV).is_some() {
                return Err(refused());
            }
            return Ok(None);
        };
        let id = std::env::var(INSTANCE_ENV).map_err(|_| refused())?;
        let session = std::env::var(SESSION_ENV).map_err(|_| refused())?;
        if !is_instance(&id) || !is_session_segment(&session) {
            return Err(refused());
        }
        let workers = anchored_lock(&root, WORKER_LOCK, false)?;
        workers.try_lock_shared()?;
        verify_anchor(&workers, &root, WORKER_LOCK)?;
        let instances = root.join("instances");
        let instance = instances.join(&id);
        directory(&instance)?;
        if present(&root.join(SEALED))? || !owns_instance(&instances, &id)? {
            return Err(refused());
        }
        let leases = instance.join(".leases");
        let lease = anchored_lock(&leases, &session, false)?;
        lease.try_lock_shared()?;
        verify_anchor(&lease, &leases, &session)?;
        Ok(Some(Self {
            instance,
            session,
            _workers: workers,
            _session: lease,
        }))
    }
}

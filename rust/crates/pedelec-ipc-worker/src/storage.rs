use pedelec_shared::storage::*;
use serde::Deserialize;
use std::{
    env,
    fs::{self, File},
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Command {
    action: String,
    session: Option<String>,
    ollama: Option<bool>,
}

struct Keeper {
    root: PathBuf,
    root_identity: FileIdentity,
    owner: File,
    workers: File,
    frozen: bool,
    instance: Option<(PathBuf, FileIdentity)>,
}

// Open directory identities survive renames. Compare before each maintenance operation.
struct FileIdentity(same_file::Handle);

impl FileIdentity {
    fn capture(path: &Path) -> io::Result<Self> {
        directory(path)?;
        Ok(Self(same_file::Handle::from_path(path)?))
    }

    fn verify(&self, path: &Path) -> io::Result<()> {
        if Self::capture(path)?.0 != self.0 {
            return Err(refused());
        }
        Ok(())
    }
}

#[cfg(unix)]
fn verify_device(path: &Path, device: u64) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::symlink_metadata(path)?;
    if meta.dev() != device {
        return Err(io::ErrorKind::CrossesDevices.into());
    }
    if meta.is_dir() {
        for entry in fs::read_dir(path)? {
            verify_device(&entry?.path(), device)?;
        }
    }
    Ok(())
}

/// Change only this dedicated process's working directory. The recursive delete starts at a single
/// child of that directory, so a rename of an ancestor cannot redirect traversal on Unix.
fn remove_child(path: &Path) -> io::Result<()> {
    let parent = path.parent().ok_or_else(refused)?;
    let name = path.file_name().ok_or_else(refused)?;
    if !present(path)? {
        return Ok(());
    }
    directory(path)?;
    let identity = FileIdentity::capture(parent)?;
    let child_identity = FileIdentity::capture(path)?;
    let previous = env::current_dir()?;
    env::set_current_dir(parent)?;
    let result = (|| {
        if same_file::Handle::from_path(".")? != identity.0 {
            return Err(refused());
        }
        let child = Path::new(name);
        let meta = fs::symlink_metadata(child)?;
        if !meta.is_dir()
            || reparse(&meta)
            || same_file::Handle::from_path(child)? != child_identity.0
        {
            return Err(refused());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            verify_device(child, fs::metadata(".")?.dev())?;
        }
        // std never follows symlinks, and uses descriptor-relative traversal on Unix.
        fs::remove_dir_all(child)
    })();
    // A lost working directory also invalidates future operations.
    env::set_current_dir(previous)?;
    result
}

fn create_marker(path: &Path, bytes: &[u8]) -> io::Result<()> {
    directory(path.parent().ok_or_else(refused)?)?;
    let mut file = File::create_new(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    #[cfg(unix)]
    File::open(path.parent().ok_or_else(refused)?)?.sync_all()?;
    Ok(())
}

impl Keeper {
    fn start(root: PathBuf, id: Option<&str>) -> io::Result<Self> {
        create_directory(&root)?;
        let root_identity = FileIdentity::capture(&root)?;
        let owner = anchored_lock(&root, OWNER_LOCK, true)?;
        owner.try_lock()?;
        let workers = anchored_lock(&root, WORKER_LOCK, true)?;
        let mut keeper = Self {
            root,
            root_identity,
            owner,
            workers,
            frozen: false,
            instance: None,
        };
        keeper.check()?;
        if let Some(id) = id {
            if !is_instance(id) || present(&keeper.root.join(SEALED))? {
                return Err(refused());
            }
            keeper.freeze()?;
            let instances = keeper.root.join("instances");
            create_directory(&instances)?;
            keeper.sweep(&instances)?;
            let instance = instances.join(id);
            if present(&instance)? {
                return Err(refused());
            }
            create_directory(&instance)?;
            create_directory(&instance.join(".leases"))?;
            let proof = instance.join(INSTANCE_MARKER);
            create_marker(&proof, id.as_bytes())?;
            fs::hard_link(&proof, marker(&instances, id))?;
            keeper.instance = Some((instance.clone(), FileIdentity::capture(&instance)?));
            keeper.thaw()?;
        }
        Ok(keeper)
    }

    fn check(&self) -> io::Result<()> {
        self.root_identity.verify(&self.root)?;
        verify_anchor(&self.owner, &self.root, OWNER_LOCK)?;
        verify_anchor(&self.workers, &self.root, WORKER_LOCK)?;
        if let Some((instance, identity)) = &self.instance {
            identity.verify(instance)?;
            let id = instance
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(refused)?;
            if !owns_instance(&self.root.join("instances"), id)? {
                return Err(refused());
            }
        }
        Ok(())
    }

    fn sweep(&self, instances: &Path) -> io::Result<()> {
        let identity = FileIdentity::capture(instances)?;
        let mut incomplete = false;
        for entry in fs::read_dir(instances)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(id) = name
                .to_str()
                .and_then(|name| name.strip_prefix('.'))
                .and_then(|name| name.strip_suffix(".owner"))
            else {
                continue;
            };
            if !is_instance(id) {
                continue;
            }
            self.check()?;
            identity.verify(instances)?;
            let cleanup = (|| {
                let instance = instances.join(id);
                if present(&instance)? {
                    if !owns_instance(instances, id)? {
                        return Err(refused());
                    }
                    let owned = FileIdentity::capture(&instance)?;
                    for area in ["artifacts", "provider-state", ".leases"] {
                        self.check()?;
                        identity.verify(instances)?;
                        owned.verify(&instance)?;
                        remove_child(&instance.join(area))?;
                    }
                    // Keep the proof through partial cleanup. A new entry or a replaced instance is refused.
                    owned.verify(&instance)?;
                    if fs::read_dir(&instance)?.count() != 1 || !owns_instance(instances, id)? {
                        return Err(refused());
                    }
                    let proof = instance.join(INSTANCE_MARKER);
                    fs::remove_file(&proof)?;
                    if let Err(error) = fs::remove_dir(&instance) {
                        if owned.verify(&instance).is_ok() {
                            let _ = fs::hard_link(entry.path(), &proof);
                        }
                        return Err(error);
                    }
                }
                self.check()?;
                identity.verify(instances)?;
                plain_file(&entry.path())?;
                fs::remove_file(entry.path())
            })();
            incomplete |= cleanup.is_err();
        }
        if incomplete {
            eprintln!("pedelec storage: old instance cleanup incomplete");
        }
        Ok(())
    }

    fn freeze(&mut self) -> io::Result<()> {
        self.check()?;
        if !self.frozen {
            self.workers.try_lock()?;
            self.frozen = true;
            self.check()?;
        }
        Ok(())
    }

    fn thaw(&mut self) -> io::Result<()> {
        self.check()?;
        if self.frozen {
            self.workers.unlock()?;
            self.frozen = false;
        }
        Ok(())
    }

    fn command(&mut self, input: Command) -> io::Result<()> {
        self.check()?;
        match input.action.as_str() {
            "freeze" => return self.freeze(),
            "thaw" => return self.thaw(),
            "seal" if self.frozen => {
                let seal = self.root.join(SEALED);
                return if present(&seal)? {
                    plain_file(&seal)
                } else {
                    create_marker(&seal, b"")
                };
            }
            _ => {}
        }
        if self.frozen || present(&self.root.join(SEALED))? {
            return Err(refused());
        }
        let (instance, _) = self.instance.as_ref().ok_or_else(refused)?;
        let session = input
            .session
            .filter(|value| is_session_segment(value))
            .ok_or_else(refused)?;
        let leases = instance.join(".leases");
        let proof = session_proof(&leases, &session);
        let artifacts = instance.join("artifacts");
        let artifact = artifacts.join(&session);
        let states = instance.join("provider-state");
        let ollama = states.join("ollama");
        let state = ollama.join(&session);
        match input.action.as_str() {
            "prepare" => {
                // A Session ID cannot be reassigned while any old writer might still open its lease.
                if present(&leases.join(&session))? || present(&artifact)? || present(&state)? {
                    return Err(refused());
                }
                anchored_lock(&leases, &session, true)?;
                create_marker(&proof, b"")?;
                create_directory(&artifacts)?;
                create_directory(&artifact)?;
                mark_session_directory(&proof, &artifact)?;
                if input.ollama == Some(true) {
                    create_directory(&states)?;
                    create_directory(&ollama)?;
                    create_directory(&state)?;
                    mark_session_directory(&proof, &state)?;
                }
            }
            "resume" => {
                anchored_lock(&leases, &session, false)?;
                verify_session_directory(&proof, &artifact)?;
                if input.ollama == Some(true) {
                    verify_session_directory(&proof, &state)?;
                }
            }
            "collect" | "discard-staging" => {
                let lock = anchored_lock(&leases, &session, false)?;
                lock.try_lock()?;
                verify_anchor(&lock, &leases, &session)?;
                verify_session_directory(&proof, &artifact)?;
                if input.action == "discard-staging" {
                    remove_child(&artifact.join(".pedelec-staging"))?;
                    return self.check();
                }
                if input.ollama == Some(true) {
                    verify_session_directory(&proof, &state)?;
                }
                remove_child(&artifact)?;
                if input.ollama == Some(true) {
                    remove_child(&state)?;
                }
                // Remove the second name first so no late process can acquire a valid lease pair.
                fs::remove_file(leases.join(format!("{session}.anchor")))?;
                drop(lock);
                fs::remove_file(leases.join(&session))?;
                fs::remove_file(proof)?;
                return self.check();
            }
            _ => return Err(refused()),
        }
        let staging = artifact.join(".pedelec-staging");
        create_directory(&staging)?;
        create_directory(&staging.join(session))?;
        self.check()
    }
}

fn diagnostic(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::WouldBlock => "busy",
        io::ErrorKind::PermissionDenied => "access-denied",
        io::ErrorKind::CrossesDevices => "cross-device",
        _ => "refused",
    }
}

pub fn run(root: PathBuf, id: Option<&str>) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    let mut keeper = match Keeper::start(root, id) {
        Ok(keeper) => keeper,
        Err(error) => {
            writeln!(stdout, "{}", diagnostic(&error))?;
            stdout.flush()?;
            return Err(error);
        }
    };
    writeln!(stdout, "ok")?;
    stdout.flush()?;
    for line in io::stdin().lock().lines() {
        let line = line?;
        let result = serde_json::from_str::<Command>(&line)
            .map_err(io::Error::other)
            .and_then(|input| keeper.command(input));
        writeln!(stdout, "{}", result.as_ref().err().map_or("ok", diagnostic))?;
        stdout.flush()?;
    }
    Ok(())
}

pub fn validate_session_paths(
    lease: Option<&StorageLease>,
    id: &str,
    provider: &str,
    state: Option<&str>,
    staging: Option<&str>,
) -> io::Result<()> {
    let Some(lease) = lease else {
        return Ok(());
    };
    if session_segment(id) != lease.session {
        return Err(refused());
    }
    let expected = lease
        .instance
        .join("artifacts")
        .join(&lease.session)
        .join(".pedelec-staging")
        .join(&lease.session);
    if staging.map(Path::new) != Some(expected.as_path()) {
        return Err(refused());
    }
    directory(&expected)?;
    let proof = session_proof(&lease.instance.join(".leases"), &lease.session);
    verify_session_directory(
        &proof,
        &lease.instance.join("artifacts").join(&lease.session),
    )?;
    if provider == "ollama" {
        let expected = lease.provider_state();
        if state.map(Path::new) != Some(expected.as_path()) {
            return Err(refused());
        }
        verify_session_directory(&proof, &expected)?;
    } else if state.is_some() {
        return Err(refused());
    }
    Ok(())
}

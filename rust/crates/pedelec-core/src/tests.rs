use super::*;

#[cfg(unix)]
fn executable_shell_fixture(temp: &tempfile::TempDir, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let shell = temp.path().join("bash");
    fs::write(&shell, body).unwrap();
    fs::set_permissions(&shell, fs::Permissions::from_mode(0o700)).unwrap();
    shell
}

#[test]
fn bootstrap_instruction_keeps_the_compact_invariant_contract() {
    let instruction = build_pedelec_bootstrap_instruction();
    assert!(instruction.contains("Pedelec Host Context is generated integration context"));
    assert!(instruction.contains("Use Pedelec App Tools through their listed"));
    assert!(!instruction.contains("pedelec-ts-runtime"));
    assert!(!instruction.contains("Deno"));
    assert!(instruction.contains("readSpecCommand` / `callCommand"));
    assert!(instruction.contains("Invoke each listed Pedelec App Tool call once"));
    assert!(instruction.contains(
        "Before accessing local files outside the declared workspace, ask the user for permission"
    ));
    assert!(instruction
        .contains("An exact artifact the provider generated and returned in the current turn"));
    assert!(instruction.contains("does not permit browsing its directory"));
    assert!(instruction.contains("consume the structured result or error returned by Pedelec"));
    assert!(!instruction.contains("Exact-retry"));
    assert!(!instruction.contains(".pedelec-runtime/assets"));
    assert!(!instruction.contains("Pedelec is the host application"));
    assert!(!instruction.contains("`assets/` is the shared App and Agent file directory"));
    assert!(!instruction.contains("ambiguous transport failure"));
    assert!(!instruction.contains("join an invocation"));
    assert!(!instruction.contains("PEDELEC_PREPARED"));
    assert!(!instruction.contains("tool-spec <tool-name>"));
    assert!(!instruction.contains("tool-call <tool-name> '<json_args>'"));
    assert!(!instruction.contains("run <workspace-relative-script-path>"));
    assert!(!instruction.contains("run -"));
}

#[test]
fn antigravity_custom_agent_replaces_a_stale_workspace_copy() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(PEDELEC_ANTIGRAVITY_AGENT_DIR);
    fs::create_dir_all(&directory).unwrap();
    let agent = directory.join(PEDELEC_ANTIGRAVITY_AGENT_FILE);
    fs::write(
        &agent,
        "---\nname: pedelec-runtime\nuse `pedelec-ts-runtime`",
    )
    .unwrap();

    ensure_antigravity_custom_agent(temp.path()).unwrap();

    assert!(!fs::read_to_string(agent)
        .unwrap()
        .contains("pedelec-ts-runtime"));
}

#[test]
fn antigravity_custom_agent_never_replaces_a_file_it_did_not_write() {
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path().join(".agents/agents/pedelec-runtime");
    std::fs::create_dir_all(&directory).unwrap();
    let agent = directory.join("agent.md");

    std::fs::write(&agent, "my own notes").unwrap();
    assert!(ensure_antigravity_custom_agent(temp.path()).is_err());
    assert_eq!(std::fs::read_to_string(&agent).unwrap(), "my own notes");

    std::fs::write(&agent, "---\nname: pedelec-runtime\nolder bootstrap").unwrap();
    ensure_antigravity_custom_agent(temp.path()).unwrap();
    assert!(std::fs::read_to_string(&agent)
        .unwrap()
        .contains("mainAgent: true"));
}

#[test]
#[cfg(unix)]
fn antigravity_custom_agent_does_not_write_through_a_link() {
    let temp = tempfile::tempdir().unwrap();
    let outside = temp.path().join("outside.md");
    std::fs::write(&outside, "---\nname: pedelec-runtime\nkeep").unwrap();
    let workspace = temp.path().join("workspace");
    let directory = workspace.join(".agents/agents/pedelec-runtime");
    std::fs::create_dir_all(&directory).unwrap();
    std::os::unix::fs::symlink(&outside, directory.join("agent.md")).unwrap();

    assert!(ensure_antigravity_custom_agent(&workspace).is_err());
    assert_eq!(
        std::fs::read_to_string(&outside).unwrap(),
        "---\nname: pedelec-runtime\nkeep"
    );
}

#[test]
fn antigravity_hooks_keep_what_the_workspace_already_declared() {
    let temp = tempfile::tempdir().unwrap();
    let agents = temp.path().join(".agents");
    std::fs::create_dir_all(&agents).unwrap();
    std::fs::write(
        agents.join("hooks.json"),
        r#"{"my-hook":{"command":"mine"}}"#,
    )
    .unwrap();

    ensure_antigravity_workspace_assets(temp.path()).unwrap();

    let hooks: serde_json::Value =
        serde_json::from_slice(&std::fs::read(agents.join("hooks.json")).unwrap()).unwrap();
    assert_eq!(hooks["my-hook"]["command"], "mine");
}

#[test]
fn antigravity_custom_agent_materializes_the_compact_shared_contract() {
    let temp = tempfile::tempdir().unwrap();
    ensure_antigravity_custom_agent(temp.path()).unwrap();

    let agent = std::fs::read_to_string(
        temp.path()
            .join(".agents")
            .join("agents")
            .join("pedelec-runtime")
            .join("agent.md"),
    )
    .unwrap();
    assert!(agent.contains("name: pedelec-runtime"));
    assert!(agent.contains("mainAgent: true"));
    assert!(agent.contains("Pedelec Host Context is generated integration context"));
    assert!(!agent.contains("pedelec-ts-runtime"));
    assert!(agent.contains("Invoke each listed Pedelec App Tool call once"));
    assert!(agent.contains("consume the structured result or error returned by Pedelec"));
    assert!(!agent.contains("Exact-retry"));
    assert!(!agent.contains("thread-"));
    assert!(!agent.contains("run <workspace-relative-script-path>"));
    assert!(!agent.contains("ambiguous transport failure"));
}

#[cfg(windows)]
#[test]
fn provider_version_command_runs_script_wrappers_through_headless_cmd() {
    let command = provider_version_command(Path::new("C:/providers/codex.cmd"), None);

    assert_eq!(command.get_program(), "cmd.exe");
    assert_eq!(
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>(),
        vec!["/d", "/c", "call", "C:/providers/codex.cmd"]
    );
}

#[test]
fn provider_probe_output_overflow_is_not_a_complete_result() {
    let exact_limit = vec![0; PROVIDER_PROBE_MAX_OUTPUT_BYTES as usize];
    assert_eq!(
        read_bounded_provider_probe_output(std::io::Cursor::new(exact_limit.clone())).unwrap(),
        exact_limit
    );

    let oversized = vec![0; PROVIDER_PROBE_MAX_OUTPUT_BYTES as usize + 1];
    assert!(read_bounded_provider_probe_output(std::io::Cursor::new(oversized)).is_err());
}

#[cfg(windows)]
#[test]
fn windows_provider_fallback_paths_include_claude_native_bin() {
    let home = dirs::home_dir().expect("Windows test environment should have a home directory");

    assert!(provider_fallback_paths().contains(&home.join(".local/bin")));
}

#[test]
fn merge_provider_paths_keeps_process_login_and_existing_fallback_directories() {
    let temp = tempfile::tempdir().unwrap();
    let process_dir = temp.path().join("process");
    let login_dir = temp.path().join("login");
    let fallback_dir = temp.path().join("fallback");
    let missing_dir = temp.path().join("missing");
    fs::create_dir_all(&process_dir).unwrap();
    fs::create_dir_all(&login_dir).unwrap();
    fs::create_dir_all(&fallback_dir).unwrap();

    let process_path = env::join_paths([&process_dir]).unwrap();
    let login_path = env::join_paths([&login_dir, &process_dir]).unwrap();
    let merged = merge_provider_paths(
        Some(&process_path),
        Some(&login_path),
        vec![fallback_dir.clone(), login_dir.clone(), missing_dir],
    );
    let paths = env::split_paths(&merged).collect::<Vec<_>>();

    assert_eq!(paths, vec![process_dir, login_dir, fallback_dir]);
}

#[test]
fn login_shell_path_parser_handles_noise_and_rejects_invalid_output() {
    let parsed = parse_login_shell_path_output(
        b"startup noise\nprompt/plugin warning\n__PEDELEC_PATH_START__/one:/two__PEDELEC_PATH_END__\nmore noise",
    )
    .unwrap();
    assert_eq!(parsed, OsString::from("/one:/two"));

    assert!(parse_login_shell_path_output(b"__PEDELEC_PATH_END__/one").is_none());
    assert!(parse_login_shell_path_output(b"__PEDELEC_PATH_START__/one").is_none());
    assert!(parse_login_shell_path_output(b"__PEDELEC_PATH_START____PEDELEC_PATH_END__").is_none());
    assert!(parse_login_shell_path_output(&[0xff, 0xfe]).is_none());
    assert_eq!(
        parse_login_shell_path_output(
            b"\xffstartup\n__PEDELEC_PATH_START__/one:/two__PEDELEC_PATH_END__"
        )
        .unwrap(),
        OsString::from("/one:/two")
    );
}

#[test]
fn macos_shell_strategy_uses_noninteractive_login_for_zsh() {
    assert_eq!(
        macos_shell_probe_arguments(Path::new("/opt/homebrew/bin/zsh")),
        vec![vec!["-l", "-c", MACOS_PATH_MARKER_COMMAND]]
    );
}

#[test]
fn macos_shell_strategy_uses_only_noninteractive_login_for_bash() {
    assert_eq!(
        macos_shell_probe_arguments(Path::new("/usr/local/bin/bash")),
        vec![vec!["-l", "-c", MACOS_PATH_MARKER_COMMAND]]
    );
}

#[test]
fn macos_shell_strategies_never_use_interactive_mode() {
    for shell in ["/bin/zsh", "/bin/bash", "/bin/sh", "/custom/shell"] {
        let strategies = macos_shell_probe_arguments(Path::new(shell));
        assert_eq!(strategies.len(), 1);
        for args in strategies {
            assert!(!args.contains(&"-i"), "interactive PATH probe for {shell}");
            assert_eq!(args, vec!["-l", "-c", MACOS_PATH_MARKER_COMMAND]);
        }
    }
}

#[cfg(unix)]
#[test]
fn bash_noninteractive_login_probe_extracts_marked_path() {
    let temp = tempfile::tempdir().unwrap();
    let shell = executable_shell_fixture(
        &temp,
        "#!/bin/sh\n[ \"$#\" -eq 3 ] && [ \"$1\" = \"-l\" ] && [ \"$2\" = \"-c\" ] || exit 1\nprintf 'warning\\n'\nPATH=/login/bin\neval \"$3\"\n",
    );
    // Success/behaviour fixtures: 1 s deadlines starved under parallel test load; timeouts are covered by the 100 ms test.

    let path =
        resolve_macos_shell_path_with_strategies(&shell, Instant::now() + Duration::from_secs(10))
            .unwrap();

    assert_eq!(path, OsString::from("/login/bin"));
}

#[cfg(unix)]
#[test]
fn failed_login_probe_keeps_process_and_fallback_paths_without_retry() {
    let temp = tempfile::tempdir().unwrap();
    let shell = executable_shell_fixture(
        &temp,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$0.calls\"\nif [ \"$1\" = \"-i\" ]; then\n  printf '%s/interactive/bin%s\\n' '__PEDELEC_PATH_START__' '__PEDELEC_PATH_END__'\n  exit 0\nfi\nexit 1\n",
    );

    let path =
        resolve_macos_shell_path_with_strategies(&shell, Instant::now() + Duration::from_secs(10));

    assert!(path.is_none());
    assert_eq!(
        fs::read_to_string(temp.path().join("bash.calls")).unwrap(),
        format!("-l\n-c\n{MACOS_PATH_MARKER_COMMAND}\n")
    );

    let process_dir = temp.path().join("process");
    let fallback_dir = temp.path().join("fallback");
    fs::create_dir_all(&process_dir).unwrap();
    fs::create_dir_all(&fallback_dir).unwrap();
    let process_path = env::join_paths([&process_dir]).unwrap();
    let merged = merge_provider_paths(
        Some(&process_path),
        path.as_ref(),
        vec![fallback_dir.clone()],
    );
    assert_eq!(
        env::split_paths(&merged).collect::<Vec<_>>(),
        vec![process_dir, fallback_dir]
    );
}

#[cfg(unix)]
#[test]
fn bash_login_probe_paths_are_deduplicated() {
    let temp = tempfile::tempdir().unwrap();
    let shell = executable_shell_fixture(
        &temp,
        "#!/bin/sh\n[ \"$#\" -eq 3 ] && [ \"$1\" = \"-l\" ] && [ \"$2\" = \"-c\" ] || exit 1\nPATH=/login/bin:/shared/bin:/login/bin\neval \"$3\"\n",
    );

    let path =
        resolve_macos_shell_path_with_strategies(&shell, Instant::now() + Duration::from_secs(10))
            .unwrap();

    assert_eq!(
        env::split_paths(&path).collect::<Vec<_>>(),
        vec![PathBuf::from("/login/bin"), PathBuf::from("/shared/bin")]
    );
}

#[cfg(unix)]
#[test]
fn shell_probe_timeout_is_bounded_and_reaps_the_child() {
    let temp = tempfile::tempdir().unwrap();
    let shell = executable_shell_fixture(&temp, "#!/bin/sh\nwhile true; do :; done\n");
    let started = Instant::now();

    let result = probe_shell_path(
        &shell,
        &["-c", MACOS_PATH_MARKER_COMMAND],
        Instant::now() + Duration::from_millis(100),
    );

    assert!(result.is_none());
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[cfg(windows)]
#[test]
fn provider_cache_candidate_identity_is_case_insensitive_on_windows() {
    let lower = Path::new(r"C:\Users\Person\codex.exe");
    let upper = Path::new(r"c:\users\person\CODEX.EXE");
    assert_eq!(
        normalized_provider_candidate_identity(lower),
        normalized_provider_candidate_identity(upper)
    );
    assert_eq!(
        deduplicate_provider_candidates(vec![lower.to_path_buf(), upper.to_path_buf()]).len(),
        1
    );
}

#[test]
fn provider_binary_lookup_candidates_include_windows_opencode_names() {
    let dirs = vec![PathBuf::from("C:/bin")];
    let candidates = provider_binary_lookup_candidates("opencode", &dirs);

    #[cfg(windows)]
    assert_eq!(
        candidates,
        vec![
            PathBuf::from("C:/bin/opencode"),
            PathBuf::from("C:/bin/opencode.exe"),
            PathBuf::from("C:/bin/opencode.cmd"),
            PathBuf::from("C:/bin/opencode.bat"),
        ]
    );

    #[cfg(not(windows))]
    assert_eq!(candidates, vec![PathBuf::from("C:/bin").join("opencode")]);
}

#[test]
fn provider_binary_lookup_candidates_include_windows_cursor_agent_names() {
    let dirs = vec![PathBuf::from("C:/bin")];
    let candidates = provider_binary_lookup_candidates("cursor-agent", &dirs);

    #[cfg(windows)]
    assert_eq!(
        candidates,
        vec![
            PathBuf::from("C:/bin/cursor-agent"),
            PathBuf::from("C:/bin/cursor-agent.exe"),
            PathBuf::from("C:/bin/cursor-agent.cmd"),
            PathBuf::from("C:/bin/cursor-agent.bat"),
        ]
    );

    #[cfg(not(windows))]
    assert_eq!(
        candidates,
        vec![PathBuf::from("C:/bin").join("cursor-agent")]
    );
}

#[test]
fn cursor_binary_lookup_candidates_do_not_include_legacy_agent_aliases() {
    let dirs = vec![PathBuf::from("C:/bin")];
    let candidates = provider_binary_lookup_candidates("cursor-agent", &dirs);

    assert!(candidates.iter().all(|candidate| {
        !matches!(
            candidate.file_name().and_then(|name| name.to_str()),
            Some("agent") | Some("agent.exe") | Some("agent.cmd") | Some("agent.bat")
        )
    }));
}

#[test]
fn bootstrap_keeps_the_compact_invariant_contract() {
    let instruction = build_pedelec_bootstrap_instruction();
    assert!(!instruction.contains("pedelec-ts-runtime"));
    assert!(!instruction.contains("Deno"));
    assert!(instruction.contains("readSpecCommand` / `callCommand"));
    assert!(instruction.contains("Invoke each listed Pedelec App Tool call once"));
    assert!(instruction.contains("consume the structured result or error returned by Pedelec"));
    assert!(!instruction.contains("Exact-retry"));
    assert!(!instruction.contains("TOOL_TIMEOUT"));
    assert!(!instruction.contains("authoritative Pedelec workspace root"));
    assert!(!instruction.contains("ambiguous transport failure"));
    assert!(!instruction.contains("PEDELEC_PREPARED"));
}

#[test]
fn persistent_prepare_prompt_uses_brief_acknowledgement_without_exact_token() {
    let prompt = build_persistent_prepare_prompt(None);
    assert!(prompt.contains("[Session Preparation]"));
    assert!(prompt.contains("Do not call tools or modify files."));
    assert!(prompt.contains("A brief acknowledgement is sufficient."));
    assert!(!prompt.contains("PEDELEC_PREPARED"));
}

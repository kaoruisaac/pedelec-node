fn main() {
    if std::env::args().skip(1).eq(["--version".to_string()]) {
        println!(
            "{{\"name\":\"{}\",\"version\":\"{}\",\"protocolVersion\":1}}",
            env!("CARGO_PKG_NAME"),
            env!("CARGO_PKG_VERSION")
        );
        return;
    }
    let _lease = match pedelec_shared::storage::StorageLease::from_env() {
        Ok(Some(lease))
            if std::env::var_os("PEDELEC_AGENT_SESSION_ROOT")
                .is_some_and(|root| std::path::PathBuf::from(root) == lease.provider_state()) =>
        {
            Some(lease)
        }
        Ok(None) => None,
        _ => {
            eprintln!("pedelec agent: SDK storage lease refused");
            std::process::exit(1);
        }
    };
    std::process::exit(pedelec_agent::run());
}

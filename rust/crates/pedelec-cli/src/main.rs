fn main() {
    if std::env::args().skip(1).eq(["--version".to_string()]) {
        println!(
            "{{\"name\":\"{}\",\"version\":\"{}\",\"protocolVersion\":1}}",
            env!("CARGO_PKG_NAME"),
            env!("CARGO_PKG_VERSION")
        );
        return;
    }
    pedelec_cli::run();
}

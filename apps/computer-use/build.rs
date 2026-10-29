fn main() {
    #[cfg(windows)]
    {
        let icon =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/icons/icon.ico");
        println!("cargo:rerun-if-changed={}", icon.display());
        // 在构建时写入 EXE 资源, 安装后的程序不依赖源码目录中的图标文件.
        tauri_winres::WindowsResource::new()
            .set_icon(icon.to_str().expect("icon path must be UTF-8"))
            .compile()
            .expect("failed to embed Ema icon");
    }
}

// 为 Tauri 构建注入目标平台标识，并生成桌面宿主资源清单。
fn main() {
    if let Ok(target) = std::env::var("TARGET") {
        println!("cargo:rustc-env=EMA_TARGET_TRIPLE={target}");
    }
    tauri_build::build();
}

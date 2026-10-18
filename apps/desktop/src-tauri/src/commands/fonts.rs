use std::sync::OnceLock;

// 枚举需要读取系统字体文件, 每次运行只做一次; 新装字体在下次启动后出现.
static SYSTEM_FONTS: OnceLock<Vec<String>> = OnceLock::new();

#[tauri::command]
pub fn list_system_fonts() -> Vec<String> {
    SYSTEM_FONTS.get_or_init(collect_system_fonts).clone()
}

fn collect_system_fonts() -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut families: Vec<String> = db
        .faces()
        .filter_map(|face| face.families.first().map(|(name, _)| name.clone()))
        .filter(|name| !name.is_empty())
        .collect();
    families.sort_unstable();
    families.dedup();
    families
}

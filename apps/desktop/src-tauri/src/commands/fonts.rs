// 本机字体枚举: fontdb 读系统字体库.
// 每次运行只解析一次(数百个字体文件的元数据不是免费活), 运行期间新装的字体下次启动才出现.
use std::sync::OnceLock;

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

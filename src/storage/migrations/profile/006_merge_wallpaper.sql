-- 主窗口沿用 Settings 的完整壁纸设置, 不重新生成图片参数或修改文件名.
INSERT OR REPLACE INTO settings (key, value_json, updated_at)
SELECT 'frontend.wallpaper', value_json, updated_at
FROM settings
WHERE key = 'frontend.wallpaper.settings';

DELETE FROM settings
WHERE key IN ('frontend.wallpaper.chat', 'frontend.wallpaper.settings');

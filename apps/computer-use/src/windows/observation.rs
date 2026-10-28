use crate::types::ComputerWindow;

use super::accessibility::AccessibleControls;

pub struct Observation {
    pub id: String,
    pub control_id: String,
    // 截图时记下的数字. 与当前 observation_revision 不同就说明旧图不能再用于操作.
    // 用户点击继续不会把这个数字改回去.
    pub observation_revision: u64,
    pub window: ComputerWindow,
    // 截图图片的像素尺寸, 换算桌面输入位置时使用.
    pub width: u32,
    pub height: u32,
    pub controls: AccessibleControls,
}

impl Observation {
    pub fn desktop_point(&self, x: f64, y: f64) -> Result<(i32, i32), String> {
        if !x.is_finite()
            || !y.is_finite()
            || x < 0.0
            || y < 0.0
            || x >= self.width as f64
            || y >= self.height as f64
        {
            return Err("The point is outside the observed image.".to_owned());
        }
        Ok((
            self.window.x + (x * self.window.width as f64 / self.width as f64).round() as i32,
            self.window.y + (y * self.window.height as f64 / self.height as f64).round() as i32,
        ))
    }
}

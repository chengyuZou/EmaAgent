use std::time::{Duration, Instant};

use windows::core::{Interface, BSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Accessibility::*;

use crate::types::{Action, ComputerElement, ComputerWindow};

pub struct AccessibleControls {
    pub elements: Vec<ComputerElement>,
    pub truncated: bool,
    // 下标就是返回给 Node 的 elementId. 真正操作时用这个下标取出 Windows 控件对象.
    // 这些对象留在创建它们的执行线程, 不通过 JSON 传给 Node.
    handles: Vec<IUIAutomationElement>,
}

impl AccessibleControls {
    pub fn unavailable() -> Self {
        Self {
            elements: Vec::new(),
            handles: Vec::new(),
            truncated: true,
        }
    }

    pub fn read(hwnd: HWND, window: &ComputerWindow) -> Result<Self, String> {
        unsafe {
            let automation: IUIAutomation2 =
                CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
                    .map_err(|error| error.to_string())?;
            let _ = automation.SetConnectionTimeout(1500);
            let _ = automation.SetTransactionTimeout(1500);
            let automation: IUIAutomation = automation.cast().map_err(|error| error.to_string())?;
            let root = automation
                .ElementFromHandle(hwnd)
                .map_err(|error| error.to_string())?;
            let walker = automation
                .ControlViewWalker()
                .map_err(|error| error.to_string())?;
            let mut result = Self {
                elements: Vec::new(),
                handles: Vec::new(),
                truncated: false,
            };
            let deadline = Instant::now() + Duration::from_secs(2);
            // 限制遍历时间和数量. 大窗口读不完时标记 truncated, 不把未读到误报成不存在.
            result.visit(&walker, root, window, 0, deadline);
            Ok(result)
        }
    }

    unsafe fn visit(
        &mut self,
        walker: &IUIAutomationTreeWalker,
        element: IUIAutomationElement,
        window: &ComputerWindow,
        depth: usize,
        deadline: Instant,
    ) {
        if self.elements.len() >= 250 || depth >= 12 || Instant::now() >= deadline {
            self.truncated = true;
            return;
        }
        if element
            .CurrentIsOffscreen()
            .is_ok_and(|value| value.as_bool())
        {
            return;
        }
        if let Ok(rect) = element.CurrentBoundingRectangle() {
            let role = element
                .CurrentLocalizedControlType()
                .map(|value| value.to_string())
                .unwrap_or_default();
            let id = self.handles.len();
            self.elements.push(ComputerElement {
                id,
                name: element
                    .CurrentName()
                    .map(|value| value.to_string())
                    .unwrap_or_default(),
                role,
                enabled: element
                    .CurrentIsEnabled()
                    .is_ok_and(|value| value.as_bool()),
                editable: element
                    .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    .is_ok(),
                invokable: element
                    .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    .is_ok(),
                x: rect.left - window.x,
                y: rect.top - window.y,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
            });
            self.handles.push(element.clone());
        }
        let mut child = walker.GetFirstChildElement(&element).ok();
        while let Some(current) = child {
            if self.truncated || Instant::now() >= deadline {
                self.truncated = true;
                break;
            }
            child = walker.GetNextSiblingElement(&current).ok();
            self.visit(walker, current, window, depth + 1, deadline);
        }
    }

    pub fn perform(&self, action: &Action) -> Result<(), String> {
        let id = match action {
            Action::SetValue { element_id, .. }
            | Action::Invoke { element_id }
            | Action::Focus { element_id } => *element_id,
            _ => return Err("Not an accessibility action.".to_owned()),
        };
        let element = self
            .handles
            .get(id)
            .ok_or("The element id is not in this observation.")?;
        unsafe {
            if !element
                .CurrentIsEnabled()
                .map_err(|error| error.to_string())?
                .as_bool()
            {
                return Err("The element is disabled.".to_owned());
            }
            match action {
                Action::SetValue { text, .. } => {
                    let pattern: IUIAutomationValuePattern = element
                        .GetCurrentPatternAs(UIA_ValuePatternId)
                        .map_err(|error| error.to_string())?;
                    if pattern
                        .CurrentIsReadOnly()
                        .map_err(|error| error.to_string())?
                        .as_bool()
                    {
                        return Err("The element is read-only.".to_owned());
                    }
                    pattern
                        .SetValue(&BSTR::from(text))
                        .map_err(|error| error.to_string())
                }
                Action::Invoke { .. } => {
                    let pattern: IUIAutomationInvokePattern = element
                        .GetCurrentPatternAs(UIA_InvokePatternId)
                        .map_err(|error| error.to_string())?;
                    pattern.Invoke().map_err(|error| error.to_string())
                }
                Action::Focus { .. } => element.SetFocus().map_err(|error| error.to_string()),
                _ => unreachable!(),
            }
        }
    }
}

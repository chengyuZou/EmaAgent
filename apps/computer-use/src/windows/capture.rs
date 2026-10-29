use std::time::{Duration, Instant};

use windows::core::{factory, Interface};
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, HWND, POINT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

pub struct CapturedImage {
    // 已编码的完整 PNG 文件字节, 后面由通信层转成 base64.
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

// Some(hwnd) 截取指定窗口, None 截取主显示器. 等画面期间反复检查是否要求取消.
pub fn capture(hwnd: Option<HWND>, cancelled: impl Fn() -> bool) -> Result<CapturedImage, String> {
    unsafe {
        let interop: IGraphicsCaptureItemInterop =
            factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
                .map_err(|error| error.to_string())?;
        let item: GraphicsCaptureItem = match hwnd {
            Some(hwnd) => interop.CreateForWindow(hwnd),
            None => interop.CreateForMonitor(MonitorFromPoint(
                POINT { x: 0, y: 0 },
                MONITOR_DEFAULTTOPRIMARY,
            )),
        }
        .map_err(|error| error.to_string())?;

        let mut device = None;
        let mut context = None;
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
        .map_err(|error| error.to_string())?;
        let device = device.ok_or("D3D11 did not create a device.")?;
        let context = context.ok_or("D3D11 did not create a context.")?;
        let dxgi: IDXGIDevice = device.cast().map_err(|error| error.to_string())?;
        let direct: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)
            .and_then(|value| value.cast())
            .map_err(|error| error.to_string())?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &direct,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            1,
            item.Size().map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let session = pool
            .CreateCaptureSession(&item)
            .map_err(|error| error.to_string())?;
        let _ = session.SetIsCursorCaptureEnabled(false);

        let result = (|| {
            session.StartCapture().map_err(|error| error.to_string())?;
            let started = Instant::now();
            loop {
                if cancelled() {
                    return Err("Screen observation was interrupted.".to_owned());
                }
                if started.elapsed() > Duration::from_secs(5) {
                    return Err("Timed out waiting for a captured frame.".to_owned());
                }
                match pool.TryGetNextFrame() {
                    Ok(frame) => {
                        let size = frame.ContentSize().map_err(|error| error.to_string())?;
                        let surface = frame.Surface().map_err(|error| error.to_string())?;
                        let access: IDirect3DDxgiInterfaceAccess =
                            surface.cast().map_err(|error| error.to_string())?;
                        let texture: ID3D11Texture2D =
                            access.GetInterface().map_err(|error| error.to_string())?;
                        let mut description = D3D11_TEXTURE2D_DESC::default();
                        texture.GetDesc(&mut description);
                        description.Usage = D3D11_USAGE_STAGING;
                        description.BindFlags = 0;
                        description.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
                        description.MiscFlags = 0;
                        let mut staging = None;
                        device
                            .CreateTexture2D(&description, None, Some(&mut staging))
                            .map_err(|error| error.to_string())?;
                        let staging = staging.ok_or("Failed to create a staging texture.")?;
                        context.CopyResource(&staging, &texture);
                        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                        context
                            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                            .map_err(|error| error.to_string())?;
                        let width = (size.Width.max(1) as u32).min(description.Width);
                        let height = (size.Height.max(1) as u32).min(description.Height);

                        let mut rgb = vec![0u8; width as usize * height as usize * 3];
                        for y in 0..height as usize {
                            // GPU 每行末尾可能有补齐字节, 下一行按 RowPitch 寻址, 不能按图片宽度硬接.
                            let row = std::slice::from_raw_parts(
                                (mapped.pData as *const u8).add(y * mapped.RowPitch as usize),
                                width as usize * 4,
                            );
                            for x in 0..width as usize {
                                let target = (y * width as usize + x) * 3;
                                rgb[target] = row[x * 4 + 2]; // R
                                rgb[target + 1] = row[x * 4 + 1]; // G
                                rgb[target + 2] = row[x * 4]; // B
                            }
                        }
                        context.Unmap(&staging, 0);
                        let _ = frame.Close();
                        let mut bytes = Vec::new();
                        {
                            let mut encoder = png::Encoder::new(&mut bytes, width, height);
                            encoder.set_color(png::ColorType::Rgb);
                            encoder.set_depth(png::BitDepth::Eight);
                            let mut writer =
                                encoder.write_header().map_err(|error| error.to_string())?;
                            writer
                                .write_image_data(&rgb)
                                .map_err(|error| error.to_string())?;
                        }
                        return Ok(CapturedImage {
                            png: bytes,
                            width,
                            height,
                        });
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(10)),
                }
            }
        })();
        // 成功, 失败和取消都要关闭捕获, 否则系统可能还显示捕获边框并占着图形设备.
        let _ = session.Close();
        let _ = pool.Close();
        result
    }
}

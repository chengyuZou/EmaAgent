#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
pub use unix::NativeProcessTree;
#[cfg(windows)]
pub use windows::NativeProcessTree;

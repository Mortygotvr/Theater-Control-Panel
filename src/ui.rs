//! OBS's UI thread, where every webview lives, and a task queue onto it.
//!
//! Tasks are posted to a hidden message-only window, so they always run later
//! from the thread's message loop. obs_queue_task can't be used for this: on the
//! UI thread it runs the task immediately (Qt::AutoConnection), which would run
//! commands inside WebView2 event handlers, where creating a webview deadlocks.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::thread::{self, ThreadId};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, HWND_MESSAGE, PostMessageW, RegisterClassExW, WINDOW_EX_STYLE,
    WINDOW_STYLE, WM_APP, WNDCLASSEXW,
};
use windows::core::{PCWSTR, w};

use crate::win32;

type Task = Box<dyn FnOnce() + Send>;

const WM_RUN_TASKS: u32 = WM_APP + 0x7A;

static UI_THREAD: OnceLock<ThreadId> = OnceLock::new();
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
static TASK_WINDOW: AtomicIsize = AtomicIsize::new(0);
static TASKS: Mutex<VecDeque<Task>> = Mutex::new(VecDeque::new());

/// Records the calling thread as the UI thread and creates the task window.
/// Called from obs_module_load.
pub fn init() {
    let _ = UI_THREAD.set(thread::current().id());
    unsafe {
        let Ok(instance) = GetModuleHandleW(None) else { return };
        let class = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(task_window_proc),
            hInstance: instance.into(),
            lpszClassName: w!("TheaterControlPanelTasks"),
            ..Default::default()
        };
        RegisterClassExW(&class);
        if let Ok(hwnd) = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("TheaterControlPanelTasks"),
            PCWSTR::null(),
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance.into()),
            None,
        ) {
            TASK_WINDOW.store(hwnd.0 as isize, Ordering::Release);
        }
    }
}

/// Destroys the task window. Called from obs_module_unload.
pub fn cleanup() {
    let hwnd = TASK_WINDOW.swap(0, Ordering::AcqRel);
    if hwnd != 0 {
        unsafe {
            let _ = DestroyWindow(win32::hwnd(hwnd));
        }
    }
    TASKS.lock().unwrap_or_else(PoisonError::into_inner).clear();
}

pub fn is_ui_thread() -> bool {
    UI_THREAD.get() == Some(&thread::current().id())
}

/// Set on OBS exit: no new webviews, and worker threads wind down.
pub fn begin_shutdown() {
    SHUTTING_DOWN.store(true, Ordering::Release);
}

pub fn shutting_down() -> bool {
    SHUTTING_DOWN.load(Ordering::Acquire)
}

/// Queues `f` to run on the UI thread, from its message loop. Callable from any
/// thread; always deferred, even on the UI thread.
pub fn post(f: impl FnOnce() + Send + 'static) {
    TASKS.lock().unwrap_or_else(PoisonError::into_inner).push_back(Box::new(f));
    let hwnd = TASK_WINDOW.load(Ordering::Acquire);
    if hwnd != 0 {
        unsafe {
            let _ = PostMessageW(Some(win32::hwnd(hwnd)), WM_RUN_TASKS, WPARAM(0), LPARAM(0));
        }
    }
}

fn next_task() -> Option<Task> {
    TASKS.lock().unwrap_or_else(PoisonError::into_inner).pop_front()
}

unsafe extern "system" fn task_window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_RUN_TASKS {
        while let Some(task) = next_task() {
            crate::guard("UI task", task);
        }
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

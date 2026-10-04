//! "Control audio via OBS" for Theater Web Sources. Captures everything one WebView2
//! environment plays (its browser process and children) with Windows' process
//! loopback capture, the API behind OBS's Application Audio Capture, and outputs
//! it as the source's audio: a mixer slider, meters, filters and monitoring.
//! Like application capture, the page also still plays on the speakers.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, E_POINTER, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient,
    IAudioClient, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::core::{Error, HRESULT, Interface, Ref, implement};

use crate::obs::{self, log_warn};

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
/// Interleaved 32-bit float frames.
const FRAME_BYTES: u32 = CHANNELS as u32 * 4;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const VT_BLOB: u16 = 65;

/// An obs_source_t*, handed to the capture thread. OBS keeps the source alive
/// until its destroy callback returns, and that stops (joins) the capture first.
/// Only passed to OBS functions that are safe to call from any thread.
#[derive(Clone, Copy)]
pub struct SourcePtr(pub *mut c_void);
unsafe impl Send for SourcePtr {}
unsafe impl Sync for SourcePtr {}

/// A running capture; dropping it stops and joins the thread.
pub struct AudioCapture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl AudioCapture {
    /// Captures what process `pid` and its children play into `source`.
    pub fn start(pid: u32, source: SourcePtr, source_id: u64) -> AudioCapture {
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread = std::thread::Builder::new()
            .name("control panel audio".into())
            .spawn(move || {
                if let Err(e) = unsafe { run(pid, source, &thread_stop) } {
                    log_warn!("Theater Web Source {source_id}: audio capture stopped: {e}");
                }
            })
            .ok();
        AudioCapture { stop, thread }
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

unsafe fn run(pid: u32, source: SourcePtr, stop: &AtomicBool) -> windows::core::Result<()> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
    let result = unsafe { capture(pid, source, stop) };
    unsafe { CoUninitialize() };
    result
}

unsafe fn capture(pid: u32, source: SourcePtr, stop: &AtomicBool) -> windows::core::Result<()> {
    let client = unsafe { activate(pid)? };
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
        nChannels: CHANNELS,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * FRAME_BYTES,
        nBlockAlign: FRAME_BYTES as u16,
        wBitsPerSample: 32,
        cbSize: 0,
    };
    let flags = AUDCLNT_STREAMFLAGS_LOOPBACK
        | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    // 200 ms buffer, in 100 ns units.
    unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2_000_000, 0, &format, None)? };
    let event = unsafe { CreateEventW(None, false, false, None)? };
    let result = unsafe { read_packets(&client, event, source, stop) };
    unsafe {
        let _ = client.Stop();
        let _ = CloseHandle(event);
    }
    result
}

unsafe fn read_packets(client: &IAudioClient, event: HANDLE, source: SourcePtr, stop: &AtomicBool) -> windows::core::Result<()> {
    unsafe {
        client.SetEventHandle(event)?;
        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        let mut silence: Vec<u8> = Vec::new();
        while !stop.load(Ordering::Acquire) {
            if WaitForSingleObject(event, 100) != WAIT_OBJECT_0 {
                continue;
            }
            while capture.GetNextPacketSize()? > 0 {
                let mut data = std::ptr::null_mut();
                let mut frames = 0;
                let mut buffer_flags = 0;
                let mut qpc_position = 0;
                capture.GetBuffer(&mut data, &mut frames, &mut buffer_flags, None, Some(&mut qpc_position))?;
                if frames > 0 {
                    let samples = if buffer_flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                        silence.resize((frames * FRAME_BYTES) as usize, 0);
                        silence.as_ptr()
                    } else {
                        data as *const u8
                    };
                    let mut planes = [std::ptr::null(); 8];
                    planes[0] = samples;
                    let audio = obs::SourceAudio {
                        data: planes,
                        frames,
                        speakers: obs::SPEAKERS_STEREO,
                        format: obs::AUDIO_FORMAT_FLOAT,
                        samples_per_sec: SAMPLE_RATE,
                        // QPC position is in 100 ns units, on os_gettime_ns's clock.
                        timestamp: if qpc_position > 0 { qpc_position * 100 } else { obs::os_gettime_ns() },
                    };
                    obs::obs_source_output_audio(source.0, &audio);
                }
                capture.ReleaseBuffer(frames)?;
            }
        }
    }
    Ok(())
}

/// Opens a process loopback capture of `pid` and its children.
unsafe fn activate(pid: u32) -> windows::core::Result<IAudioClient> {
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    // A PROPVARIANT holding the params as a VT_BLOB.
    #[repr(C)]
    struct BlobVariant {
        vt: u16,
        reserved: [u16; 3],
        size: u32,
        data: *const AUDIOCLIENT_ACTIVATION_PARAMS,
    }
    let blob = BlobVariant {
        vt: VT_BLOB,
        reserved: [0; 3],
        size: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        data: &params,
    };

    let (tx, rx) = mpsc::channel();
    let handler: IActivateAudioInterfaceCompletionHandler = Completion(Mutex::new(Some(tx))).into();
    let _operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&blob as *const BlobVariant as *const PROPVARIANT),
            &handler,
        )?
    };
    let client = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| Error::new(HRESULT(0x8000_000Au32 as i32), "audio capture didn't start"))?
        .map_err(Error::from_hresult)?;
    Ok(unsafe { IAudioClient::from_raw(client as *mut c_void) })
}

/// Hands the activated IAudioClient (as a raw pointer, to cross threads) back
/// to `activate`.
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Completion(Mutex<Option<mpsc::Sender<Result<usize, HRESULT>>>>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Completion_Impl {
    fn ActivateCompleted(&self, operation: Ref<IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
        let result = (|| unsafe {
            let operation = operation.ok()?;
            let mut status = HRESULT(0);
            let mut activated = None;
            operation.GetActivateResult(&mut status, &mut activated)?;
            status.ok()?;
            let client: IAudioClient = activated.ok_or_else(|| Error::from_hresult(E_POINTER))?.cast()?;
            Ok::<usize, Error>(client.into_raw() as usize)
        })();
        if let Some(tx) = self.0.lock().ok().and_then(|mut tx| tx.take()) {
            let _ = tx.send(result.map_err(|e| e.code()));
        }
        Ok(())
    }
}

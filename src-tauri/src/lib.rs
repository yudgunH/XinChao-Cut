use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};

/// Holds the spawned Python backend so we can stop it when the app exits.
struct BackendProc(Mutex<Option<Child>>);

#[derive(Default)]
struct SetupRuntime {
    running: bool,
    pid: Option<u32>,
}

/// Single-flight setup ownership. The worker thread streams output, while this
/// state lets a reopened wizard attach to the same process and lets app exit
/// terminate the setup tree instead of orphaning pip/cmd children.
struct SetupProc(Mutex<SetupRuntime>);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
mod win_process_tree {
    use std::collections::{HashMap, HashSet, VecDeque};
    use std::ffi::c_void;
    use std::mem;

    type Handle = *mut c_void;
    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const PROCESS_TERMINATE: u32 = 0x0001;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct ProcessEntry32W {
        dwSize: u32,
        cntUsage: u32,
        th32ProcessID: u32,
        th32DefaultHeapID: usize,
        th32ModuleID: u32,
        cntThreads: u32,
        th32ParentProcessID: u32,
        pcPriClassBase: i32,
        dwFlags: u32,
        szExeFile: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> Handle;
        fn TerminateProcess(process: Handle, exit_code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    fn descendants(root_pid: u32) -> Vec<u32> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
            return Vec::new();
        }
        let mut parent_by_pid = HashMap::<u32, u32>::new();
        let mut entry: ProcessEntry32W = unsafe { mem::zeroed() };
        entry.dwSize = mem::size_of::<ProcessEntry32W>() as u32;
        let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        while ok {
            parent_by_pid.insert(entry.th32ProcessID, entry.th32ParentProcessID);
            ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe { CloseHandle(snapshot) };

        let mut result = Vec::new();
        let mut queue = VecDeque::from([root_pid]);
        let mut seen = HashSet::from([root_pid]);
        while let Some(parent) = queue.pop_front() {
            for (&pid, &ppid) in &parent_by_pid {
                if ppid == parent && seen.insert(pid) {
                    result.push(pid);
                    queue.push_back(pid);
                }
            }
        }
        result
    }

    fn terminate(pid: u32) {
        let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
        if handle.is_null() {
            return;
        }
        unsafe {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }

    /// Kill descendants leaf-first, then the root. This is the deterministic
    /// fallback when taskkill exists but returns Access denied under the
    /// desktop process token.
    pub fn terminate_tree(root_pid: u32) {
        let mut children = descendants(root_pid);
        children.reverse();
        for pid in children {
            terminate(pid);
        }
        terminate(root_pid);
    }
}

/// Locate the shipped backend tree (the one with run-backend.bat + setup.bat).
/// It can land in a couple of places depending on how the app was built, so we
/// probe them in order:
///
/// - `<resource_dir>/backend-bundle` — the NSIS installer bundles the clean
///   runtime staged by `scripts/stage-backend.ps1` via tauri.conf `resources`.
/// - `<exe_dir>/backend` — a supported portable folder layout.
///
/// Returns the first that actually contains the launcher. None in a dev run.
fn shell_compatible_path(path: &Path) -> PathBuf {
    let raw = path.as_os_str().to_string_lossy();
    let extended_unc = r"\\?\UNC\";
    let extended = r"\\?\";

    if raw
        .as_bytes()
        .get(..extended_unc.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(extended_unc.as_bytes()))
    {
        return PathBuf::from(format!(r"\\{}", &raw[extended_unc.len()..]));
    }
    if raw
        .as_bytes()
        .get(..extended.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(extended.as_bytes()))
    {
        return PathBuf::from(&raw[extended.len()..]);
    }
    path.to_path_buf()
}

fn find_backend_dir(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(rd) = resource_dir {
        candidates.push(rd.join("backend-bundle")); // structure preserved (expected)
        candidates.push(rd.join("backend"));
        candidates.push(rd.to_path_buf()); // in case the bundler flattened it
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("backend"));
            candidates.push(dir.join("backend-bundle"));
        }
    }
    candidates
        .into_iter()
        .find(|d| d.join("run-backend.bat").exists())
        // cmd.exe cannot execute a .bat through a `\\?\...` path even though
        // Rust can spawn cmd successfully. Pass a regular drive/UNC path to all
        // shell-backed launchers while keeping the extended path for probing.
        .map(|d| shell_compatible_path(&d))
}

#[cfg(test)]
mod backend_path_tests {
    use super::shell_compatible_path;
    use std::path::{Path, PathBuf};

    #[test]
    fn strips_extended_drive_prefix_before_launching_cmd() {
        assert_eq!(
            shell_compatible_path(Path::new(r"\\?\D:\XinChao-Cut\backend-bundle")),
            PathBuf::from(r"D:\XinChao-Cut\backend-bundle")
        );
    }

    #[test]
    fn converts_extended_unc_prefix_before_launching_cmd() {
        assert_eq!(
            shell_compatible_path(Path::new(r"\\?\UNC\server\share\backend-bundle")),
            PathBuf::from(r"\\server\share\backend-bundle")
        );
    }
}

/// resource_dir for an AppHandle, or None if it can't be resolved.
fn resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

/// Per-user AI runtime dir (venvs + ffmpeg + logs): %LOCALAPPDATA%\XinChao-Cut, or
/// XINCHAO_AI_DIR if set. Lives OUTSIDE the install folder so app updates never wipe
/// the ~8 GB venvs. Mirrors the default in setup.bat / run-backend.bat.
fn ai_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("XINCHAO_AI_DIR") {
        if !d.is_empty() {
            return Some(PathBuf::from(d));
        }
    }
    std::env::var("LOCALAPPDATA")
        .ok()
        .map(|la| PathBuf::from(la).join("XinChao-Cut"))
}

/// Path of the optional data-dir override file (one line = the data folder).
fn data_dir_config() -> Option<PathBuf> {
    ai_dir().map(|a| a.join("data-dir.txt"))
}

/// The effective data dir: the user's override (data-dir.txt) if set, else the
/// default `<ai_dir>\work`. Shown in the "Thư mục dữ liệu" setting.
#[tauri::command]
fn get_data_dir() -> String {
    if let Some(cfg) = data_dir_config() {
        if let Ok(s) = std::fs::read_to_string(&cfg) {
            let t = s.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    ai_dir()
        .map(|a| a.join("work").display().to_string())
        .unwrap_or_default()
}

/// Point the data dir at another drive (e.g. D:\XinChao-Cut to spare the SSD). Writes
/// data-dir.txt; empty path resets to the default. Takes effect when the backend
/// next starts. The venvs stay on C: regardless.
#[tauri::command]
fn set_data_dir(path: String) -> Result<(), String> {
    let cfg = data_dir_config().ok_or("Không xác định được thư mục AI.")?;
    if let Some(parent) = cfg.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let p = path.trim();
    if p.is_empty() {
        let _ = std::fs::remove_file(&cfg); // back to default <ai_dir>\work
        return Ok(());
    }
    std::fs::create_dir_all(p).map_err(|e| format!("Không tạo được thư mục: {e}"))?;
    std::fs::write(&cfg, p).map_err(|e| e.to_string())
}

const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "mkv", "webm", "avi", "m4v", "ts", "mts", "mp3", "wav", "aac", "m4a", "flac",
    "ogg", "opus", "wma",
];

fn is_media_file(path: &PathBuf) -> bool {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    MEDIA_EXTENSIONS.contains(&ext.as_str())
}

fn validated_media_path(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    let requested = PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("Media path must be absolute.".into());
    }
    if !app.asset_protocol_scope().is_allowed(&requested) {
        return Err("Media path is outside the user-approved asset scope.".into());
    }
    let canonical = requested
        .canonicalize()
        .map_err(|e| format!("Cannot resolve media path: {e}"))?;
    if !canonical.is_file() {
        return Err("Media path does not point to a file.".into());
    }
    if !is_media_file(&canonical) {
        return Err("Path is not a supported media file.".into());
    }
    Ok(canonical)
}

/// Extend the asset scope with a media file the user brought into the app.
///
/// The dialog plugin grants scope automatically for picker selections, but
/// NATIVE DRAG-DROP imports never got that grant — so preview (asset protocol)
/// and export byte-range IPC rejected those files with "outside the
/// user-approved asset scope". The drop itself is the user's approval; this
/// command records it (tauri_plugin_persisted_scope persists it across
/// restarts). Restricted to existing media files by extension.
#[tauri::command]
async fn allow_media_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let requested = PathBuf::from(&path);
    if !requested.is_absolute() {
        return Err("Media path must be absolute.".into());
    }
    let canonical = requested
        .canonicalize()
        .map_err(|e| format!("Cannot resolve media path: {e}"))?;
    if !canonical.is_file() {
        return Err("Media path does not point to a file.".into());
    }
    if !is_media_file(&canonical) {
        return Err("Path is not a supported media file.".into());
    }
    app.asset_protocol_scope()
        .allow_file(&canonical)
        .map_err(|e| format!("Cannot extend media scope: {e}"))?;
    Ok(())
}

/// Exact byte size used to expose a desktop source as a random-access stream to
/// the browser export worker. No file contents cross IPC in this call.
#[tauri::command]
async fn media_file_size(app: tauri::AppHandle, path: String) -> Result<u64, String> {
    let path = validated_media_path(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        path.metadata()
            .map(|metadata| metadata.len())
            .map_err(|e| format!("Cannot stat media file: {e}"))
    })
    .await
    .map_err(|e| format!("Media stat task failed: {e}"))?
}

/// Bounded binary range read for WebCodecs demuxing in the export worker.
/// Returning ipc::Response keeps the payload binary instead of serializing a
/// 16 MiB read as millions of JSON numbers.
#[tauri::command]
async fn read_media_range(
    app: tauri::AppHandle,
    path: String,
    start: u64,
    end: u64,
) -> Result<tauri::ipc::Response, String> {
    let path = validated_media_path(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        const MAX_RANGE_BYTES: u64 = 32 * 1024 * 1024;
        let mut file =
            std::fs::File::open(&path).map_err(|e| format!("Cannot open media file: {e}"))?;
        let size = file
            .metadata()
            .map_err(|e| format!("Cannot stat media file: {e}"))?
            .len();
        let bounded_end = end.min(size);
        if start > bounded_end {
            return Err("Invalid media byte range.".into());
        }
        let len = bounded_end - start;
        if len > MAX_RANGE_BYTES {
            return Err(format!(
                "Media byte range exceeds {} MiB limit.",
                MAX_RANGE_BYTES / (1024 * 1024)
            ));
        }
        file.seek(SeekFrom::Start(start))
            .map_err(|e| format!("Cannot seek media file: {e}"))?;
        let mut data = vec![0; len as usize];
        let mut read = 0;
        while read < data.len() {
            let count = file
                .read(&mut data[read..])
                .map_err(|e| format!("Cannot read media file: {e}"))?;
            if count == 0 {
                break;
            }
            read += count;
        }
        data.truncate(read);
        Ok(tauri::ipc::Response::new(data))
    })
    .await
    .map_err(|e| format!("Media range task failed: {e}"))?
}

/// Append a line to %LOCALAPPDATA%\XinChao-Cut\backend-launch.log so a headless
/// auto-start that never reaches the UI can still be diagnosed.
fn log_launch(msg: &str) {
    use std::io::Write;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Some(a) = ai_dir() {
        let _ = std::fs::create_dir_all(&a);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(a.join("backend-launch.log"))
        {
            let _ = writeln!(f, "[{ts}] {msg}");
        }
    }
}

/// Snapshot of the optional runtime/model install state.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupStatus {
    packaged: bool,
    venv_main: bool,
    venv_omni: bool,
    ffmpeg: bool,
    core: bool,
    captions: bool,
    funasr: bool,
    audio: bool,
    tts: bool,
    python: Option<String>,
    ready: bool,
    running: bool,
    whisper_model: Option<String>,
    model_download_policy: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupOptions {
    captions: bool,
    funasr: bool,
    audio: bool,
    tts: bool,
    whisper_model: String,
    download_models: bool,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct InstallState {
    whisper_model: Option<String>,
    model_download_policy: Option<String>,
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

/// Find a Python 3.11 interpreter the way setup.bat does (py launcher first,
/// then a bare `python` that reports 3.11). Returns the invocation or None.
fn detect_python() -> Option<String> {
    let mut py = Command::new("py");
    py.args(["-3.11", "--version"]);
    no_window(&mut py);
    if py.output().map(|o| o.status.success()).unwrap_or(false) {
        return Some("py -3.11".into());
    }
    let mut python = Command::new("python");
    python.arg("--version");
    no_window(&mut python);
    if let Ok(o) = python.output() {
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        );
        if text.contains("3.11") {
            return Some("python".into());
        }
    }
    None
}

#[tauri::command]
fn ai_setup_status(app: tauri::AppHandle) -> SetupStatus {
    let dir = find_backend_dir(resource_dir(&app).as_deref());
    let (venv_main, venv_omni, ffmpeg, core, captions, funasr, audio, tts, state) = match ai_dir() {
        Some(a) => {
            let markers = a.join("components");
            let state = std::fs::read_to_string(a.join("install-state.json"))
                .ok()
                .and_then(|raw| serde_json::from_str::<InstallState>(&raw).ok())
                .unwrap_or_default();
            (
                a.join("venv").join("Scripts").join("python.exe").exists(),
                a.join("venv-omnivoice")
                    .join("Scripts")
                    .join("python.exe")
                    .exists(),
                a.join("bin").join("ffmpeg.exe").exists(),
                markers.join("core.sha256").exists(),
                markers.join("caption.sha256").exists(),
                markers.join("funasr.sha256").exists(),
                markers.join("audio.sha256").exists(),
                markers.join("tts.sha256").exists(),
                state,
            )
        }
        None => (
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            InstallState::default(),
        ),
    };
    let running = app.state::<SetupProc>().0.lock().unwrap().running;
    SetupStatus {
        packaged: dir.is_some(),
        venv_main,
        venv_omni,
        ffmpeg,
        core,
        captions,
        funasr,
        audio,
        tts,
        python: detect_python(),
        ready: core && venv_main && ffmpeg,
        running,
        whisper_model: state.whisper_model,
        model_download_policy: state.model_download_policy,
    }
}

/// Run `backend/setup.ps1` in the background, streaming every output line to the
/// frontend as `ai-setup-log` events and the final exit code as `ai-setup-done`.
/// Returns immediately; the wizard listens for the events.
#[tauri::command]
fn ai_setup_run(app: tauri::AppHandle, options: SetupOptions) -> Result<bool, String> {
    let dir = find_backend_dir(resource_dir(&app).as_deref()).ok_or_else(|| {
        "Không tìm thấy backend\\setup.ps1 cạnh ứng dụng (chỉ chạy được ở bản đóng gói)."
            .to_string()
    })?;
    if !matches!(
        options.whisper_model.as_str(),
        "tiny" | "small" | "large-v3"
    ) {
        return Err("Whisper model không hợp lệ.".to_string());
    }
    let mut components = vec!["core"];
    if options.captions {
        components.push("caption");
    }
    if options.funasr {
        components.push("funasr");
    }
    if options.audio {
        components.push("audio");
    }
    if options.tts {
        components.push("tts");
    }
    let components = components.join(",");
    {
        let state = app.state::<SetupProc>();
        let mut runtime = state.0.lock().unwrap();
        if runtime.running {
            return Ok(false);
        }
        runtime.running = true;
        runtime.pid = None;
    }
    std::thread::spawn(move || {
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(dir.join("setup.ps1"))
        .args([
            "-Components",
            &components,
            "-WhisperModel",
            &options.whisper_model,
        ]);
        if options.download_models {
            cmd.arg("-DownloadModels");
        }
        cmd.current_dir(&dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        no_window(&mut cmd);
        match cmd.spawn() {
            Ok(mut child) => {
                app.state::<SetupProc>().0.lock().unwrap().pid = Some(child.id());
                let stdout_thread = child.stdout.take().map(|out| {
                    let output_app = app.clone();
                    std::thread::spawn(move || {
                        for line in BufReader::new(out).lines().map_while(Result::ok) {
                            let _ = output_app.emit("ai-setup-log", line);
                        }
                    })
                });
                let stderr_thread = child.stderr.take().map(|out| {
                    let output_app = app.clone();
                    std::thread::spawn(move || {
                        for line in BufReader::new(out).lines().map_while(Result::ok) {
                            let _ = output_app.emit("ai-setup-log", line);
                        }
                    })
                });
                let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
                if let Some(thread) = stdout_thread {
                    let _ = thread.join();
                }
                if let Some(thread) = stderr_thread {
                    let _ = thread.join();
                }
                let setup_state = app.state::<SetupProc>();
                let mut runtime = setup_state.0.lock().unwrap();
                runtime.running = false;
                runtime.pid = None;
                drop(runtime);
                let _ = app.emit("ai-setup-done", code);
            }
            Err(e) => {
                let setup_state = app.state::<SetupProc>();
                let mut runtime = setup_state.0.lock().unwrap();
                runtime.running = false;
                runtime.pid = None;
                drop(runtime);
                let _ = app.emit(
                    "ai-setup-log",
                    format!("[ERROR] không chạy được setup.ps1: {e}"),
                );
                let _ = app.emit("ai-setup-done", -1);
            }
        }
    });
    Ok(true)
}

/// The frontend finished its pre-close autosave flush (or gave up): tear the
/// window down now. Idempotent — the Rust close-event fallback may also call
/// this, and a second destroy on an already-closed window is a harmless no-op.
#[tauri::command]
fn commit_window_close(window: tauri::Window) {
    let _ = window.destroy();
}

/// Launch the Python backend that ships with the app (run-backend.bat in the
/// resolved backend tree). Returns None when the launcher isn't there (dev runs,
/// or before the user has installed the backend) — the frontend simply shows the
/// backend as offline until it comes up.
fn spawn_backend(resource_dir: Option<&Path>) -> Option<Child> {
    let dir = match find_backend_dir(resource_dir) {
        Some(d) => d,
        None => {
            log_launch(&format!(
                "spawn: backend dir NOT FOUND (resource_dir={resource_dir:?})"
            ));
            return None;
        }
    };
    let script = dir.join("run-backend.bat");
    let mut cmd = Command::new("cmd");
    cmd.arg("/c").arg(&script).current_dir(&dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW); // no console window for the backend
    }
    match cmd.spawn() {
        Ok(child) => {
            log_launch(&format!(
                "spawn: launched run-backend.bat in {}",
                dir.display()
            ));
            Some(child)
        }
        Err(e) => {
            log_launch(&format!(
                "spawn: FAILED to launch {}: {e}",
                script.display()
            ));
            None
        }
    }
}

fn external_backend_enabled() -> bool {
    std::env::var("XINCHAO_EXTERNAL_BACKEND")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
        .unwrap_or(false)
}

/// Start the backend on demand (idempotent). Used by the frontend right after the
/// "Bật AI" setup finishes — so the backend comes up WITHOUT an app restart — and
/// by a one-click "start backend" button. No-op (returns true) when one is already
/// running. Returns false when no backend tree is installed yet.
#[tauri::command]
fn start_backend(app: tauri::AppHandle) -> bool {
    // start.bat owns the hot-reload Uvicorn process in source development. Do not
    // race it with a staged/packaged backend that may also exist in target resources.
    if external_backend_enabled() {
        return true;
    }
    let state = app.state::<BackendProc>();
    let mut guard = state.0.lock().unwrap();
    // Already alive? (try_wait → Ok(None) means still running.)
    if let Some(child) = guard.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return true;
        }
        *guard = None; // previous one exited (e.g. ran before the venv existed)
    }
    let res_dir = resource_dir(&app);
    match spawn_backend(res_dir.as_deref()) {
        Some(child) => {
            *guard = Some(child);
            true
        }
        None => false,
    }
}

/// Kill the backend and its whole process tree (cmd → uvicorn → workers) so it
/// never keeps port 8000 — or the GPU — alive after the window closes.
fn kill_backend(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Never wait for taskkill's stdout/stderr during RunEvent::Exit. A
        // wedged child tree used to keep the desktop window alive indefinitely.
        // Do NOT kill the cmd root immediately after spawning taskkill: if the
        // root disappears before taskkill enumerates /T, uvicorn/ffmpeg children
        // are orphaned and keep port 8000 or the GPU alive. Keep the root valid
        // until taskkill owns the whole tree; bare-kill only if helper spawn fails.
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &child.id().to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        // taskkill may *spawn* successfully then exit Access denied. Snapshot
        // and terminate our own descendants through Win32 as a guaranteed
        // fallback, then reap the Child handle best-effort.
        win_process_tree::terminate_tree(child.id());
        let _ = child.kill();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Project persistence and the local backend are deliberately
            // process-owned. Bring the existing editor forward instead of
            // allowing a second WebView to race the same IndexedDB/OPFS rows.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // Dialog selections are added to the runtime filesystem/asset scopes.
        // Persist only those user-approved paths so project media still works
        // after restart without exposing the old global `**` scope.
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(BackendProc(Mutex::new(None)))
        .manage(SetupProc(Mutex::new(SetupRuntime::default())))
        // Drive window close from the Rust side. The webview's own close path
        // (JS `onCloseRequested` / `beforeunload`) proved unreliable on this
        // WebView2 build — the titlebar X could wedge the window permanently.
        // Instead: intercept the close, give the frontend a brief chance to
        // flush its autosave (via the `app-close-requested` event, which calls
        // back into `commit_window_close`), then force the window down after a
        // short fallback so it can never become unclosable even if the webview
        // never responds.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("app-close-requested", ());
                let w = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2000));
                    let _ = w.destroy();
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            ai_setup_status,
            ai_setup_run,
            start_backend,
            get_data_dir,
            set_data_dir,
            media_file_size,
            read_media_range,
            allow_media_path,
            commit_window_close
        ])
        .setup(|app| {
            if !external_backend_enabled() {
                let res_dir = app.path().resource_dir().ok();
                if let Some(child) = spawn_backend(res_dir.as_deref()) {
                    *app.state::<BackendProc>().0.lock().unwrap() = Some(child);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(pid) = app.state::<SetupProc>().0.lock().unwrap().pid.take() {
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        let _ = Command::new("taskkill")
                            .args(["/F", "/T", "/PID", &pid.to_string()])
                            .creation_flags(CREATE_NO_WINDOW)
                            .spawn();
                        win_process_tree::terminate_tree(pid);
                    }
                }
                if let Some(mut child) = app.state::<BackendProc>().0.lock().unwrap().take() {
                    kill_backend(&mut child);
                }
            }
        });
}

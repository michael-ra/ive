//! Desktop lifecycle: the app owns one bundled backend and a separate user data directory.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, mpsc, atomic::{AtomicBool, Ordering}},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
struct Backend(Mutex<Option<Child>>, AtomicBool);
impl Backend {
    fn stop(&self) {
        self.1.store(true, Ordering::SeqCst);
        let Some(mut child) = self.0.lock().unwrap().take() else { return };
        // Signal only our child. The backend performs its own bounded PTY cleanup.
        if child.try_wait().ok().flatten().is_none() {
            unsafe { libc::kill(child.id() as i32, libc::SIGTERM); }
            let deadline = Instant::now() + Duration::from_secs(12);
            while Instant::now() < deadline {
                if child.try_wait().ok().flatten().is_some() { return; }
                thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}
impl Drop for Backend { fn drop(&mut self) { self.stop(); } }

type Failure = Arc<Mutex<Option<(String, String)>>>;

fn external_url(url: &tauri::Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        // Pass URL as one argument; never interpret links as shell code.
        let _ = Command::new("/usr/bin/open").arg(url.as_str())
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    }
}

fn finder_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut entries = Vec::<PathBuf>::new();
    // Finder does not inherit the PATH configured in a terminal. Read only the
    // PATH from a bounded login shell, then add conventional install locations.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    if let Ok(mut process) = Command::new(shell).args(["-ilc", "printf '\\nIVE_DESKTOP_PATH=%s\\n' \"$PATH\""])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() {
        // Drain concurrently: shell startup output must not fill the pipe.
        let stdout = process.stdout.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout.take(1_048_576)).lines().map_while(Result::ok) {
                if let Some(path) = line.strip_prefix("IVE_DESKTOP_PATH=") {
                    let _ = sender.send(path.to_owned()); break;
                }
            }
        });
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            if process.try_wait().ok().flatten().is_some() {
                if let Ok(path) = receiver.recv_timeout(Duration::from_millis(250)) {
                    entries.extend(std::env::split_paths(&path));
                }
                break;
            }
            if Instant::now() > deadline { let _ = process.kill(); let _ = process.wait(); break; }
            thread::sleep(Duration::from_millis(25));
        }
    }
    for p in [format!("{home}/.local/bin"), format!("{home}/.volta/bin"), format!("{home}/.asdf/shims"),
        format!("{home}/.cargo/bin"), "/opt/homebrew/bin".into(), "/usr/local/bin".into(),
        "/usr/bin".into(), "/bin".into(), "/usr/sbin".into(), "/sbin".into()] {
        entries.push(PathBuf::from(p));
    }
    if let Some(path) = std::env::var_os("PATH") { entries.extend(std::env::split_paths(&path)); }
    entries.retain(|p| p.is_absolute());
    let mut unique = Vec::new();
    for entry in entries { if !unique.contains(&entry) { unique.push(entry); } }
    std::env::join_paths(unique).unwrap_or_default().to_string_lossy().into_owned()
}

fn ready(port: u16, nonce: &str) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if write!(stream, "GET /ready HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").is_err() { return false; }
    let mut response = String::new();
    if stream.take(65536).read_to_string(&mut response).is_err() { return false; }
    if !response.starts_with("HTTP/1.0 200") && !response.starts_with("HTTP/1.1 200") { return false; }
    response.split_once("\r\n\r\n").and_then(|(_, body)| serde_json::from_str::<serde_json::Value>(body).ok())
        .is_some_and(|data| data["desktop_instance"].as_str() == Some(nonce))
}

fn show_failure(window: &tauri::WebviewWindow, failure: &Failure, detail: String) {
    *failure.lock().unwrap() = Some(("IVE konnte nicht weiterlaufen".into(), detail.clone()));
    let _ = window.navigate("tauri://localhost/desktop-startup.html".parse().unwrap());
}

fn spawn_backend(app: &tauri::AppHandle, data_dir: &Path, port: u16, nonce: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let log = data_dir.join("desktop-backend.log");
    if fs::metadata(&log).is_ok_and(|m| m.len() > 5_000_000) { let _ = fs::rename(&log, data_dir.join("desktop-backend.previous.log")); }
    let output = OpenOptions::new().create(true).append(true).open(&log).map_err(|e| e.to_string())?;
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let executable = resources.join("backend/ive-backend");
    if !executable.is_file() { return Err(format!("Der mitgelieferte Dienst fehlt: {}", executable.display())); }
    // A stable, dedicated port preserves localStorage across launches. Never
    // attach to an unrelated listener or the developer workspace on port 5111.
    let probe = TcpListener::bind(("127.0.0.1", port))
        .map_err(|_| format!("Der lokale Port {port} wird bereits verwendet. Beende die andere IVE-App und starte erneut."))?;
    let mut command = Command::new(executable);
    for (key, _) in std::env::vars_os() {
        let k = key.to_string_lossy();
        if k.starts_with("IVE_") || k.starts_with("COMMANDER_") || matches!(k.as_ref(), "PYTHONPATH" | "PYTHONHOME" | "VIRTUAL_ENV") { command.env_remove(key); }
    }
    if let Some(opt_out) = std::env::var_os("IVE_TELEMETRY") { command.env("IVE_TELEMETRY", opt_out); }
    command.args(["--headless"]).current_dir(data_dir)
        .env("COMMANDER_HOST", "127.0.0.1").env("COMMANDER_PORT", port.to_string())
        .env("IVE_DATA_DIR", data_dir).env("IVE_DESKTOP_INSTANCE", nonce)
        .env("PATH", finder_path()).env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null()).stdout(Stdio::from(output.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(output));
    drop(probe);
    let mut child = command.spawn().map_err(|e| format!("Lokaler Dienst konnte nicht starten: {e}"))?;
    let pid = child.id();
    let state = app.state::<Backend>();
    let mut guard = state.0.lock().unwrap();
    if state.1.load(Ordering::SeqCst) {
        let _ = child.kill(); let _ = child.wait();
        return Err("IVE wird beendet.".into());
    }
    *guard = Some(child);
    drop(guard);
    let _ = fs::write(data_dir.join("desktop-runtime.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "pid": pid, "port": port, "app_pid": std::process::id(), "version": env!("CARGO_PKG_VERSION")
    })).unwrap());
    Ok(log)
}

fn main() {
    let failure: Failure = Default::default();
    let app = tauri::Builder::default().manage(Backend::default())
        .setup(move |app| {
            let port = std::env::var("IVE_DESKTOP_PORT").ok().and_then(|s| s.parse::<u16>().ok()).filter(|p| *p > 1024).unwrap_or(5112);
            let data_dir = std::env::var_os("IVE_DESKTOP_DATA_DIR").map(PathBuf::from)
                .filter(|p| p.is_absolute()).unwrap_or(app.path().app_data_dir()?);
            fs::create_dir_all(&data_dir)?;
            let window_receipt = data_dir.join("desktop-window.json");
            let origin = format!("http://127.0.0.1:{port}");
            let own_origin = origin.clone();
            let current_failure = failure.clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("desktop-startup.html".into()))
                .title("IVE").inner_size(1400.0, 900.0).min_inner_size(900.0, 600.0)
                .initialization_script(format!("window.__IVE_BACKEND__={};", serde_json::to_string(&origin).unwrap()))
                .on_navigation(move |url| {
                    if url.scheme() == "tauri" || (url.origin().ascii_serialization() == own_origin) { return true; }
                    external_url(url); false
                })
                .on_new_window(|url, _| { external_url(&url); tauri::webview::NewWindowResponse::Deny })
                .on_page_load(move |window, payload| {
                    if payload.event() == tauri::webview::PageLoadEvent::Finished {
                        let _ = fs::write(&window_receipt, serde_json::to_vec(&serde_json::json!({
                            "url": payload.url().as_str(), "loaded": true,
                            "app_pid": std::process::id(), "version": env!("CARGO_PKG_VERSION")
                        })).unwrap());
                    }
                    if let Some((title, detail)) = current_failure.lock().unwrap().as_ref() {
                        let _ = window.eval(&format!("window.iveDesktopStatus?.({}, {})", serde_json::to_string(title).unwrap(), serde_json::to_string(detail).unwrap()));
                    }
                }).build()?;
            let handle = app.handle().clone();
            let signal_handle = handle.clone();
            let _ = ctrlc::set_handler(move || signal_handle.exit(0));
            let failure = failure.clone();
            thread::spawn(move || {
                let nonce = format!("{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos());
                let log = match spawn_backend(&handle, &data_dir, port, &nonce) {
                    Ok(path) => path,
                    Err(error) => { show_failure(&window, &failure, error); return; }
                };
                let deadline = Instant::now() + Duration::from_secs(75);
                loop {
                    let exited = handle.state::<Backend>().0.lock().unwrap().as_mut().and_then(|p| p.try_wait().ok().flatten());
                    if let Some(status) = exited { show_failure(&window, &failure, format!("Der lokale Dienst wurde beendet ({status}).\nDiagnose: {}", log.display())); return; }
                    if ready(port, &nonce) { break; }
                    if Instant::now() > deadline {
                        handle.state::<Backend>().stop();
                        show_failure(&window, &failure, format!("Der lokale Dienst antwortet nicht.\nDiagnose: {}", log.display())); return;
                    }
                    thread::sleep(Duration::from_millis(200));
                }
                if let Err(error) = window.navigate(origin.parse().unwrap()) { show_failure(&window, &failure, error.to_string()); }
                // Detect failures after startup as well, rather than leaving a
                // disconnected workspace looking ready forever.
                loop {
                    thread::sleep(Duration::from_secs(2));
                    let state = handle.state::<Backend>();
                    let mut guard = state.0.lock().unwrap();
                    let Some(child) = guard.as_mut() else { return; };
                    if let Ok(Some(status)) = child.try_wait() {
                        drop(guard);
                        show_failure(&window, &failure, format!("Der lokale Dienst wurde beendet ({status}).\nDiagnose: {}", log.display())); return;
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!()).expect("IVE Desktop konnte nicht starten");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) { handle.state::<Backend>().stop(); }
        if let tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::CloseRequested { .. }, .. } = event { handle.exit(0); }
    });
}

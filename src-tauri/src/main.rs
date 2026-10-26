#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod scan;

use serde::Deserialize;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::{fs, io};
use tauri::Manager;
use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

// Only what launch() needs; the UI owns the rest of the schema.
#[derive(Deserialize)]
struct Item {
    id: String,
    kind: String,
    target: String,
    #[serde(default)]
    args: String,
    #[serde(default)]
    cwd: String,
}

#[derive(Deserialize)]
struct Library {
    #[serde(default)]
    items: Vec<Item>,
}

fn lib_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().data_dir().map_err(|e| e.to_string())?.join("Launcher");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("library.json"))
}

/// Raw library JSON, or "" for a fresh start. A corrupt file is moved aside, never overwritten.
#[tauri::command]
fn load_library(app: tauri::AppHandle) -> Result<String, String> {
    let p = lib_path(&app)?;
    match fs::read_to_string(&p) {
        Ok(s) if serde_json::from_str::<serde_json::Value>(&s).is_ok() => Ok(s),
        Ok(_) => {
            fs::rename(&p, p.with_extension("json.bad")).map_err(|e| e.to_string())?;
            Ok(String::new())
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Atomic: write a temp file, then rename over the real one.
#[tauri::command]
fn save_library(app: tauri::AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?;
    let p = lib_path(&app)?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// Folder holding library.json, covers/ and (later) bg/. The UI needs it to build asset:// URLs.
#[tauri::command]
fn data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let p = lib_path(&app)?;
    Ok(p.parent().unwrap().to_string_lossy().into_owned())
}

fn covers_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = lib_path(app)?.parent().unwrap().join("covers");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// `rel` comes from the UI, so only its file name is used: it can't point outside `dir`.
fn drop_file(dir: &Path, rel: &str) {
    if let Some(n) = Path::new(rel).file_name() {
        let _ = fs::remove_file(dir.join(n));
    }
}

/// Stores an already-downscaled webp under a fresh name (a new URL, so the webview never serves a stale
/// cached image), deletes the one it replaces, and returns the library-relative path.
#[tauri::command]
fn save_cover(app: tauri::AppHandle, stem: String, bytes: Vec<u8>, old: Option<String>) -> Result<String, String> {
    let dir = covers_dir(&app)?;
    let stem: String = stem.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let name = format!("{stem}-{ms}.webp");
    fs::write(dir.join(&name), bytes).map_err(|e| e.to_string())?;
    if let Some(o) = old {
        drop_file(&dir, &o);
    }
    Ok(format!("covers/{name}"))
}

#[tauri::command]
fn remove_cover(app: tauri::AppHandle, path: String) -> Result<(), String> {
    drop_file(&covers_dir(&app)?, &path);
    Ok(())
}

fn bg_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = lib_path(app)?.parent().unwrap().join("bg");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Copies the picked image as-is (an animated GIF must not be re-encoded) under a fresh name, deletes the
/// one it replaces, and returns (library-relative path, size in bytes) so the UI can warn about big files.
#[tauri::command]
fn import_bg(app: tauri::AppHandle, path: String, old: Option<String>) -> Result<(String, u64), String> {
    let ext = Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !["png", "jpg", "jpeg", "webp", "gif"].contains(&ext.as_str()) {
        return Err("not a png, jpg, webp or gif file".into());
    }
    let dir = bg_dir(&app)?;
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let name = format!("bg-{ms}.{ext}");
    let size = fs::copy(&path, dir.join(&name)).map_err(|e| format!("{path}: {e}"))?;
    if let Some(o) = old {
        drop_file(&dir, &o);
    }
    Ok((format!("bg/{name}"), size))
}

#[tauri::command]
fn remove_bg(app: tauri::AppHandle, path: String) -> Result<(), String> {
    drop_file(&bg_dir(&app)?, &path);
    Ok(())
}

#[tauri::command]
fn launch(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let s = fs::read_to_string(lib_path(&app)?).map_err(|e| e.to_string())?;
    let lib: Library = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    let it = lib.items.iter().find(|i| i.id == id).ok_or("item not found")?;
    if it.kind == "exe" && !it.target.to_lowercase().ends_with(".lnk") {
        spawn_exe(it)
    } else {
        shell_open(&it.target)
    }
}

fn spawn_exe(it: &Item) -> Result<(), String> {
    if !Path::new(&it.target).exists() {
        return Err(format!("not found: {}", it.target));
    }
    let mut c = Command::new(&it.target);
    if !it.args.is_empty() {
        c.raw_arg(&it.args);
    }
    if !it.cwd.is_empty() {
        c.current_dir(&it.cwd);
    } else if let Some(dir) = Path::new(&it.target).parent() {
        c.current_dir(dir);
    }
    match c.spawn() {
        Ok(_) => Ok(()),
        // 740 = needs elevation; the shell can show the UAC prompt (args are dropped).
        Err(e) if e.raw_os_error() == Some(740) => shell_open(&it.target),
        Err(e) => Err(format!("{}: {e}", it.target)),
    }
}

/// URIs, .lnk files, shell:AppsFolder\... — anything the shell can open, same as double-clicking.
/// (explorer.exe <uri> was tried first; it silently drops some URIs, e.g. Epic's.)
fn shell_open(target: &str) -> Result<(), String> {
    let b = target.as_bytes();
    let is_path = (b.len() > 2 && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')) || target.starts_with("\\\\");
    if is_path && !Path::new(target).exists() {
        return Err(format!("not found: {target}"));
    }
    let w: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
    let null = std::ptr::null();
    // SAFETY: `w` is NUL-terminated and outlives the call; every other pointer is null.
    let r = unsafe { ShellExecuteW(std::ptr::null_mut(), null, w.as_ptr(), null, null, SW_SHOWNORMAL) };
    // ShellExecute returns a value > 32 on success, an error code otherwise.
    if r as usize > 32 { Ok(()) } else { Err(format!("{target}: shell error {}", r as usize)) }
}

/// The item's icon as 256x256 RGBA bytes (none if it has no file to take one from).
#[tauri::command]
fn icon(target: String, source: String, source_id: String) -> tauri::ipc::Response {
    tauri::ipc::Response::new(scan::icon_file(&target, &source, &source_id).and_then(|p| jumbo_icon(&p)).unwrap_or_default())
}

/// The shell's 256px ("jumbo") icon, the one Explorer shows: works for .exe, .lnk and any other file.
/// Files with only small icons come back in the top-left corner; the UI trims the empty space.
fn jumbo_icon(path: &Path) -> Option<Vec<u8>> {
    use std::ffi::c_void;
    use std::mem::{size_of, transmute, zeroed};
    use std::ptr::null_mut;
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHGetImageList, SHFILEINFOW, SHGFI_SYSICONINDEX, SHIL_JUMBO};
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};
    const IID_IIMAGELIST: windows_sys::core::GUID = windows_sys::core::GUID::from_u128(0x46eb5926_582e_4017_9fdf_e8998daa0950);
    const N: i32 = 256;
    // The shell rejects mixed separators, which Steam's own paths have ("c:/program files (x86)/steam\...").
    let path = path.to_string_lossy().replace('/', "\\");
    let w: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    // SAFETY: plain Win32 calls with valid, live buffers; every handle obtained is released below.
    // Sync commands run on the main thread, where the webview has already initialized COM.
    unsafe {
        let mut sfi: SHFILEINFOW = zeroed();
        if SHGetFileInfoW(w.as_ptr(), 0, &mut sfi, size_of::<SHFILEINFOW>() as u32, SHGFI_SYSICONINDEX) == 0 {
            return None;
        }
        let mut list: *mut c_void = null_mut();
        if SHGetImageList(SHIL_JUMBO as i32, &IID_IIMAGELIST, &mut list) < 0 {
            return None;
        }
        // IImageList is COM, which windows-sys doesn't wrap: vtable slot 2 = Release, 10 = GetIcon.
        let vt = *(list as *const *const usize);
        let get_icon: unsafe extern "system" fn(*mut c_void, i32, u32, *mut HICON) -> i32 = transmute(*vt.add(10));
        let release: unsafe extern "system" fn(*mut c_void) -> u32 = transmute(*vt.add(2));
        let mut hicon: HICON = null_mut();
        let hr = get_icon(list, sfi.iIcon, 1 /* ILD_TRANSPARENT */, &mut hicon);
        release(list);
        if hr < 0 || hicon.is_null() {
            return None;
        }
        let mut info: ICONINFO = zeroed();
        let got = GetIconInfo(hicon, &mut info);
        DestroyIcon(hicon);
        if got == 0 {
            return None;
        }
        let dc = GetDC(null_mut());
        let read = |bm: HBITMAP| {
            let mut px = vec![0u8; (N * N * 4) as usize];
            let mut bi: BITMAPINFO = zeroed();
            bi.bmiHeader = BITMAPINFOHEADER { biSize: size_of::<BITMAPINFOHEADER>() as u32, biWidth: N, biHeight: -N, biPlanes: 1, biBitCount: 32, ..zeroed() };
            (GetDIBits(dc, bm, 0, N as u32, px.as_mut_ptr().cast(), &mut bi, DIB_RGB_COLORS) == N).then_some(px)
        };
        let (color, mask) = (read(info.hbmColor), read(info.hbmMask));
        ReleaseDC(null_mut(), dc);
        DeleteObject(info.hbmColor);
        DeleteObject(info.hbmMask);
        let mut px = color?;
        // Old icons have no alpha channel; their mask says which pixels are see-through (black = opaque).
        let no_alpha = px.chunks(4).all(|p| p[3] == 0);
        for (i, p) in px.chunks_mut(4).enumerate() {
            p.swap(0, 2); // BGRA -> RGBA
            if no_alpha {
                p[3] = if mask.as_ref().is_some_and(|m| m[i * 4] == 0) { 255 } else { 0 };
            }
        }
        Some(px)
    }
}

#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn scan() -> Vec<scan::Found> {
    scan::scan_all()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![load_library, save_library, data_dir, save_cover, remove_cover, import_bg, remove_bg, launch, icon, quit, scan])
        .run(tauri::generate_context!())
        .expect("error while running launcher");
}

//! IPC for the Atlas-owned system notifier (`crate::notifier`). Responses come
//! back on the `atlas:notification-response` event.

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::notifier::{Authorization, Notification, Notifier, NotifierInfo};

/// Call once after the response listener is registered: flushes responses that
/// arrived before it (a click that launched the app) and reports the backend's
/// capabilities.
#[tauri::command]
pub fn notifier_init(notifier: State<'_, Arc<Notifier>>) -> NotifierInfo {
    notifier.init()
}

/// Ask the OS for permission to post (may prompt).
#[tauri::command]
pub async fn notifier_request_authorization(
    notifier: State<'_, Arc<Notifier>>,
) -> Result<Authorization, String> {
    let notifier = notifier.inner().clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn_blocking(move || {
        notifier
            .backend()
            .request_authorization(Box::new(move |authorization| {
                // The receiver is gone only if the command was dropped.
                sender.send(authorization).ok();
            }));
    });
    receiver.await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn notifier_show(
    notifier: State<'_, Arc<Notifier>>,
    notification: Notification,
) -> Result<(), String> {
    let notifier = notifier.inner().clone();
    tauri::async_runtime::spawn_blocking(move || notifier.backend().show(notification))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn notifier_remove(
    notifier: State<'_, Arc<Notifier>>,
    tag: String,
) -> Result<(), String> {
    let notifier = notifier.inner().clone();
    tauri::async_runtime::spawn_blocking(move || notifier.backend().remove(&tag))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn notifier_remove_group(
    notifier: State<'_, Arc<Notifier>>,
    group: String,
) -> Result<(), String> {
    let notifier = notifier.inner().clone();
    tauri::async_runtime::spawn_blocking(move || notifier.backend().remove_group(&group))
        .await
        .map_err(|error| error.to_string())
}

/// Banner icons live here, one PNG per `<agent>-<scheme>-<content hash>` key.
fn icon_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("notification-icons"))
}

/// Keys come from the webview; keep them a single plain file name.
fn icon_path(app: &AppHandle, key: &str) -> Result<std::path::PathBuf, String> {
    let valid = !key.is_empty()
        && key.len() <= 128
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !key.starts_with('.');
    if !valid {
        return Err(format!("invalid icon key: {key:?}"));
    }
    Ok(icon_dir(app)?.join(format!("{key}.png")))
}

/// The cached banner icon for `key`, if it was already rasterised.
#[tauri::command]
pub async fn notifier_icon_lookup(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let path = icon_path(&app, &key)?;
    tauri::async_runtime::spawn_blocking(move || {
        path.is_file().then(|| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())
}

/// Store a webview-rasterised PNG for `key` (once; an existing file wins) and
/// return its path for `Notification.imagePath`.
#[tauri::command]
pub async fn notifier_icon_store(
    app: AppHandle,
    key: String,
    png: Vec<u8>,
) -> Result<String, String> {
    const PNG_MAGIC: [u8; 4] = [0x89, b'P', b'N', b'G'];
    if !png.starts_with(&PNG_MAGIC) || png.len() > 1 << 20 {
        return Err("not a PNG, or too large".into());
    }
    let path = icon_path(&app, &key)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !path.is_file() {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
            }
            // Write beside, then rename: a banner never reads a half-written file.
            let tmp = path.with_extension("png.tmp");
            std::fs::write(&tmp, &png).map_err(|error| error.to_string())?;
            std::fs::rename(&tmp, &path).map_err(|error| error.to_string())?;
        }
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

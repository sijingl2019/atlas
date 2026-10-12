//! The `tauri-plugin-notification` backend: show only. It has no click
//! callback, no removal and no grouping, so it declares none of them.

use tauri::AppHandle;
use tauri_plugin_notification::{NotificationExt, PermissionState};

use super::{Authorization, Capabilities, Notification, NotifierBackend};

pub struct FallbackBackend {
    app: AppHandle,
}

impl FallbackBackend {
    pub fn new(app: &AppHandle) -> Self {
        Self { app: app.clone() }
    }
}

impl NotifierBackend for FallbackBackend {
    fn name(&self) -> &'static str {
        "plugin"
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            sound: true,
            ..Capabilities::default()
        }
    }

    fn request_authorization(&self, done: Box<dyn FnOnce(Authorization) + Send>) {
        let notification = self.app.notification();
        let state = match notification.permission_state() {
            Ok(PermissionState::Granted) => PermissionState::Granted,
            _ => notification
                .request_permission()
                .unwrap_or(PermissionState::Denied),
        };
        done(if state == PermissionState::Granted {
            Authorization::Granted
        } else {
            Authorization::Denied
        });
    }

    fn show(&self, notification: Notification) -> Result<(), String> {
        // No subtitle slot: fold it into the body.
        let body = match notification.subtitle.as_deref() {
            Some(subtitle) if !subtitle.is_empty() => format!("{subtitle}\n{}", notification.body),
            _ => notification.body.clone(),
        };
        let mut builder = self
            .app
            .notification()
            .builder()
            .title(notification.title)
            .body(body);
        if let Some(sound) = notification.sound {
            builder = builder.sound(sound);
        }
        builder.show().map_err(|error| error.to_string())
    }

    fn remove(&self, _tag: &str) {}

    fn remove_group(&self, _group: &str) {}
}

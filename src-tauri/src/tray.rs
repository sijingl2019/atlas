//! System tray: Show / Check for Updates / Exit.
//!
//! The tray is also what keeps Atlas reachable once the close button hides
//! the main window instead of quitting (`closeButtonExits`, default off —
//! handled in `lib.rs`'s `CloseRequested` arm).

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

const SHOW_ID: &str = "tray-show";
const CHECK_UPDATES_ID: &str = "tray-check-updates";
const EXIT_ID: &str = "tray-exit";

/// Bring the main window back, whether it was hidden, minimised or behind.
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, SHOW_ID, "Show", true, None::<&str>)?,
            &MenuItem::with_id(
                app,
                CHECK_UPDATES_ID,
                "Check for Updates",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, EXIT_ID, "Exit", true, None::<&str>)?,
        ],
    )?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip(&app.package_info().name)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_ID => show_main(app),
            // The check and its "up to date" / error toasts live in the
            // renderer (the same flow as the titlebar's item), so the window
            // comes forward to show them.
            CHECK_UPDATES_ID => {
                show_main(app);
                let _ = app.emit("atlas:tray-check-updates", ());
            }
            EXIT_ID => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

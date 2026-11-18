//! Toolbox owns this opt-in desktop runtime through the SDK child pipe.
//! Keep Hex's listener, capture, Rune HUD and paste implementations together.
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use color_eyre::Result;

pub(crate) fn enabled() -> bool {
    std::env::var("HEX_TOOLBOX_EMBEDDED").is_ok_and(|value| value == "1")
}

pub(crate) fn run(event_path: PathBuf, shutdown: &'static AtomicBool) -> Result<()> {
    // An embedded desktop must never claim an installed Hex's data or settings.
    color_eyre::eyre::ensure!(
        std::env::var_os("HEX_APPLICATION_SUPPORT_DIR").is_some_and(|path| !path.is_empty()),
        "Toolbox dictation requires its own HEX_APPLICATION_SUPPORT_DIR"
    );
    let base = crate::app_settings::AppSettings::load()?;
    let shortcut = std::env::var("HEX_TOOLBOX_SHORTCUT")?;
    let settings = configured_settings(&base, &shortcut)?;
    base.update(&settings)?;
    #[cfg(target_os = "macos")]
    {
        let _ = shutdown; // macOS uses the process-wide shutdown flag.
        if crate::desktop::onboarding::microphone_state()
            == crate::desktop::onboarding::PermissionState::NeedsRequest
        {
            crate::desktop::onboarding::request_microphone();
        }
        let _ = crate::desktop::permission_guide::prompt_accessibility_trust();
    }
    #[cfg(target_os = "linux")]
    return crate::linux::app::run(event_path, shutdown, None);
    #[cfg(target_os = "windows")]
    return crate::windows::rune::open(event_path, shutdown, true);
    #[cfg(target_os = "macos")]
    return crate::open_app(event_path, None, true);
}

/// The settings Toolbox sets through Hex's validated settings path. None may
/// need an OS capability (`toolbox_sets_no_key_that_needs_an_os_capability`).
fn validated_values(shortcut: &str) -> serde_json::Value {
    serde_json::json!({
        "dictation_hotkey": shortcut,
        "shortcut_mode": "toggle",
        "paste_last_hotkey": "none",
        "double_tap_lock": false,
        "release_microphone_while_idle": true
    })
}

fn configured_settings(
    base: &crate::app_settings::AppSettings,
    shortcut: &str,
) -> Result<crate::app_settings::AppSettings> {
    // This host owns only dictation; keep unrelated Hex shortcuts inactive.
    let mut base = base.clone();
    base.raw_dictation_hotkey = None;
    base.typed_text_hotkey = None;
    base.second_dictation_hotkey = None;
    base.extra_dictation_hotkeys.clear();
    base.terminal_paste_hotkey = None;
    base.meetings.enabled = false;
    #[cfg(hex_capture)]
    {
        base.capture.enabled = false;
    }
    base.labs.screenshots = false;
    base.gnome_keyboard_shortcuts = false;
    // The listener switch exists only on Linux and Windows (macOS's listener
    // always runs), and `apply_all` refuses a key its OS lacks, so it is set
    // here and not with the validated values: setting it there stopped the
    // host at startup on macOS.
    base.enable_on_launch = true;
    let values = serde_json::from_value(validated_values(shortcut))?;
    let change =
        crate::control::settings::apply_all(&base, &values, &crate::rune_ui::shortcut_rules())
            .map_err(|error| color_eyre::eyre::eyre!("{}", error.message))?;
    Ok(change.settings)
}

pub(crate) fn announce(api: &crate::local_api::LocalApi) -> Result<()> {
    thread::Builder::new()
        .name("toolbox-host-lease".into())
        .spawn(|| {
            let mut input = std::io::stdin().lock();
            let mut byte = [0];
            loop {
                match input.read(&mut byte) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            crate::SHUTDOWN.store(true, Ordering::Release);
            // Native teardown may be waiting on inference. Never outlive Toolbox.
            thread::sleep(Duration::from_secs(5));
            std::process::exit(0);
        })?;
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &api.embedded_endpoint())?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn toolbox_uses_hex_shortcut_validation_and_toggle_capture() {
        let base = crate::app_settings::AppSettings::default();
        let settings = configured_settings(&base, "ctrl+alt+f9").unwrap();
        assert!(settings.enable_on_launch);
        assert_eq!(
            settings.shortcut_mode,
            crate::dictation::ShortcutMode::Toggle
        );
        assert!(settings.release_microphone_while_idle);
        assert!(settings.paste_last_hotkey.is_none());
        assert!(settings.runtime_hotkeys().capture.is_none());
        assert!(configured_settings(&base, "ctrl+not-a-real-key").is_err());
    }

    #[test]
    fn the_listener_switch_is_on_whatever_the_saved_settings_say() {
        let base = crate::app_settings::AppSettings {
            enable_on_launch: false,
            ..Default::default()
        };
        let settings = configured_settings(&base, "ctrl+alt+f9").unwrap();
        assert!(settings.enable_on_launch);
    }

    /// macOS has no `listener_control`, so a key that needs a capability can
    /// pass on Linux and Windows and still stop the host there.
    #[test]
    fn toolbox_sets_no_key_that_needs_an_os_capability() {
        let values = validated_values("ctrl+alt+f9");
        for key in values.as_object().unwrap().keys() {
            assert_eq!(
                crate::control::settings::capability_needed(key),
                None,
                "`{key}` needs an OS capability; set it on the settings directly"
            );
        }
    }
}

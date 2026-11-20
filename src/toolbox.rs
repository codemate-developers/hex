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

/// Toolbox's single dictation shortcut uses Hex's terminal paste chord in
/// terminal emulators, and the ordinary chord everywhere else. Match native
/// application names/IDs, never window titles or the command being dictated.
#[cfg(target_os = "linux")]
pub(crate) fn terminal_application(application: Option<&str>) -> bool {
    application.is_some_and(|name| {
        matches!(
            name.trim().to_ascii_lowercase().as_str(),
            "ghostty"
                | "com.mitchellh.ghostty"
                | "kitty"
                | "net.kovidgoyal.kitty"
                | "alacritty"
                | "org.alacritty.alacritty"
                | "foot"
                | "footclient"
                | "gnome-terminal"
                | "gnome-terminal-server"
                | "gnome terminal"
                | "org.gnome.terminal"
                | "gnome-console"
                | "kgx"
                | "console"
                | "org.gnome.console"
                | "konsole"
                | "org.kde.konsole"
                | "xfce4-terminal"
                | "xfce terminal"
                | "org.xfce.terminal"
                | "wezterm"
                | "wezterm-gui"
                | "org.wezfurlong.wezterm"
                | "tilix"
                | "com.gexperts.tilix"
                | "terminator"
                | "sakura"
                | "st"
                | "urxvt"
                | "rxvt"
                | "xterm"
                | "uxterm"
                | "terminal"
                | "x-terminal-emulator"
        )
    })
}

pub(crate) fn history_retention(
    retention: crate::history::HistoryRetention,
) -> crate::history::HistoryRetention {
    if enabled() {
        crate::history::HistoryRetention::Week
    } else {
        retention
    }
}

pub(crate) fn run(event_path: PathBuf, shutdown: &'static AtomicBool) -> Result<()> {
    // An embedded desktop must never claim an installed Hex's data or settings.
    color_eyre::eyre::ensure!(
        std::env::var_os("HEX_APPLICATION_SUPPORT_DIR").is_some_and(|path| !path.is_empty()),
        "Toolbox dictation requires its own HEX_APPLICATION_SUPPORT_DIR"
    );
    let base = crate::app_settings::AppSettings::load()?;
    let shortcut = std::env::var("HEX_TOOLBOX_SHORTCUT")?;
    let mode = std::env::var("HEX_TOOLBOX_SHORTCUT_MODE").unwrap_or_else(|_| "tap".into());
    let microphone = std::env::var("HEX_TOOLBOX_MICROPHONE").unwrap_or_default();
    let settings = configured_settings(&base, &shortcut, &mode, &microphone)?;
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
fn validated_values(shortcut: &str, mode: &str) -> Result<serde_json::Value> {
    let (shortcut_mode, double_tap_lock) = match mode {
        "hold" => ("hold", false),
        "tap" => ("toggle", false),
        "hold_or_double_tap" => ("hold", true),
        _ => color_eyre::eyre::bail!("invalid HEX_TOOLBOX_SHORTCUT_MODE: {mode}"),
    };
    Ok(serde_json::json!({
        "dictation_hotkey": shortcut,
        "shortcut_mode": shortcut_mode,
        "paste_last_hotkey": "none",
        "double_tap_lock": double_tap_lock,
        "double_tap_only": false,
        "release_microphone_while_idle": true
    }))
}

fn configured_settings(
    base: &crate::app_settings::AppSettings,
    shortcut: &str,
    mode: &str,
    microphone: &str,
) -> Result<crate::app_settings::AppSettings> {
    // This host owns only dictation; keep unrelated Hex shortcuts inactive.
    let mut base = base.clone();
    // Preserve exact native names, including names which the settings CLI
    // interprets as a special value. An empty selection follows the OS.
    base.microphone = (!microphone.is_empty()).then(|| microphone.to_owned());
    base.history_retention = crate::history::HistoryRetention::Week;
    base.labs.keep_recordings = false;
    base.labs.copy_dictation_audio = false;
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
    let values = serde_json::from_value(validated_values(shortcut, mode)?)?;
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

    #[cfg(target_os = "linux")]
    #[test]
    fn toolbox_recognises_terminal_applications_without_matching_titles() {
        for name in [
            "Ghostty",
            "com.mitchellh.ghostty",
            "kitty",
            "Alacritty",
            "foot",
            "GNOME Terminal",
            "gnome-terminal-server",
            "org.gnome.Console",
            "Konsole",
            "org.wezfurlong.wezterm",
            "xfce4-terminal",
            "xterm",
        ] {
            assert!(terminal_application(Some(name)), "{name}");
        }
        for name in [
            "firefox",
            "code",
            "t3code",
            "codemate-toolbox",
            "my-terminal-notes",
            "kitty documentation",
        ] {
            assert!(!terminal_application(Some(name)), "{name}");
        }
        assert!(!terminal_application(None));
    }

    #[test]
    fn toolbox_overrides_saved_modes_microphone_and_retention() {
        use crate::dictation::ShortcutMode::{Hold, Toggle};
        let mut base = crate::app_settings::AppSettings {
            double_tap_only: true,
            microphone: Some("Old microphone".into()),
            history_retention: crate::history::HistoryRetention::Off,
            ..Default::default()
        };
        base.labs.keep_recordings = true;
        base.labs.copy_dictation_audio = true;
        for (mode, native, lock) in [
            ("hold", Hold, false),
            ("tap", Toggle, false),
            ("hold_or_double_tap", Hold, true),
        ] {
            let settings = configured_settings(&base, "ctrl+alt+f9", mode, " USB Mic ").unwrap();
            assert_eq!(settings.shortcut_mode, native);
            assert_eq!(settings.double_tap_lock, lock);
            assert!(!settings.double_tap_only);
            assert_eq!(settings.microphone.as_deref(), Some(" USB Mic "));
            assert_eq!(
                settings.history_retention,
                crate::history::HistoryRetention::Week
            );
            assert!(!settings.labs.keep_recordings);
            assert!(!settings.labs.copy_dictation_audio);
        }
        assert!(
            configured_settings(&base, "ctrl+alt+f9", "tap", "")
                .unwrap()
                .microphone
                .is_none()
        );
        assert!(configured_settings(&base, "ctrl+alt+f9", "double_tap_only", "").is_err());
    }

    /// A child keeps this process-wide opt-in isolated from upstream tests.
    #[test]
    fn embedded_history_enforces_a_text_only_week() {
        if std::env::var_os("HEX_TEST_TOOLBOX_HISTORY").is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "toolbox::tests::embedded_history_enforces_a_text_only_week",
                    "--nocapture",
                ])
                .env("HEX_TEST_TOOLBOX_HISTORY", "1")
                .env("HEX_TOOLBOX_EMBEDDED", "1")
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }
        use crate::history::{
            HistoryDraft, HistoryKind, HistoryRetention, HistoryStore, Recording,
        };
        let directory =
            std::env::temp_dir().join(format!("hex-toolbox-history-{}", std::process::id()));
        let path = directory.join("history.json");
        let now = 20 * 86_400_000;
        let mut store = HistoryStore::open(path.clone(), HistoryRetention::Off, now);
        store.set_retention(HistoryRetention::Forever, now).unwrap();
        let id = store
            .record(
                HistoryDraft {
                    kind: HistoryKind::Dictation,
                    raw_text: "ship it".into(),
                    final_text: "Ship it.".into(),
                    application: Some("Editor".into()),
                    model: Some("Parakeet".into()),
                    processing: None,
                    audio_ms: 1_000,
                    inference_ms: 50,
                    total_ms: 70,
                    recording: Some(Recording::from_samples(vec![0.1; 160])),
                },
                now,
            )
            .unwrap()
            .unwrap();
        let entries = crate::history::read_snapshot(&path).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, id);
        assert_eq!(entries[0].timestamp_ms, now);
        assert_eq!(entries[0].application.as_deref(), Some("Editor"));
        assert_eq!(entries[0].model.as_deref(), Some("Parakeet"));
        assert_eq!(entries[0].final_text, "Ship it.");
        assert!(!entries[0].has_recording());
        assert!(!crate::history::recordings::directory(&path).exists());
        store.set_retention(HistoryRetention::Off, now).unwrap();
        drop(store);
        let week = 7 * 86_400_000;
        assert_eq!(
            HistoryStore::open(path.clone(), HistoryRetention::Forever, now + week).len(),
            1
        );
        assert_eq!(
            HistoryStore::open(path.clone(), HistoryRetention::Forever, now + week + 1).len(),
            0
        );
        assert!(crate::history::read_snapshot(&path).unwrap().is_empty());
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn toolbox_uses_hex_shortcut_validation_and_toggle_capture() {
        let base = crate::app_settings::AppSettings::default();
        let settings = configured_settings(&base, "ctrl+alt+f9", "tap", "").unwrap();
        assert!(settings.enable_on_launch);
        assert_eq!(
            settings.shortcut_mode,
            crate::dictation::ShortcutMode::Toggle
        );
        assert!(settings.release_microphone_while_idle);
        assert!(settings.paste_last_hotkey.is_none());
        assert!(settings.runtime_hotkeys().capture.is_none());
        assert!(configured_settings(&base, "ctrl+not-a-real-key", "tap", "").is_err());
    }

    #[test]
    fn the_listener_switch_is_on_whatever_the_saved_settings_say() {
        let base = crate::app_settings::AppSettings {
            enable_on_launch: false,
            ..Default::default()
        };
        let settings = configured_settings(&base, "ctrl+alt+f9", "tap", "").unwrap();
        assert!(settings.enable_on_launch);
    }

    /// macOS has no `listener_control`, so a key that needs a capability can
    /// pass on Linux and Windows and still stop the host there.
    #[test]
    fn toolbox_sets_no_key_that_needs_an_os_capability() {
        let values = validated_values("ctrl+alt+f9", "tap").unwrap();
        for key in values.as_object().unwrap().keys() {
            assert_eq!(
                crate::control::settings::capability_needed(key),
                None,
                "`{key}` needs an OS capability; set it on the settings directly"
            );
        }
    }
}

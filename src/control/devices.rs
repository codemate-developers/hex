//! Native device discovery and retained-entry edits shared by desktop hosts.

use super::{ControlError, ControlReply};

pub(crate) fn microphones() -> ControlReply {
    match crate::audio::input_devices() {
        Ok(devices) => microphone_reply(devices),
        Err(error) => {
            ControlReply::error("unavailable", format!("couldn't list microphones: {error}"))
        }
    }
}

fn microphone_reply(devices: crate::audio::InputDevices) -> ControlReply {
    ControlReply::Microphones {
        names: devices.names,
        system_default: devices.system_default,
        system_default_available: devices.system_default_available,
        off_with_lid_closed: devices.off_with_lid_closed,
    }
}

pub(crate) fn delete_history(
    history: Option<crate::history::History>,
    id: u64,
) -> Result<ControlReply, ControlError> {
    let history =
        history.ok_or_else(|| ControlError::new("unavailable", "history couldn't be opened"))?;
    match history.delete(id) {
        Ok(true) => Ok(ControlReply::done("Deleted dictation")),
        Ok(false) => Ok(ControlReply::unchanged(
            "That dictation is no longer in History",
        )),
        Err(error) => Err(ControlError::new(
            "failed",
            format!("couldn't delete dictation: {error}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_linux_default_can_be_available_without_a_display_name() {
        let reply = microphone_reply(crate::audio::InputDevices {
            names: vec!["default".into(), "USB Mic".into()],
            system_default_available: true,
            ..Default::default()
        });
        let json = serde_json::to_value(super::super::ControlResponse::from(reply)).unwrap();
        assert_eq!(json["status"], "microphones");
        assert_eq!(json["names"], serde_json::json!(["default", "USB Mic"]));
        assert_eq!(json["system_default"], serde_json::Value::Null);
        assert_eq!(json["system_default_available"], true);
    }

    #[test]
    fn deletion_is_durable_idempotent_and_requires_a_store() {
        use crate::history::{History, HistoryDraft, HistoryRetention, HistoryStore};
        let directory = std::env::temp_dir().join(format!(
            "hex-delete-{}-{}",
            std::process::id(),
            crate::history::now_ms()
        ));
        let path = directory.join("history.json");
        let history = History::new(HistoryStore::open(path.clone(), HistoryRetention::Week, 0));
        let draft = |text: &str| HistoryDraft {
            kind: crate::history::HistoryKind::Dictation,
            raw_text: text.into(),
            final_text: text.into(),
            application: None,
            processing: None,
            audio_ms: 0,
            inference_ms: 0,
            total_ms: 0,
            recording: None,
            model: None,
        };
        let id = history.record(draft("Ship it.")).unwrap().unwrap();
        let kept = history.record(draft("Keep this.")).unwrap().unwrap();
        assert!(matches!(
            delete_history(Some(history.clone()), id).unwrap(),
            ControlReply::Done { changed: true, .. }
        ));
        assert!(matches!(
            delete_history(Some(history), id).unwrap(),
            ControlReply::Done { changed: false, .. }
        ));
        let entries = crate::history::read_snapshot(&path).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, kept);
        assert_eq!(delete_history(None, id).unwrap_err().code, "unavailable");
        std::fs::remove_dir_all(directory).unwrap();
    }
}

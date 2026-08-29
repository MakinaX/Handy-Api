//! Commands for the fork-owned Gemini transcription backend.
//!
//! API-key values cross this boundary only long enough to be validated and
//! written to Windows Credential Manager. They are never returned to the UI.

use crate::gemini::{normalize_language_code, GeminiClient};
use crate::settings::{
    get_settings, write_settings, GeminiTranscriptionMode, TranscriptionBackend,
};
use tauri::{AppHandle, Emitter};

pub(crate) fn persist_transcription_backend(
    app: &AppHandle,
    backend: TranscriptionBackend,
) -> Result<(), String> {
    let mut settings = get_settings(app);
    settings.transcription_backend = backend;
    write_settings(app, settings);
    crate::tray::update_tray_menu(app);
    let _ = app.emit(
        "settings-changed",
        serde_json::json!({
            "setting": "transcription_backend",
            "value": backend,
        }),
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_transcription_backend_setting(
    app: AppHandle,
    backend: TranscriptionBackend,
) -> Result<(), String> {
    persist_transcription_backend(&app, backend)
}

#[tauri::command]
#[specta::specta]
pub fn change_gemini_transcription_mode_setting(
    app: AppHandle,
    mode: GeminiTranscriptionMode,
) -> Result<(), String> {
    let mut settings = get_settings(&app);
    settings.gemini_transcription_mode = mode;
    write_settings(&app, settings);
    let _ = app.emit(
        "settings-changed",
        serde_json::json!({
            "setting": "gemini_transcription_mode",
            "value": mode,
        }),
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn change_gemini_language_setting(app: AppHandle, language: String) -> Result<(), String> {
    let language = normalize_language_code(&language).map_err(|error| error.to_string())?;

    let mut settings = get_settings(&app);
    settings.gemini_language = language.clone();
    write_settings(&app, settings);
    let _ = app.emit(
        "settings-changed",
        serde_json::json!({
            "setting": "gemini_language",
            "value": language,
        }),
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn gemini_api_key_status() -> Result<bool, String> {
    crate::gemini_key::is_configured()
}

#[tauri::command]
#[specta::specta]
pub fn save_gemini_api_key(app: AppHandle, api_key: String) -> Result<(), String> {
    // Validate the key's header representation before persisting it. The
    // connection test remains explicit so saving works while offline.
    GeminiClient::new(&api_key).map_err(|error| error.to_string())?;
    crate::gemini_key::store(&api_key)?;
    let _ = app.emit("gemini-key-status-changed", true);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn test_gemini_connection() -> Result<(), String> {
    let api_key =
        crate::gemini_key::load()?.ok_or_else(|| "A Gemini API key is required".to_string())?;
    GeminiClient::new(api_key)
        .map_err(|error| error.to_string())?
        .test_connection()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn test_gemini_api_key(api_key: String) -> Result<(), String> {
    GeminiClient::new(api_key)
        .map_err(|error| error.to_string())?
        .test_connection()
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepted_language_shapes_cover_auto_and_code_switch_presets() {
        for language in ["auto", "ko-KR", "en-US"] {
            assert!(normalize_language_code(language).is_ok(), "{language}");
        }
    }

    #[test]
    fn malformed_language_shapes_are_rejected_before_persistence() {
        for language in ["---", "123", "-ko", "ko-", "ko--KR", "ko_KR"] {
            assert!(normalize_language_code(language).is_err(), "{language}");
        }
    }
}

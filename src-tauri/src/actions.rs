#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use crate::apple_intelligence;
use crate::audio_feedback::{play_feedback_sound, play_feedback_sound_blocking, SoundType};
use crate::audio_toolkit::{is_microphone_access_denied, is_no_input_device_error, VadPolicy};
use crate::managers::audio::AudioRecordingManager;
use crate::managers::history::HistoryManager;
use crate::managers::model::ModelManager;
use crate::managers::transcription::StreamWorkKind;
use crate::managers::transcription::TranscriptionManager;
use crate::settings::{
    get_settings, AppSettings, OverlayStyle, TranscriptionBackend, APPLE_INTELLIGENCE_PROVIDER_ID,
};
use crate::shortcut;
use crate::speech_guard::{
    post_stt_verdict, pre_stt_verdict, PostSttEvidence, SpeechPresenceVerdict, TranscriptVerdict,
};
use crate::tray::{set_tray_state, TrayIconState};
use crate::utils::{
    self, show_processing_overlay, show_recording_overlay, show_transcribing_overlay,
};
use crate::TranscriptionCoordinator;
use ferrous_opencc::{config::BuiltinConfig, OpenCC};
use log::{debug, error, info, warn};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri::{AppHandle, Emitter};

const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(25);

fn transcript_shape(transcript: &str) -> (&'static str, usize, usize) {
    let trimmed = transcript.trim();
    let chars = trimmed.chars().count();
    let words = trimmed.split_whitespace().count();
    let class = match words {
        0 => "empty",
        1 => "single_token",
        _ => "multi_token",
    };
    (class, chars, words)
}

#[derive(Clone, serde::Serialize)]
struct RecordingErrorEvent {
    error_type: String,
    detail: Option<String>,
}

/// Drop guard that notifies the [`TranscriptionCoordinator`] when the
/// transcription pipeline finishes — whether it completes normally or panics.
struct FinishGuard(AppHandle);
impl Drop for FinishGuard {
    fn drop(&mut self) {
        // Escape remains live through the complete recording/transcription/
        // output transaction. This is the single normal-path release point;
        // explicit cancellation also unregisters it immediately.
        shortcut::unregister_cancel_shortcut(&self.0);
        if let Some(manager) = self.0.try_state::<Arc<AudioRecordingManager>>() {
            manager.finish_operation();
        }
        if let Some(c) = self.0.try_state::<TranscriptionCoordinator>() {
            c.notify_processing_finished();
        }
        // The pipeline just freed its large transient buffers (captured PCM,
        // WAV copy, engine scratch); hand the cached pages back to the OS so
        // they don't sit in malloc arenas until they get swapped out (#1792).
        crate::memory::trim_freed_memory();
    }
}

// Shortcut Action Trait
pub trait ShortcutAction: Send + Sync {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
}

// Transcribe Action
struct TranscribeAction {
    post_process: bool,
}

/// Field name for structured output JSON schema
const TRANSCRIPTION_FIELD: &str = "transcription";

/// Strip invisible Unicode characters that some LLMs may insert
fn strip_invisible_chars(s: &str) -> String {
    s.replace(['\u{200B}', '\u{200C}', '\u{200D}', '\u{FEFF}'], "")
}

/// Strip a leading `<think>...</think>` block. Some endpoints can't disable
/// reasoning, and some local servers put the reasoning text into `content`
/// instead of a separate field — without this the user would get the model's
/// chain of thought pasted along with the cleaned transcription.
fn strip_think_block(s: &str) -> &str {
    if let Some(rest) = s.trim_start().strip_prefix("<think>") {
        if let Some(end) = rest.find("</think>") {
            return rest[end + "</think>".len()..].trim_start();
        }
    }
    s
}

/// Build a system prompt from the user's prompt template.
/// Removes `${output}` placeholder since the transcription is sent as the user message.
fn build_system_prompt(prompt_template: &str) -> String {
    prompt_template.replace("${output}", "").trim().to_string()
}

/// Returns `true` when a transcription has no meaningful content to
/// post-process (empty or whitespace-only). Used to skip the post-processing
/// LLM call when nothing was actually transcribed, which would otherwise make
/// the model reply with an error message such as "you need to provide the
/// transcription".
fn is_blank_transcription(transcription: &str) -> bool {
    transcription.trim().is_empty()
}

async fn complete_unless_cancelled<F, C>(operation: F, is_cancelled: C) -> Option<F::Output>
where
    F: Future,
    C: Fn() -> bool,
{
    tokio::pin!(operation);

    loop {
        if is_cancelled() {
            return None;
        }

        if let Ok(result) =
            tokio::time::timeout(CANCELLATION_POLL_INTERVAL, operation.as_mut()).await
        {
            return Some(result);
        }
    }
}

fn should_use_streaming_overlay(style: OverlayStyle, is_streaming: bool) -> bool {
    style == OverlayStyle::Live && is_streaming
}

/// Decide whether to start a local live-transcription worker and which VAD
/// policy controls the batch recording. Disabling VAD means "do not filter the
/// saved/batch audio"; the recorder still runs observational VAD and withholds
/// streaming callbacks behind its confirmed-speech latch.
fn streaming_capture_plan(
    is_local_backend: bool,
    vad_enabled: bool,
    model_supports_streaming: bool,
) -> (bool, VadPolicy) {
    let streaming_enabled = is_local_backend && model_supports_streaming;
    let vad_policy = if !vad_enabled {
        VadPolicy::Disabled
    } else if streaming_enabled {
        VadPolicy::Streaming
    } else {
        VadPolicy::Offline
    };
    (streaming_enabled, vad_policy)
}

fn remove_recording_file(path: &std::path::Path) {
    match std::fs::remove_file(path) {
        Ok(()) => debug!("Discarded uncommitted recording artifact"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => warn!("Could not discard uncommitted recording artifact: {error}"),
    }
}

async fn save_verified_recording(path: std::path::PathBuf, samples: Vec<f32>) -> bool {
    let sample_count = samples.len();
    let path_for_write = path.clone();
    let save = tauri::async_runtime::spawn_blocking(move || {
        crate::audio_toolkit::save_wav_file(&path_for_write, &samples)
    })
    .await;

    match save {
        Ok(Ok(())) => match crate::audio_toolkit::verify_wav_file(&path, sample_count) {
            Ok(()) => true,
            Err(error) => {
                error!("WAV verification failed: {error}");
                remove_recording_file(&path);
                false
            }
        },
        Ok(Err(error)) => {
            error!("Failed to save WAV file: {error}");
            remove_recording_file(&path);
            false
        }
        Err(error) => {
            error!("WAV save task panicked: {error}");
            remove_recording_file(&path);
            false
        }
    }
}

async fn post_process_transcription(settings: &AppSettings, transcription: &str) -> Option<String> {
    if is_blank_transcription(transcription) {
        debug!("Post-processing skipped because the transcription is empty");
        return None;
    }

    let provider = match settings.active_post_process_provider().cloned() {
        Some(provider) => provider,
        None => {
            debug!("Post-processing enabled but no provider is selected");
            return None;
        }
    };

    let model = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    if model.trim().is_empty() {
        debug!(
            "Post-processing skipped because provider '{}' has no model configured",
            provider.id
        );
        return None;
    }

    let selected_prompt_id = match &settings.post_process_selected_prompt_id {
        Some(id) => id.clone(),
        None => {
            debug!("Post-processing skipped because no prompt is selected");
            return None;
        }
    };

    let prompt = match settings
        .post_process_prompts
        .iter()
        .find(|prompt| prompt.id == selected_prompt_id)
    {
        Some(prompt) => prompt.prompt.clone(),
        None => {
            debug!(
                "Post-processing skipped because prompt '{}' was not found",
                selected_prompt_id
            );
            return None;
        }
    };

    if prompt.trim().is_empty() {
        debug!("Post-processing skipped because the selected prompt is empty");
        return None;
    }

    debug!(
        "Starting LLM post-processing with provider '{}' (model: {})",
        provider.id, model
    );

    let api_key = settings
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    // Ask these providers to skip reasoning/thinking — post-processing rarely
    // benefits from it and it adds seconds of latency. llm_client picks the
    // field the endpoint understands and retries without it if rejected.
    let disable_reasoning = matches!(provider.id.as_str(), "custom" | "openrouter");

    if provider.supports_structured_output {
        debug!("Using structured outputs for provider '{}'", provider.id);

        let system_prompt = build_system_prompt(&prompt);
        let user_content = transcription.to_string();

        // Handle Apple Intelligence separately since it uses native Swift APIs
        if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            {
                if !apple_intelligence::check_apple_intelligence_availability() {
                    debug!(
                        "Apple Intelligence selected but not currently available on this device"
                    );
                    return None;
                }

                let token_limit = model.trim().parse::<i32>().unwrap_or(0);
                return match apple_intelligence::process_text_with_system_prompt(
                    &system_prompt,
                    &user_content,
                    token_limit,
                ) {
                    Ok(result) => {
                        if result.trim().is_empty() {
                            debug!("Apple Intelligence returned an empty response");
                            None
                        } else {
                            let result = strip_invisible_chars(&result);
                            debug!(
                                "Apple Intelligence post-processing succeeded. Output length: {} chars",
                                result.len()
                            );
                            Some(result)
                        }
                    }
                    Err(err) => {
                        error!("Apple Intelligence post-processing failed: {}", err);
                        None
                    }
                };
            }

            #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
            {
                debug!("Apple Intelligence provider selected on unsupported platform");
                return None;
            }
        }

        // Define JSON schema for transcription output
        let json_schema = serde_json::json!({
            "type": "object",
            "properties": {
                (TRANSCRIPTION_FIELD): {
                    "type": "string",
                    "description": "The cleaned and processed transcription text"
                }
            },
            "required": [TRANSCRIPTION_FIELD],
            "additionalProperties": false
        });

        match crate::llm_client::send_chat_completion_with_schema(
            &provider,
            api_key.clone(),
            &model,
            user_content,
            Some(system_prompt),
            Some(json_schema),
            disable_reasoning,
        )
        .await
        {
            Ok(Some(content)) => {
                // Parse the JSON response to extract the transcription field
                let content = strip_think_block(&content);
                match serde_json::from_str::<serde_json::Value>(content) {
                    Ok(json) => {
                        if let Some(transcription_value) =
                            json.get(TRANSCRIPTION_FIELD).and_then(|t| t.as_str())
                        {
                            let result = strip_invisible_chars(transcription_value);
                            debug!(
                                "Structured output post-processing succeeded for provider '{}'. Output length: {} chars",
                                provider.id,
                                result.len()
                            );
                            return Some(result);
                        } else {
                            error!("Structured output response missing 'transcription' field");
                            return Some(strip_invisible_chars(content));
                        }
                    }
                    Err(e) => {
                        error!(
                            "Failed to parse structured output JSON: {}. Returning raw content.",
                            e
                        );
                        return Some(strip_invisible_chars(content));
                    }
                }
            }
            Ok(None) => {
                error!("LLM API response has no content");
                return None;
            }
            Err(e) => {
                warn!(
                    "Structured output failed for provider '{}': {}. Falling back to legacy mode.",
                    provider.id, e
                );
                // Fall through to legacy mode below
            }
        }
    }

    // Legacy mode: Replace ${output} variable in the prompt with the actual text
    let processed_prompt = prompt.replace("${output}", transcription);
    debug!("Processed prompt length: {} chars", processed_prompt.len());

    match crate::llm_client::send_chat_completion(
        &provider,
        api_key,
        &model,
        processed_prompt,
        disable_reasoning,
    )
    .await
    {
        Ok(Some(content)) => {
            let content = strip_invisible_chars(strip_think_block(&content));
            debug!(
                "LLM post-processing succeeded for provider '{}'. Output length: {} chars",
                provider.id,
                content.len()
            );
            Some(content)
        }
        Ok(None) => {
            error!("LLM API response has no content");
            None
        }
        Err(e) => {
            error!(
                "LLM post-processing failed for provider '{}': {}. Falling back to original transcription.",
                provider.id,
                e
            );
            None
        }
    }
}

async fn maybe_convert_chinese_variant(
    effective_language: &str,
    transcription: &str,
) -> Option<String> {
    // Gate on the language the model actually transcribed in (the effective
    // language), not the persisted intent. A leftover zh-Hans/zh-Hant intent
    // from a previously selected model must not run OpenCC S2T/T2S over output a
    // non-Chinese model produced — that would silently rewrite any shared CJK
    // characters (e.g. Japanese kanji) in the result.
    let is_simplified = effective_language == "zh-Hans";
    let is_traditional = effective_language == "zh-Hant";

    if !is_simplified && !is_traditional {
        debug!("effective language is not Simplified or Traditional Chinese; skipping conversion");
        return None;
    }

    debug!(
        "Starting Chinese variant conversion using OpenCC for language: {}",
        effective_language
    );

    // Use OpenCC to convert based on selected language
    let config = if is_simplified {
        // Convert Traditional Chinese to Simplified Chinese
        BuiltinConfig::Tw2sp
    } else {
        // Convert Simplified Chinese to Traditional Chinese
        BuiltinConfig::S2tw
    };

    match OpenCC::from_config(config) {
        Ok(converter) => {
            let converted = converter.convert(transcription);
            debug!(
                "OpenCC translation completed. Input length: {}, Output length: {}",
                transcription.len(),
                converted.len()
            );
            Some(converted)
        }
        Err(e) => {
            error!("Failed to initialize OpenCC converter: {}. Falling back to original transcription.", e);
            None
        }
    }
}

pub(crate) struct ProcessedTranscription {
    pub final_text: String,
    pub post_processed_text: Option<String>,
    pub post_process_prompt: Option<String>,
}

/// Resolve the persisted language *intent* into the language the currently-loaded
/// model will actually use — the same capability-aware coercion the transcription
/// paths apply (see [`crate::managers::model::effective_language`]). Post-processing
/// resolves it independently so it agrees with the language the transcription ran
/// in, without threading a value through the pipeline.
fn resolve_effective_language(app: &AppHandle, settings: &AppSettings) -> String {
    if settings.transcription_backend == TranscriptionBackend::Gemini {
        return settings.gemini_language.clone();
    }

    let tm = app.state::<Arc<TranscriptionManager>>();
    let model_manager = app.state::<Arc<ModelManager>>();
    let active_model = tm
        .get_current_model()
        .unwrap_or_else(|| settings.selected_model.clone());
    match model_manager.get_model_info(&active_model) {
        Some(info) => crate::managers::model::effective_language(
            &settings.selected_language,
            &info.supported_languages,
            info.supports_language_detection,
        ),
        None => settings.selected_language.clone(),
    }
}

pub(crate) async fn process_transcription_output(
    app: &AppHandle,
    transcription: &str,
    post_process: bool,
) -> ProcessedTranscription {
    let settings = get_settings(app);
    process_transcription_output_with_settings(app, transcription, post_process, &settings).await
}

async fn process_transcription_output_with_settings(
    app: &AppHandle,
    transcription: &str,
    post_process: bool,
    settings: &AppSettings,
) -> ProcessedTranscription {
    let mut final_text = transcription.to_string();
    let mut post_processed_text: Option<String> = None;
    let mut post_process_prompt: Option<String> = None;

    // Resolve the language the transcription actually ran in (the persisted
    // intent coerced against the loaded model's capabilities) so OpenCC keys off
    // the effective language rather than a possibly-stale intent.
    let effective_language = resolve_effective_language(app, settings);
    if let Some(converted_text) =
        maybe_convert_chinese_variant(&effective_language, transcription).await
    {
        final_text = converted_text;
    }

    if post_process {
        if let Some(processed_text) = post_process_transcription(settings, &final_text).await {
            post_processed_text = Some(processed_text.clone());
            final_text = processed_text;

            if let Some(prompt_id) = &settings.post_process_selected_prompt_id {
                if let Some(prompt) = settings
                    .post_process_prompts
                    .iter()
                    .find(|prompt| &prompt.id == prompt_id)
                {
                    post_process_prompt = Some(prompt.prompt.clone());
                }
            }
        }
    } else if final_text != transcription {
        post_processed_text = Some(final_text.clone());
    }

    ProcessedTranscription {
        final_text,
        post_processed_text,
        post_process_prompt,
    }
}

impl ShortcutAction for TranscribeAction {
    fn start(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        let start_time = Instant::now();
        debug!("TranscribeAction::start called for binding: {}", binding_id);

        let tm = app.state::<Arc<TranscriptionManager>>();
        let rm = app.state::<Arc<AudioRecordingManager>>();
        let settings = get_settings(app);
        let is_local_backend = settings.transcription_backend == TranscriptionBackend::Local;

        // Arm the immutable operation snapshot and wait for Escape to be fully
        // registered before any microphone samples or provider work can begin.
        // A registration failure is fail-closed: capture never starts.
        let operation_cancel_generation = match rm.arm_operation(settings.clone()) {
            Ok(generation) => generation,
            Err(error) => {
                warn!("Failed to arm transcription operation: {error}");
                return;
            }
        };
        if let Err(error) = shortcut::register_cancel_shortcut(app) {
            rm.finish_operation();
            error!("Failed to register Escape cancellation: {error}");
            let _ = app.emit(
                "recording-error",
                RecordingErrorEvent {
                    error_type: "unknown".to_string(),
                    detail: Some(format!("Failed to register Escape cancellation: {error}")),
                },
            );
            return;
        }

        // Load only the selected provider's prerequisites. Gemini deliberately
        // stays outside the downloadable local-model lifecycle.
        let kickoff_started = Instant::now();
        if is_local_backend {
            tm.initiate_model_load_with_settings(settings.clone());
        }
        let rm_clone = Arc::clone(&rm);
        std::thread::spawn(move || {
            if let Err(e) = rm_clone.preload_vad() {
                debug!("VAD pre-load failed: {}", e);
            }
        });
        let kickoff_elapsed = kickoff_started.elapsed();

        let binding_id = binding_id.to_string();
        let tray_started = Instant::now();
        set_tray_state(app, TrayIconState::Recording);
        let tray_elapsed = tray_started.elapsed();

        let plan_started = Instant::now();
        let is_always_on = settings.always_on_microphone;

        let selected_model_info = is_local_backend.then(|| {
            app.state::<Arc<ModelManager>>()
                .get_model_info(&settings.selected_model)
        });

        // Use the app-facing model capability as the single pre-recording source
        // for live streaming decisions. Unknown support is represented as false
        // until the model registry is updated by discovery or runtime load.
        let model_supports_streaming = selected_model_info
            .as_ref()
            .and_then(|model| model.as_ref())
            .map(|m| m.supports_streaming)
            .unwrap_or(false);
        // `vad_enabled` controls batch filtering, not model capability. Even
        // when filtering is disabled the recorder's observational VAD and
        // confirmed two-frame latch guard every streaming callback.
        let (streaming_enabled, vad_policy) = streaming_capture_plan(
            is_local_backend,
            settings.vad_enabled,
            model_supports_streaming,
        );
        if streaming_enabled {
            tm.start_stream_with_settings(settings.clone());
        }
        let plan_elapsed = plan_started.elapsed();

        // Sizing the overlay follows the same advertised capability. A model that
        // doesn't stream (or whose capability is not known yet) gets the compact
        // pill instead of an oversized transparent live window.
        let overlay_started = Instant::now();
        match settings.overlay_style {
            OverlayStyle::Live if streaming_enabled => utils::show_streaming_overlay(app),
            OverlayStyle::Live | OverlayStyle::Minimal => show_recording_overlay(app),
            OverlayStyle::None => {} // show_overlay_state no-ops on None anyway
        }
        // Everything above runs before capture can begin, so each span here is
        // added keypress->capture latency.
        debug!(
            "start-path pre-recording steps: model_kickoff={:?} tray={:?} settings+stream_plan={:?} overlay={:?}",
            kickoff_elapsed,
            tray_elapsed,
            plan_elapsed,
            overlay_started.elapsed()
        );
        debug!("Microphone mode - always_on: {}", is_always_on);

        let mut recording_error = rm
            .was_cancelled_since(operation_cancel_generation)
            .then(|| "Operation cancelled before microphone capture".to_string());
        let recording_start_time = Instant::now();
        if recording_error.is_none() {
            match rm.try_start_recording(&binding_id, vad_policy, operation_cancel_generation) {
                Ok(readiness) => {
                    debug!(
                        "Recording request accepted in {:?}; waiting for first microphone samples",
                        recording_start_time.elapsed()
                    );
                    let generation = readiness.generation();
                    let app_clone = app.clone();
                    let rm_clone = Arc::clone(&rm);
                    std::thread::spawn(move || {
                        if !readiness.wait() {
                            debug!("Microphone readiness wait ended without receiving samples");
                            return;
                        }

                        // Development-only preview hook for evaluating the brief
                        // arming animation on hardware that normally starts too fast
                        // to make it visible.
                        #[cfg(debug_assertions)]
                        if let Ok(delay_ms) = std::env::var("HANDY_DEBUG_MIC_READY_DELAY_MS")
                            .unwrap_or_default()
                            .parse::<u64>()
                        {
                            let delay_ms = delay_ms.min(10_000);
                            if delay_ms > 0 {
                                debug!(
                                    "Delaying microphone-ready cue by {delay_ms}ms for UI preview"
                                );
                                std::thread::sleep(Duration::from_millis(delay_ms));
                            }
                        }

                        if !rm_clone.is_recording_readiness_current(generation) {
                            debug!("Microphone became ready for an inactive recording");
                            return;
                        }

                        debug!("Microphone is receiving samples; recording is ready");
                        utils::emit_recording_ready(&app_clone);

                        // The start chime is a readiness cue, so it must follow the
                        // first real input callback rather than Stream::play() or a
                        // fixed delay. The helper returns immediately when feedback
                        // is disabled; mute still follows the same readiness point.
                        if rm_clone.is_recording_readiness_current(generation) {
                            play_feedback_sound_blocking(&app_clone, SoundType::Start);
                        }
                        if rm_clone.is_recording_readiness_current(generation) {
                            rm_clone.apply_mute();
                        }
                    });
                }
                Err(e) => {
                    debug!("Failed to start recording: {}", e);
                    recording_error = Some(e);
                }
            }
        }

        if recording_error.is_some() {
            // Starting failed (for example due to blocked microphone permissions).
            // Revert UI state so we don't stay stuck in the recording overlay.
            shortcut::unregister_cancel_shortcut(app);
            rm.finish_operation();
            tm.cancel_stream();
            utils::hide_recording_overlay(app);
            set_tray_state(app, TrayIconState::Idle);
            if let Some(err) = recording_error {
                if !rm.was_cancelled_since(operation_cancel_generation) {
                    let error_type = if is_microphone_access_denied(&err) {
                        "microphone_permission_denied"
                    } else if is_no_input_device_error(&err) {
                        "no_input_device"
                    } else {
                        "unknown"
                    };
                    let _ = app.emit(
                        "recording-error",
                        RecordingErrorEvent {
                            error_type: error_type.to_string(),
                            detail: Some(err),
                        },
                    );
                }
            }
        }

        debug!(
            "TranscribeAction::start completed in {:?}",
            start_time.elapsed()
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        // Prevent a slow microphone from emitting a ready event or start chime
        // after the user has already requested stop.
        app.state::<Arc<AudioRecordingManager>>()
            .invalidate_recording_readiness();

        let stop_time = Instant::now();
        debug!("TranscribeAction::stop called for binding: {}", binding_id);

        let ah = app.clone();
        let rm = Arc::clone(&app.state::<Arc<AudioRecordingManager>>());
        let tm = Arc::clone(&app.state::<Arc<TranscriptionManager>>());
        let hm = Arc::clone(&app.state::<Arc<HistoryManager>>());

        set_tray_state(app, TrayIconState::Transcribing);
        // Stop should give immediate visual feedback. Live streaming can keep
        // the larger panel, but it still switches from listening to a working
        // spinner while the stream finalizes. Non-streaming paths use the
        // compact transcribing pill (None no-ops in show_*).
        let style = get_settings(app).overlay_style;
        // Capture this before finalizing the stream so every later working state
        // targets the same overlay that was shown for this transcription.
        let use_streaming_overlay = should_use_streaming_overlay(style, tm.is_streaming());
        if use_streaming_overlay {
            tm.emit_stream_working(StreamWorkKind::Transcribing);
        } else {
            show_transcribing_overlay(app);
        }

        // Unmute before playing audio feedback so the stop sound is audible
        rm.remove_mute();

        // Play audio feedback for recording stop
        play_feedback_sound(app, SoundType::Stop);

        let binding_id = binding_id.to_string(); // Clone binding_id for the async task
        let post_process = self.post_process;
        let cancel_generation = rm.operation_cancel_generation();

        tauri::async_runtime::spawn(async move {
            // The main-thread paste closure takes its own Arc when scheduled,
            // keeping Escape registered until the last user-visible side
            // effect has either committed or been discarded.
            let finish_guard = Arc::new(FinishGuard(ah.clone()));
            debug!(
                "Starting async transcription task for binding: {}",
                binding_id
            );

            let stop_recording_time = Instant::now();
            let Some(captured) = rm.stop_recording(&binding_id, cancel_generation) else {
                debug!("No captured audio retrieved from recording stop");
                tm.cancel_stream();
                utils::hide_recording_overlay(&ah);
                set_tray_state(&ah, TrayIconState::Idle);
                return;
            };
            let settings = rm.take_session_settings().unwrap_or_else(|| {
                warn!("Recording settings snapshot was unavailable; using current settings");
                get_settings(&ah)
            });
            let evidence = captured.evidence;
            let samples = captured.samples;
            if rm.was_cancelled_since(cancel_generation) {
                debug!("Transcription operation cancelled after recording stop");
                tm.cancel_stream();
                utils::hide_recording_overlay(&ah);
                set_tray_state(&ah, TrayIconState::Idle);
                return;
            }

            let backend = settings.transcription_backend;
            let speech_presence = pre_stt_verdict(&evidence);
            info!(
                "speech_guard_capture backend={backend:?} model_id={:?} stop_elapsed_ms={} raw_duration_ms={} raw_sample_count={} raw_sample_rate_hz={} output_sample_count={} rms_amplitude={:.8} peak_amplitude={:.8} crest_factor={:.4} vad_analyzed_frames={} vad_voiced_frames={} vad_voiced_duration_ms={} vad_voiced_ratio={:.6} vad_required_density={:?} vad_confirmed_speech_onsets={} vad_onset_frames={} vad_longest_voiced_run_frames={} vad_longest_voiced_run_ms={} vad_latest_confirmed_run_frames={} vad_latest_confirmed_run_ms={} vad_last_voiced_frame={:?} vad_frames_since_last_voice={:?} vad_last_confirmed_speech_frame={:?} vad_frames_since_last_confirmed_speech={:?} vad_hangover_frames={} vad_recent_confirmed_tail={} vad_sustained_density={} vad_error_frames={} vad_probability_frames={} vad_mean_probability={:?} vad_max_probability={:?} vad_probability_threshold={:?} pre_stt={:?}",
                settings.selected_model,
                stop_recording_time.elapsed().as_millis(),
                evidence.raw_duration_ms,
                evidence.raw_sample_count,
                evidence.raw_sample_rate_hz,
                evidence.output_sample_count,
                evidence.rms_amplitude,
                evidence.peak_amplitude,
                evidence.crest_factor(),
                evidence.vad_analyzed_frames,
                evidence.vad_voiced_frames,
                evidence.vad_voiced_frames.saturating_mul(30),
                evidence.vad_voiced_ratio(),
                evidence.vad_required_density(),
                evidence.vad_confirmed_speech_onsets,
                evidence.vad_onset_frames,
                evidence.vad_longest_voiced_run_frames,
                evidence.vad_longest_voiced_run_frames.saturating_mul(30),
                evidence.vad_latest_confirmed_run_frames,
                evidence.vad_latest_confirmed_run_frames.saturating_mul(30),
                evidence.vad_last_voiced_frame,
                evidence.vad_frames_since_last_voice(),
                evidence.vad_last_confirmed_speech_frame,
                evidence.vad_frames_since_last_confirmed_speech(),
                evidence.vad_hangover_frames,
                evidence.vad_has_recent_confirmed_tail(),
                evidence.vad_has_sustained_density(),
                evidence.vad_error_frames,
                evidence.vad_probability_frames,
                evidence.vad_mean_probability,
                evidence.vad_max_probability,
                evidence.vad_probability_threshold,
                speech_presence,
            );
            if speech_presence == SpeechPresenceVerdict::NoSpeech || samples.is_empty() {
                info!(
                    "speech_guard_final backend={backend:?} model_id={:?} pre_stt={speech_presence:?} post_stt=NotRunPreSttRejected transcript_class=not_run transcript_chars=0 transcript_words=0",
                    settings.selected_model,
                );
                debug!("No meaningful speech detected; skipping provider and persistence");
                tm.cancel_stream();
                utils::hide_recording_overlay(&ah);
                set_tray_state(&ah, TrayIconState::Idle);
                return;
            }

            let transcription_time = Instant::now();
            let transcription_result: Result<String, String> = match backend {
                TranscriptionBackend::Local => match tm.finalize_stream_with_settings(&settings) {
                    // A finalized stream with usable text wins. Otherwise the
                    // complete, already-gated capture is batch transcribed.
                    Ok(Some(text)) if !text.trim().is_empty() => Ok(text),
                    Ok(_) => tm
                        .transcribe_with_settings(samples.clone(), &settings)
                        .map_err(|error| error.to_string()),
                    Err(error) => Err(error.to_string()),
                },
                TranscriptionBackend::Gemini => {
                    tm.cancel_stream();
                    if rm.was_cancelled_since(cancel_generation) {
                        debug!("Gemini transcription cancelled before request creation");
                        utils::hide_recording_overlay(&ah);
                        set_tray_state(&ah, TrayIconState::Idle);
                        return;
                    }

                    let client = match crate::gemini_key::load() {
                        Ok(Some(api_key)) => crate::gemini::GeminiClient::new(api_key)
                            .map_err(|error| error.to_string()),
                        Ok(None) => Err("A Gemini API key is required".to_string()),
                        Err(error) => Err(error),
                    };

                    match client {
                        Ok(client) => {
                            if rm.was_cancelled_since(cancel_generation) {
                                debug!("Gemini transcription cancelled before request preparation");
                                utils::hide_recording_overlay(&ah);
                                set_tray_state(&ah, TrayIconState::Idle);
                                return;
                            }
                            match client.prepare_transcription(
                                &samples,
                                settings.gemini_transcription_mode,
                                &settings.gemini_language,
                                &settings.custom_words,
                            ) {
                                Ok(prepared) => {
                                    // WAV/base64/JSON preparation is synchronous
                                    // and can be material for a long capture. An
                                    // ESC during that work must win before
                                    // reqwest is ever polled.
                                    if rm.was_cancelled_since(cancel_generation) {
                                        debug!("Gemini transcription cancelled before upload");
                                        utils::hide_recording_overlay(&ah);
                                        set_tray_state(&ah, TrayIconState::Idle);
                                        return;
                                    }
                                    if !rm.try_claim_upload_start(cancel_generation) {
                                        debug!(
                                            "Gemini upload admission lost to cancellation; request not started"
                                        );
                                        utils::hide_recording_overlay(&ah);
                                        set_tray_state(&ah, TrayIconState::Idle);
                                        return;
                                    }
                                    let Some(result) = complete_unless_cancelled(
                                        client.send_prepared_transcription(prepared),
                                        || rm.was_cancelled_since(cancel_generation),
                                    )
                                    .await
                                    else {
                                        debug!(
                                            "In-flight Gemini request cancelled; result discarded"
                                        );
                                        utils::hide_recording_overlay(&ah);
                                        set_tray_state(&ah, TrayIconState::Idle);
                                        return;
                                    };
                                    result.map_err(|error| error.to_string())
                                }
                                Err(error) => Err(error.to_string()),
                            }
                        }
                        Err(error) => Err(error),
                    }
                }
            };

            if rm.was_cancelled_since(cancel_generation) {
                debug!("Transcription operation cancelled before output handling");
                utils::hide_recording_overlay(&ah);
                set_tray_state(&ah, TrayIconState::Idle);
                return;
            }

            match transcription_result {
                Ok(transcription) => {
                    let (transcript_class, transcript_chars, transcript_words) =
                        transcript_shape(&transcription);
                    debug!(
                        "Transcription completed in {:?}: class={} chars={} words={}",
                        transcription_time.elapsed(),
                        transcript_class,
                        transcript_chars,
                        transcript_words,
                    );

                    let post_stt = post_stt_verdict(
                        speech_presence,
                        &evidence,
                        &transcription,
                        // transcribe-cpp 0.2 exposes family-specific token
                        // probability hints, but no calibrated Whisper
                        // no-speech probability through this safe result path.
                        // Do not invent a cross-provider confidence aggregate
                        // before physical calibration establishes its meaning.
                        PostSttEvidence::default(),
                    );
                    info!(
                        "speech_guard_final backend={backend:?} model_id={:?} pre_stt={speech_presence:?} post_stt={post_stt:?} transcript_class={transcript_class} transcript_chars={transcript_chars} transcript_words={transcript_words}",
                        settings.selected_model,
                    );
                    if post_stt == TranscriptVerdict::RejectLikelyHallucination {
                        debug!("Post-STT guard rejected a likely no-speech hallucination");
                        utils::hide_recording_overlay(&ah);
                        set_tray_state(&ah, TrayIconState::Idle);
                        return;
                    }

                    if post_process {
                        if use_streaming_overlay {
                            tm.emit_stream_working(StreamWorkKind::Polishing);
                        } else {
                            show_processing_overlay(&ah);
                        }
                    }
                    let Some(processed) = complete_unless_cancelled(
                        process_transcription_output_with_settings(
                            &ah,
                            &transcription,
                            post_process,
                            &settings,
                        ),
                        || rm.was_cancelled_since(cancel_generation),
                    )
                    .await
                    else {
                        debug!("Transcription operation cancelled during output handling");
                        utils::hide_recording_overlay(&ah);
                        set_tray_state(&ah, TrayIconState::Idle);
                        return;
                    };

                    if rm.was_cancelled_since(cancel_generation)
                        || processed.final_text.trim().is_empty()
                    {
                        debug!("Output was cancelled or empty; skipping paste and persistence");
                        utils::hide_recording_overlay(&ah);
                        set_tray_state(&ah, TrayIconState::Idle);
                        return;
                    }

                    // A recording becomes durable only after both guards and
                    // output processing succeed. Until history commits, this
                    // WAV is an uncommitted artifact and every cancel/error
                    // branch below removes it.
                    let file_name =
                        format!("handy-api-{}.wav", chrono::Utc::now().timestamp_millis());
                    let wav_path = hm.recordings_dir().join(&file_name);
                    let wav_saved = save_verified_recording(wav_path.clone(), samples).await;

                    if rm.was_cancelled_since(cancel_generation) {
                        debug!("Transcription operation cancelled before paste");
                        if wav_saved {
                            remove_recording_file(&wav_path);
                        }
                        utils::hide_recording_overlay(&ah);
                        set_tray_state(&ah, TrayIconState::Idle);
                        return;
                    }

                    let ah_clone = ah.clone();
                    let rm_for_paste = Arc::clone(&rm);
                    let hm_for_paste = Arc::clone(&hm);
                    let guard_for_paste = Arc::clone(&finish_guard);
                    let wav_path_for_paste = wav_path.clone();
                    let wav_path_for_schedule_error = wav_path;
                    let paste_time = Instant::now();
                    let final_text = processed.final_text;
                    let post_processed_text = processed.post_processed_text;
                    let post_process_prompt = processed.post_process_prompt;
                    let schedule = ah.run_on_main_thread(move || {
                        let _guard = guard_for_paste;
                        if !rm_for_paste.try_claim_paste(cancel_generation) {
                            debug!("Transcription operation cancelled before paste");
                            if wav_saved {
                                remove_recording_file(&wav_path_for_paste);
                            }
                            utils::hide_recording_overlay(&ah_clone);
                            set_tray_state(&ah_clone, TrayIconState::Idle);
                            return;
                        }
                        // Paste is now the committed outcome of the operation;
                        // stop accepting Escape before entering OS clipboard /
                        // input APIs.
                        shortcut::unregister_cancel_shortcut(&ah_clone);

                        let paste_succeeded = match utils::paste(final_text, ah_clone.clone()) {
                            Ok(()) => {
                                debug!("Text pasted successfully in {:?}", paste_time.elapsed());
                                true
                            }
                            Err(error) => {
                                error!("Failed to paste transcription: {error}");
                                let _ = ah_clone.emit("paste-error", ());
                                false
                            }
                        };

                        if !paste_succeeded {
                            if wav_saved {
                                remove_recording_file(&wav_path_for_paste);
                            }
                            utils::hide_recording_overlay(&ah_clone);
                            set_tray_state(&ah_clone, TrayIconState::Idle);
                            return;
                        }

                        if wav_saved {
                            if let Err(error) = hm_for_paste.save_entry(
                                file_name,
                                transcription,
                                post_process,
                                post_processed_text,
                                post_process_prompt,
                            ) {
                                error!("Failed to save history entry: {error}");
                                remove_recording_file(&wav_path_for_paste);
                            }
                        }
                        utils::hide_recording_overlay(&ah_clone);
                        set_tray_state(&ah_clone, TrayIconState::Idle);
                    });

                    if let Err(error) = schedule {
                        error!("Failed to run paste on main thread: {error:?}");
                        if wav_saved {
                            remove_recording_file(&wav_path_for_schedule_error);
                        }
                        utils::hide_recording_overlay(&ah);
                        set_tray_state(&ah, TrayIconState::Idle);
                    }
                }
                Err(error) => {
                    info!(
                        "speech_guard_final backend={backend:?} model_id={:?} pre_stt={speech_presence:?} post_stt=NotRunProviderError transcript_class=not_available transcript_chars=0 transcript_words=0",
                        settings.selected_model,
                    );
                    if rm.was_cancelled_since(cancel_generation) {
                        debug!("Transcription operation cancelled after provider error");
                        utils::hide_recording_overlay(&ah);
                        set_tray_state(&ah, TrayIconState::Idle);
                        return;
                    }

                    error!("Transcription failed: {error}");
                    let _ = ah.emit("transcription-error", error);

                    // Provider failures are non-durable. Keeping a retry WAV
                    // here creates a check-then-write race with Escape and can
                    // leave a failed row after a hard cancel; a retry is a new,
                    // independently guarded operation instead.
                    utils::hide_recording_overlay(&ah);
                    set_tray_state(&ah, TrayIconState::Idle);
                }
            }
        });

        debug!(
            "TranscribeAction::stop completed in {:?}",
            stop_time.elapsed()
        );
    }
}

// Cancel Action
struct CancelAction;

impl ShortcutAction for CancelAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        utils::cancel_current_operation(app);
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Nothing to do on stop for cancel
    }
}

// Test Action
struct TestAction;

impl ShortcutAction for TestAction {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        log::info!(
            "Shortcut ID '{}': Started - {} (App: {})", // Changed "Pressed" to "Started" for consistency
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        log::info!(
            "Shortcut ID '{}': Stopped - {} (App: {})", // Changed "Released" to "Stopped" for consistency
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }
}

// Static Action Map
pub static ACTION_MAP: Lazy<HashMap<String, Arc<dyn ShortcutAction>>> = Lazy::new(|| {
    let mut map = HashMap::new();
    map.insert(
        "transcribe".to_string(),
        Arc::new(TranscribeAction {
            post_process: false,
        }) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "transcribe_with_post_process".to_string(),
        Arc::new(TranscribeAction { post_process: true }) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "cancel".to_string(),
        Arc::new(CancelAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "test".to_string(),
        Arc::new(TestAction) as Arc<dyn ShortcutAction>,
    );
    map
});

#[cfg(test)]
mod tests {
    use super::{
        complete_unless_cancelled, is_blank_transcription, should_use_streaming_overlay,
        streaming_capture_plan, strip_think_block, transcript_shape,
    };
    use crate::audio_toolkit::VadPolicy;
    use crate::settings::OverlayStyle;
    use std::future;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn blank_transcription_is_detected() {
        assert!(is_blank_transcription(""));
        assert!(is_blank_transcription("   "));
        assert!(is_blank_transcription("\t\n  \r\n"));
    }

    #[test]
    fn non_blank_transcription_is_kept() {
        assert!(!is_blank_transcription("hello"));
        assert!(!is_blank_transcription("  hello  "));
    }

    #[test]
    fn transcript_diagnostics_expose_shape_without_content() {
        assert_eq!(transcript_shape("  "), ("empty", 0, 0));
        assert_eq!(transcript_shape("감사합니다."), ("single_token", 6, 1));
        assert_eq!(
            transcript_shape("개인 정보는 로그에 쓰지 않습니다."),
            ("multi_token", 19, 5)
        );
    }

    #[test]
    fn completed_operation_returns_its_output() {
        let result = tauri::async_runtime::block_on(complete_unless_cancelled(
            future::ready("done"),
            || false,
        ));

        assert_eq!(result, Some("done"));
    }

    #[test]
    fn pending_operation_stops_after_cancellation() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_for_thread = Arc::clone(&cancelled);
        let cancel_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(10));
            cancelled_for_thread.store(true, Ordering::Release);
        });

        let result = tauri::async_runtime::block_on(complete_unless_cancelled(
            future::pending::<()>(),
            || cancelled.load(Ordering::Acquire),
        ));

        cancel_thread.join().unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn leading_think_block_is_stripped() {
        assert_eq!(
            strip_think_block("<think>pondering...</think>Cleaned text."),
            "Cleaned text."
        );
        assert_eq!(
            strip_think_block("  \n<think>multi\nline</think>\n  Cleaned text."),
            "Cleaned text."
        );
    }

    #[test]
    fn content_without_think_block_is_unchanged() {
        assert_eq!(strip_think_block("Cleaned text."), "Cleaned text.");
        assert_eq!(
            strip_think_block("Mentions <think> mid-sentence."),
            "Mentions <think> mid-sentence."
        );
        // Unclosed block: leave untouched rather than guess
        assert_eq!(
            strip_think_block("<think>never closed"),
            "<think>never closed"
        );
    }

    #[test]
    fn live_overlay_uses_streaming_states_only_for_streaming_models() {
        assert!(should_use_streaming_overlay(OverlayStyle::Live, true));
        assert!(!should_use_streaming_overlay(OverlayStyle::Live, false));
        assert!(!should_use_streaming_overlay(OverlayStyle::Minimal, true));
        assert!(!should_use_streaming_overlay(OverlayStyle::None, true));
    }

    #[test]
    fn local_streaming_survives_disabled_batch_vad() {
        assert_eq!(
            streaming_capture_plan(true, false, true),
            (true, VadPolicy::Disabled)
        );
        assert_eq!(
            streaming_capture_plan(true, true, true),
            (true, VadPolicy::Streaming)
        );
        assert_eq!(
            streaming_capture_plan(true, false, false),
            (false, VadPolicy::Disabled)
        );
        assert_eq!(
            streaming_capture_plan(false, true, true),
            (false, VadPolicy::Offline)
        );
    }
}

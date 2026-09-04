use std::{
    io::Error,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, Sample, SizedSample,
};

use crate::audio_toolkit::{
    audio::{AudioVisualiser, FrameResampler},
    constants,
    vad::{self, VadActivityReport, VadFrame},
    VoiceActivityDetector,
};
use crate::speech_guard::{CaptureEvidence, CapturedAudio};

enum Cmd {
    /// Begin capturing. Carries the send timestamp so the consumer can log how
    /// long the command sat in the channel, plus a one-shot acknowledgement
    /// sent only after the first microphone sample chunk is processed.
    Start(VadPolicy, Instant, mpsc::Sender<()>),
    Stop(mpsc::Sender<CapturedAudio>),
    Shutdown,
}

enum AudioChunk {
    Samples(Vec<f32>),
    EndOfStream,
}

/// How 16 kHz mono frames should be filtered for one recording session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VadPolicy {
    /// Bypass VAD and forward every frame.
    Disabled,
    /// Current offline-tuned VAD profile.
    Offline,
    /// VAD profile with a longer post-speech tail for streaming-capable models.
    Streaming,
}

/// A single VAD engine plus the two hangover-tail lengths its smoothing wrapper
/// should use. The offline and streaming policies are never active
/// concurrently, so one detector is reconfigured per session (see `Cmd::Start`)
/// rather than kept as two resident engines.
#[derive(Clone)]
struct VadConfig {
    detector: Arc<Mutex<Box<dyn vad::VoiceActivityDetector>>>,
    offline_hangover_frames: usize,
    streaming_hangover_frames: usize,
}

impl VadConfig {
    /// Post-speech hangover tail (in 30 ms frames) for the given policy.
    /// `Disabled` still runs observational VAD and maps to the offline value;
    /// only its batch-output filtering is bypassed.
    fn hangover_for(&self, policy: VadPolicy) -> usize {
        match policy {
            VadPolicy::Streaming => self.streaming_hangover_frames,
            VadPolicy::Offline | VadPolicy::Disabled => self.offline_hangover_frames,
        }
    }
}

/// Per-session statistics accumulated from native-rate mono PCM.  Measurements
/// happen before resampling, VAD filtering, streaming callbacks, or inference
/// padding so no later policy can erase the evidence.
struct CaptureEvidenceAccumulator {
    raw_sample_rate_hz: u32,
    raw_sample_count: usize,
    finite_sample_count: usize,
    exact_zero_samples: usize,
    non_finite_samples: usize,
    peak_amplitude: f32,
    sum_squares: f64,
    vad_successful_frames: usize,
    fallback_vad_voiced_frames: usize,
    fallback_vad_consecutive_speech_frames: usize,
    fallback_vad_confirmed_onsets: usize,
    fallback_vad_longest_voiced_run_frames: usize,
    fallback_vad_latest_confirmed_run_frames: usize,
    fallback_vad_last_voiced_frame: Option<usize>,
    fallback_vad_last_confirmed_speech_frame: Option<usize>,
    vad_error_frames: usize,
}

impl CaptureEvidenceAccumulator {
    fn new(raw_sample_rate_hz: u32) -> Self {
        Self {
            raw_sample_rate_hz,
            raw_sample_count: 0,
            finite_sample_count: 0,
            exact_zero_samples: 0,
            non_finite_samples: 0,
            peak_amplitude: 0.0,
            sum_squares: 0.0,
            vad_successful_frames: 0,
            fallback_vad_voiced_frames: 0,
            fallback_vad_consecutive_speech_frames: 0,
            fallback_vad_confirmed_onsets: 0,
            fallback_vad_longest_voiced_run_frames: 0,
            fallback_vad_latest_confirmed_run_frames: 0,
            fallback_vad_last_voiced_frame: None,
            fallback_vad_last_confirmed_speech_frame: None,
            vad_error_frames: 0,
        }
    }

    fn reset(&mut self) {
        *self = Self::new(self.raw_sample_rate_hz);
    }

    /// Observe the original values, then replace NaN/Inf with zero before they
    /// can poison the resampler, VAD, a streaming provider, or a WAV file.
    fn observe_and_sanitize(&mut self, samples: &mut [f32]) {
        self.raw_sample_count = self.raw_sample_count.saturating_add(samples.len());
        for sample in samples {
            if sample.is_finite() {
                self.finite_sample_count = self.finite_sample_count.saturating_add(1);
                if *sample == 0.0 {
                    self.exact_zero_samples = self.exact_zero_samples.saturating_add(1);
                }
                self.peak_amplitude = self.peak_amplitude.max(sample.abs());
                self.sum_squares += f64::from(*sample) * f64::from(*sample);
            } else {
                self.non_finite_samples = self.non_finite_samples.saturating_add(1);
                *sample = 0.0;
            }
        }
    }

    fn record_vad_success(&mut self, emitted_speech: bool) {
        self.vad_successful_frames = self.vad_successful_frames.saturating_add(1);
        self.fallback_vad_voiced_frames = self
            .fallback_vad_voiced_frames
            .saturating_add(usize::from(emitted_speech));
        if emitted_speech {
            self.fallback_vad_consecutive_speech_frames = self
                .fallback_vad_consecutive_speech_frames
                .saturating_add(1);
            self.fallback_vad_longest_voiced_run_frames = self
                .fallback_vad_longest_voiced_run_frames
                .max(self.fallback_vad_consecutive_speech_frames);
            self.fallback_vad_last_voiced_frame = Some(self.vad_successful_frames);
            if self.fallback_vad_consecutive_speech_frames >= vad::VAD_ONSET_FRAMES {
                self.fallback_vad_latest_confirmed_run_frames =
                    self.fallback_vad_consecutive_speech_frames;
                self.fallback_vad_last_confirmed_speech_frame = Some(self.vad_successful_frames);
            }
            if self.fallback_vad_consecutive_speech_frames == vad::VAD_ONSET_FRAMES {
                self.fallback_vad_confirmed_onsets =
                    self.fallback_vad_confirmed_onsets.saturating_add(1);
            }
        } else {
            self.fallback_vad_consecutive_speech_frames = 0;
        }
    }

    fn record_vad_error(&mut self) {
        self.vad_error_frames = self.vad_error_frames.saturating_add(1);
    }

    fn snapshot(
        &self,
        output_sample_count: usize,
        activity: Option<VadActivityReport>,
    ) -> CaptureEvidence {
        let raw_duration_ms = if self.raw_sample_rate_hz == 0 {
            0
        } else {
            ((self.raw_sample_count as u128 * 1_000) / u128::from(self.raw_sample_rate_hz))
                .min(u128::from(u64::MAX)) as u64
        };
        let rms_amplitude = if self.finite_sample_count == 0 {
            0.0
        } else {
            (self.sum_squares / self.finite_sample_count as f64).sqrt() as f32
        };
        let activity = activity.unwrap_or(VadActivityReport {
            analyzed_frames: self.vad_successful_frames,
            voiced_frames: self.fallback_vad_voiced_frames,
            confirmed_speech_onsets: self.fallback_vad_confirmed_onsets,
            onset_frames: vad::VAD_ONSET_FRAMES,
            longest_voiced_run_frames: self.fallback_vad_longest_voiced_run_frames,
            latest_confirmed_run_frames: self.fallback_vad_latest_confirmed_run_frames,
            last_voiced_frame: self.fallback_vad_last_voiced_frame,
            last_confirmed_speech_frame: self.fallback_vad_last_confirmed_speech_frame,
            ..VadActivityReport::default()
        });

        CaptureEvidence {
            raw_sample_count: self.raw_sample_count,
            raw_sample_rate_hz: self.raw_sample_rate_hz,
            raw_duration_ms,
            peak_amplitude: self.peak_amplitude,
            rms_amplitude,
            exact_zero_samples: self.exact_zero_samples,
            non_finite_samples: self.non_finite_samples,
            output_sample_count,
            vad_analyzed_frames: activity.analyzed_frames,
            vad_voiced_frames: activity.voiced_frames,
            vad_confirmed_speech_onsets: activity.confirmed_speech_onsets,
            vad_onset_frames: activity.onset_frames,
            vad_longest_voiced_run_frames: activity.longest_voiced_run_frames,
            vad_latest_confirmed_run_frames: activity.latest_confirmed_run_frames,
            vad_last_voiced_frame: activity.last_voiced_frame,
            vad_last_confirmed_speech_frame: activity.last_confirmed_speech_frame,
            vad_hangover_frames: activity.hangover_frames,
            vad_probability_frames: activity.probability_frames,
            vad_mean_probability: activity.mean_voice_probability,
            vad_max_probability: activity.max_voice_probability,
            vad_probability_threshold: activity.voice_probability_threshold,
            vad_error_frames: self.vad_error_frames,
        }
    }
}

/// Hold live-provider callbacks until the same two-frame VAD onset used by the
/// recorder confirms speech.  Keep at most one second of leading audio: this is
/// longer than SmoothedVad's 450 ms prefill while bounding a silent recording's
/// memory.  Batch output is accumulated separately and is never truncated.
struct StreamCallbackGate {
    pending: Vec<f32>,
    speech_confirmed: bool,
}

impl StreamCallbackGate {
    const MAX_PENDING_SAMPLES: usize = constants::WHISPER_SAMPLE_RATE as usize;

    fn new() -> Self {
        Self {
            pending: Vec::new(),
            speech_confirmed: false,
        }
    }

    fn reset(&mut self) {
        self.pending.clear();
        self.speech_confirmed = false;
    }

    fn feed(&mut self, samples: &[f32], audio_cb: &Option<AudioFrameCallback>) {
        let Some(callback) = audio_cb else {
            return;
        };
        if self.speech_confirmed {
            callback(samples);
            return;
        }

        self.pending.extend_from_slice(samples);
        if self.pending.len() > Self::MAX_PENDING_SAMPLES {
            let excess = self.pending.len() - Self::MAX_PENDING_SAMPLES;
            self.pending.drain(..excess);
        }
    }

    fn confirm_speech(&mut self, audio_cb: &Option<AudioFrameCallback>) {
        if self.speech_confirmed {
            return;
        }
        self.speech_confirmed = true;
        if let Some(callback) = audio_cb {
            if !self.pending.is_empty() {
                callback(&self.pending);
            }
        }
        self.pending.clear();
    }
}

fn emit_audio_frame(
    samples: &[f32],
    audio_cb: &Option<AudioFrameCallback>,
    stream_gate: &mut StreamCallbackGate,
    out_buf: &mut Vec<f32>,
) {
    out_buf.extend_from_slice(samples);
    stream_gate.feed(samples, audio_cb);
}

/// Analyze every 16 kHz frame even when filtering is disabled.  The active
/// policy controls only what is forwarded, never whether evidence is gathered.
fn process_frame(
    samples: &[f32],
    recording: bool,
    vad_policy: VadPolicy,
    vad: &Option<VadConfig>,
    audio_cb: &Option<AudioFrameCallback>,
    stream_gate: &mut StreamCallbackGate,
    out_buf: &mut Vec<f32>,
    evidence: &mut CaptureEvidenceAccumulator,
) {
    if !recording {
        return;
    }

    if let Some(cfg) = vad {
        let mut detector = cfg.detector.lock().unwrap();
        match detector.push_frame(samples) {
            Ok(frame) => {
                let confirmed_speech = frame.is_speech();
                evidence.record_vad_success(confirmed_speech);
                match (vad_policy, frame) {
                    (VadPolicy::Disabled, _) => {
                        emit_audio_frame(samples, audio_cb, stream_gate, out_buf)
                    }
                    (_, VadFrame::Speech(buffer)) => {
                        emit_audio_frame(buffer, audio_cb, stream_gate, out_buf)
                    }
                    (_, VadFrame::Noise) => {}
                }
                if confirmed_speech {
                    stream_gate.confirm_speech(audio_cb);
                }
            }
            Err(error) => {
                evidence.record_vad_error();
                // Preserve the existing fail-open audio behavior, but no longer
                // misreport a detector failure as affirmative voice evidence.
                log::warn!("VAD frame analysis failed; preserving audio: {error}");
                emit_audio_frame(samples, audio_cb, stream_gate, out_buf);
            }
        }
    } else {
        emit_audio_frame(samples, audio_cb, stream_gate, out_buf);
    }
}

/// Callback invoked with each 16 kHz mono frame that passes the active capture
/// policy while recording. Used to feed a live streaming transcription as audio arrives.
pub type AudioFrameCallback = Arc<dyn Fn(&[f32]) + Send + Sync + 'static>;

pub struct AudioRecorder {
    device: Option<Device>,
    cmd_tx: Option<mpsc::Sender<Cmd>>,
    worker_handle: Option<std::thread::JoinHandle<()>>,
    vad: Option<VadConfig>,
    level_cb: Option<Arc<dyn Fn(Vec<f32>) + Send + Sync + 'static>>,
    audio_cb: Option<AudioFrameCallback>,
    /// Which input channel to use. None = average all (original behavior).
    selected_channel: Option<usize>,
    /// Preferred stream config cached per device name. The two HAL property
    /// queries in `get_preferred_config` cost ~40-85ms per open (worse on
    /// USB/Bluetooth), which lands on the keypress->capture path in on-demand
    /// mode. Keyed by name so a system-default change misses naturally;
    /// cleared whenever an open fails so a stale rate/format self-heals on the
    /// caller's retry.
    config_cache: Arc<Mutex<Option<(String, cpal::SupportedStreamConfig)>>>,
    /// Set by cpal when the active input stream can no longer capture.
    stream_error: Arc<AtomicBool>,
}

impl AudioRecorder {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        Ok(AudioRecorder {
            device: None,
            cmd_tx: None,
            worker_handle: None,
            vad: None,
            level_cb: None,
            audio_cb: None,
            selected_channel: None,
            config_cache: Arc::new(Mutex::new(None)),
            stream_error: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Attach a single VAD engine, reconfigured per session for the offline vs
    /// streaming hangover tail. The two policies are mutually exclusive within a
    /// recording, so one engine covers both instead of two resident instances.
    pub fn with_vad(
        mut self,
        detector: Box<dyn VoiceActivityDetector>,
        offline_hangover_frames: usize,
        streaming_hangover_frames: usize,
    ) -> Self {
        self.vad = Some(VadConfig {
            detector: Arc::new(Mutex::new(detector)),
            offline_hangover_frames,
            streaming_hangover_frames,
        });
        self
    }

    pub fn with_level_callback<F>(mut self, cb: F) -> Self
    where
        F: Fn(Vec<f32>) + Send + Sync + 'static,
    {
        self.level_cb = Some(Arc::new(cb));
        self
    }

    /// Register a callback that receives real-time 16 kHz frames after the active
    /// VAD policy has been applied. Frames arrive in real time, in order, on the
    /// recorder's consumer thread — keep the callback cheap (e.g. forward to a
    /// channel) so it never stalls capture.
    pub fn with_audio_callback<F>(mut self, cb: F) -> Self
    where
        F: Fn(&[f32]) + Send + Sync + 'static,
    {
        self.audio_cb = Some(Arc::new(cb));
        self
    }

    pub fn with_selected_channel(mut self, channel: Option<u16>) -> Self {
        self.set_selected_channel(channel);
        self
    }

    pub fn set_selected_channel(&mut self, channel: Option<u16>) {
        self.selected_channel = channel.map(usize::from);
    }

    pub fn open(&mut self, device: Option<Device>) -> Result<(), Box<dyn std::error::Error>> {
        if self.worker_handle.is_some() {
            if !self.needs_reopen() {
                return Ok(()); // already open
            }
            log::warn!("Capture stream failed; rebuilding microphone stream");
            let _ = self.close();
        }

        self.stream_error.store(false, Ordering::Relaxed);

        let (sample_tx, sample_rx) = mpsc::channel::<AudioChunk>();
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>();
        let (init_tx, init_rx) = mpsc::sync_channel::<Result<(), String>>(1);

        let host = crate::audio_toolkit::get_cpal_host();
        let device = match device {
            Some(dev) => dev,
            None => host
                .default_input_device()
                .ok_or_else(|| Error::new(std::io::ErrorKind::NotFound, "No input device found"))?,
        };

        let thread_device = device.clone();
        let vad = self.vad.clone();
        // Move the optional level callback into the worker thread
        let level_cb = self.level_cb.clone();
        // Move the optional real-time audio frame callback into the worker thread
        let audio_cb = self.audio_cb.clone();
        let selected_channel = self.selected_channel;
        let config_cache = Arc::clone(&self.config_cache);
        let stream_error = Arc::clone(&self.stream_error);

        let worker = std::thread::spawn(move || {
            let stop_flag = Arc::new(AtomicBool::new(false));
            let stop_flag_for_stream = stop_flag.clone();
            let init_result = (|| -> Result<(cpal::Stream, u32), String> {
                let config_started = Instant::now();
                let device_name = thread_device.name().unwrap_or_default();
                let cached_config = config_cache
                    .lock()
                    .unwrap()
                    .as_ref()
                    .filter(|(name, _)| !device_name.is_empty() && *name == device_name)
                    .map(|(_, cfg)| cfg.clone());
                let config_was_cached = cached_config.is_some();
                let config = match cached_config {
                    Some(cfg) => cfg,
                    None => AudioRecorder::get_preferred_config(&thread_device)
                        .map_err(|e| format!("Failed to fetch preferred config: {e}"))?,
                };
                let config_elapsed = config_started.elapsed();

                let sample_rate = config.sample_rate().0;
                let channels = config.channels() as usize;

                log::info!(
                    "Using device: {:?}\nSample rate: {}\nChannels: {}\nFormat: {:?}",
                    thread_device.name(),
                    sample_rate,
                    channels,
                    config.sample_format()
                );

                if let Some(channel) = selected_channel {
                    if channel < channels {
                        log::info!("Using selected input channel: {}", channel + 1);
                    } else {
                        log::warn!(
                            "Selected input channel {} is out of range for a {}-channel device; averaging all channels instead",
                            channel + 1,
                            channels
                        );
                    }
                } else {
                    log::info!("Averaging all {} input channels", channels);
                }

                let build_started = Instant::now();
                let stream = match config.sample_format() {
                    cpal::SampleFormat::U8 => AudioRecorder::build_stream::<u8>(
                        &thread_device,
                        &config,
                        sample_tx,
                        channels,
                        selected_channel,
                        stop_flag_for_stream,
                        Arc::clone(&stream_error),
                    )
                    .map_err(|e| format!("Failed to build input stream: {e}"))?,
                    cpal::SampleFormat::I8 => AudioRecorder::build_stream::<i8>(
                        &thread_device,
                        &config,
                        sample_tx,
                        channels,
                        selected_channel,
                        stop_flag_for_stream,
                        Arc::clone(&stream_error),
                    )
                    .map_err(|e| format!("Failed to build input stream: {e}"))?,
                    cpal::SampleFormat::I16 => AudioRecorder::build_stream::<i16>(
                        &thread_device,
                        &config,
                        sample_tx,
                        channels,
                        selected_channel,
                        stop_flag_for_stream,
                        Arc::clone(&stream_error),
                    )
                    .map_err(|e| format!("Failed to build input stream: {e}"))?,
                    cpal::SampleFormat::I32 => AudioRecorder::build_stream::<i32>(
                        &thread_device,
                        &config,
                        sample_tx,
                        channels,
                        selected_channel,
                        stop_flag_for_stream,
                        Arc::clone(&stream_error),
                    )
                    .map_err(|e| format!("Failed to build input stream: {e}"))?,
                    cpal::SampleFormat::F32 => AudioRecorder::build_stream::<f32>(
                        &thread_device,
                        &config,
                        sample_tx,
                        channels,
                        selected_channel,
                        stop_flag_for_stream,
                        Arc::clone(&stream_error),
                    )
                    .map_err(|e| format!("Failed to build input stream: {e}"))?,
                    sample_format => {
                        return Err(format!("Unsupported sample format: {sample_format:?}"));
                    }
                };
                let build_elapsed = build_started.elapsed();

                let play_started = Instant::now();
                stream
                    .play()
                    .map_err(|e| format!("Failed to start microphone stream: {e}"))?;
                log::debug!(
                    "mic worker init: fetch_config={:?} (cached={}) build_stream={:?} play={:?}",
                    config_elapsed,
                    config_was_cached,
                    build_elapsed,
                    play_started.elapsed()
                );

                // The device accepted this config; remember it so the next
                // open skips the HAL property queries entirely.
                if !config_was_cached && !device_name.is_empty() {
                    *config_cache.lock().unwrap() = Some((device_name, config));
                }

                Ok((stream, sample_rate))
            })();

            match init_result {
                Ok((stream, sample_rate)) => {
                    let _ = init_tx.send(Ok(()));
                    // Timestamp for the play()-returned -> first-samples gap the
                    // init handshake can't see (hardware dependent).
                    let stream_running_at = Instant::now();
                    // Keep the stream alive while we process samples.
                    run_consumer(
                        sample_rate,
                        vad,
                        sample_rx,
                        cmd_rx,
                        level_cb,
                        audio_cb,
                        stop_flag,
                        stream_running_at,
                    );
                    drop(stream);
                }
                Err(error_message) => {
                    // A failed open may mean the cached config went stale
                    // (device re-plugged, rate/format changed in the OS).
                    // Drop it so the next attempt re-queries the device.
                    *config_cache.lock().unwrap() = None;
                    log::error!("{error_message}");
                    let _ = init_tx.send(Err(error_message));
                }
            }
        });

        match init_rx.recv() {
            Ok(Ok(())) => {
                self.device = Some(device);
                self.cmd_tx = Some(cmd_tx);
                self.worker_handle = Some(worker);
                Ok(())
            }
            Ok(Err(error_message)) => {
                let _ = worker.join();
                let kind = if is_microphone_access_denied(&error_message) {
                    std::io::ErrorKind::PermissionDenied
                } else {
                    std::io::ErrorKind::Other
                };
                Err(Box::new(Error::new(kind, error_message)))
            }
            Err(recv_error) => {
                let _ = worker.join();
                Err(Box::new(Error::other(format!(
                    "Failed to initialize microphone worker: {recv_error}"
                ))))
            }
        }
    }

    /// Queue a recording start and return a one-shot receiver that resolves only
    /// after the first real microphone sample chunk has entered the capture path.
    /// `Stream::play()` returning is not sufficient: some Bluetooth and USB
    /// devices take much longer to begin delivering callbacks.
    pub fn start(
        &self,
        vad_policy: VadPolicy,
    ) -> Result<mpsc::Receiver<()>, Box<dyn std::error::Error>> {
        let tx = self
            .cmd_tx
            .as_ref()
            .ok_or_else(|| Error::other("Recorder is not open"))?;
        let (ready_tx, ready_rx) = mpsc::channel();
        tx.send(Cmd::Start(vad_policy, Instant::now(), ready_tx))?;
        Ok(ready_rx)
    }

    pub fn stop(&self) -> Result<CapturedAudio, Box<dyn std::error::Error>> {
        let (resp_tx, resp_rx) = mpsc::channel();
        if let Some(tx) = &self.cmd_tx {
            tx.send(Cmd::Stop(resp_tx))?;
        }
        Ok(resp_rx.recv()?) // wait for the samples
    }

    /// True when the active capture stream must be rebuilt.
    ///
    /// cpal may report a device disconnect asynchronously without closing its
    /// callback channel, so also honor the error callback's explicit flag.
    pub fn needs_reopen(&self) -> bool {
        self.stream_error.load(Ordering::Relaxed)
            || self
                .worker_handle
                .as_ref()
                .is_some_and(|handle| handle.is_finished())
    }

    pub fn close(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(tx) = self.cmd_tx.take() {
            let _ = tx.send(Cmd::Shutdown);
        }
        if let Some(h) = self.worker_handle.take() {
            let _ = h.join();
        }
        self.device = None;
        Ok(())
    }

    fn build_stream<T>(
        device: &cpal::Device,
        config: &cpal::SupportedStreamConfig,
        sample_tx: mpsc::Sender<AudioChunk>,
        channels: usize,
        selected_channel: Option<usize>,
        stop_flag: Arc<AtomicBool>,
        stream_error: Arc<AtomicBool>,
    ) -> Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: Sample + SizedSample + Send + 'static,
        f32: cpal::FromSample<T>,
    {
        let mut output_buffer = Vec::new();
        let mut eos_sent = false;
        // Resolve the effective channel to use. If the selected channel is
        // out of range for this device, fall back to averaging all channels.
        let use_channel: Option<usize> = match selected_channel {
            Some(ch) if ch < channels => Some(ch),
            Some(_) => None, // out of range, fall back to average
            None => None,    // user chose "average all"
        };

        let stream_cb = move |data: &[T], _: &cpal::InputCallbackInfo| {
            handle_input_block(
                data,
                channels,
                use_channel,
                &stop_flag,
                &mut eos_sent,
                &mut output_buffer,
                &sample_tx,
            );
        };

        device.build_input_stream(
            &config.clone().into(),
            stream_cb,
            move |err| {
                log::error!("Stream error: {}", err);
                stream_error.store(true, Ordering::Relaxed);
            },
            None,
        )
    }

    pub fn preferred_input_channel_count(
        device: &cpal::Device,
    ) -> Result<u16, Box<dyn std::error::Error>> {
        Ok(Self::get_preferred_config(device)?.channels())
    }

    fn get_preferred_config(
        device: &cpal::Device,
    ) -> Result<cpal::SupportedStreamConfig, Box<dyn std::error::Error>> {
        // Use the device's native/default sample rate and let the FrameResampler
        // in run_consumer() downsample to 16kHz. This avoids forcing hardware into
        // a non-native rate which can cause issues on some devices (Bluetooth
        // codecs, certain ALSA drivers, etc.).
        let default_config = device.default_input_config()?;
        let target_rate = default_config.sample_rate();

        // Try to find the best sample format at the device's default rate
        let supported_configs = match device.supported_input_configs() {
            Ok(configs) => configs,
            Err(e) => {
                log::warn!("Could not enumerate input configs ({e}), using device default");
                return Ok(default_config);
            }
        };
        let mut best_config: Option<cpal::SupportedStreamConfigRange> = None;

        for config_range in supported_configs {
            if config_range.min_sample_rate() <= target_rate
                && config_range.max_sample_rate() >= target_rate
            {
                match best_config {
                    None => best_config = Some(config_range),
                    Some(ref current) => {
                        // Prioritize F32 > I16 > I32 > others
                        let score = |fmt: cpal::SampleFormat| match fmt {
                            cpal::SampleFormat::F32 => 4,
                            cpal::SampleFormat::I16 => 3,
                            cpal::SampleFormat::I32 => 2,
                            _ => 1,
                        };

                        if score(config_range.sample_format()) > score(current.sample_format()) {
                            best_config = Some(config_range);
                        }
                    }
                }
            }
        }

        if let Some(config) = best_config {
            return Ok(config.with_sample_rate(target_rate));
        }

        // Fall back to device default if no config matched (exotic/virtual devices)
        log::warn!(
            "No supported config matched device default rate {:?}, using default config",
            target_rate
        );
        Ok(default_config)
    }
}

/// Body of the cpal input callback, extracted for testing without a device.
/// Converts the block to mono and forwards it. The block that first observes
/// the stop flag was captured before the stop, so it is still forwarded —
/// dropping it loses up to a callback period of tail audio (worst on
/// Bluetooth) — followed by the end-of-stream sentinel; later blocks are
/// dropped until the flag clears.
fn handle_input_block<T>(
    data: &[T],
    channels: usize,
    use_channel: Option<usize>,
    stop_flag: &AtomicBool,
    eos_sent: &mut bool,
    output_buffer: &mut Vec<f32>,
    sample_tx: &mpsc::Sender<AudioChunk>,
) where
    T: Sample,
    f32: cpal::FromSample<T>,
{
    let stopping = stop_flag.load(Ordering::Relaxed);
    if stopping && *eos_sent {
        return;
    }

    output_buffer.clear();

    if channels == 1 {
        output_buffer.extend(data.iter().map(|&sample| sample.to_sample::<f32>()));
    } else {
        let frame_count = data.len() / channels;
        output_buffer.reserve(frame_count);

        if let Some(ch) = use_channel {
            for frame in data.chunks_exact(channels) {
                let mono_sample = frame[ch].to_sample::<f32>();
                output_buffer.push(mono_sample);
            }
        } else {
            for frame in data.chunks_exact(channels) {
                let mono_sample = frame
                    .iter()
                    .map(|&sample| sample.to_sample::<f32>())
                    .sum::<f32>()
                    / channels as f32;
                output_buffer.push(mono_sample);
            }
        }
    }

    // A failed send means the consumer thread is gone. During shutdown that is
    // expected (the consumer exits before the stream is dropped), so only
    // report it when capture was supposed to be live.
    if sample_tx
        .send(AudioChunk::Samples(output_buffer.clone()))
        .is_err()
        && !stopping
    {
        log::error!("Failed to send samples");
    }

    if stopping {
        let _ = sample_tx.send(AudioChunk::EndOfStream);
        *eos_sent = true;
    } else {
        *eos_sent = false;
    }
}

pub fn is_microphone_access_denied(error_message: &str) -> bool {
    let normalized = error_message.to_lowercase();
    normalized.contains("access is denied")
        || normalized.contains("permission denied")
        || normalized.contains("0x80070005")
}

pub fn is_no_input_device_error(error_message: &str) -> bool {
    let normalized = error_message.to_lowercase();
    normalized.contains("no input device found")
        || (normalized.contains("failed to fetch preferred config")
            && normalized.contains("coreaudio"))
}

#[cfg(test)]
mod tests {
    use super::{
        handle_input_block, is_microphone_access_denied, is_no_input_device_error, process_frame,
        run_consumer, AudioChunk, AudioFrameCallback, AudioRecorder, CaptureEvidenceAccumulator,
        Cmd, StreamCallbackGate, VadConfig, VadPolicy,
    };
    use crate::audio_toolkit::vad::{
        SmoothedVad, VadActivityReport, VadFrame, VoiceActivityDetector,
    };
    use anyhow::Result;
    use std::collections::VecDeque;
    use std::{
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc, Mutex,
        },
        thread,
        time::{Duration, Instant},
    };

    struct ScriptedVad {
        decisions: VecDeque<bool>,
    }

    impl VoiceActivityDetector for ScriptedVad {
        fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>> {
            if self.decisions.pop_front().unwrap_or(false) {
                Ok(VadFrame::Speech(frame))
            } else {
                Ok(VadFrame::Noise)
            }
        }
    }

    #[test]
    fn unopened_recorder_does_not_need_reopen() {
        // No worker has been spawned yet, so there is nothing to reap. Guards
        // against inverting the "no worker" case, which would make every first
        // open() take the rebuild path.
        let recorder = AudioRecorder::new().expect("recorder");
        assert!(!recorder.needs_reopen());
    }

    #[test]
    fn stream_error_requires_reopen() {
        let recorder = AudioRecorder::new().expect("recorder");
        recorder.stream_error.store(true, Ordering::Relaxed);
        assert!(recorder.needs_reopen());
    }

    #[test]
    fn shutdown_is_processed_without_audio_samples() {
        let (sample_tx, sample_rx) = mpsc::channel();
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            run_consumer(
                48_000,
                None,
                sample_rx,
                cmd_rx,
                None,
                None,
                Arc::new(AtomicBool::new(false)),
                Instant::now(),
            );
            let _ = done_tx.send(());
        });

        cmd_tx.send(Cmd::Shutdown).expect("send shutdown");
        let stopped = done_rx.recv_timeout(Duration::from_secs(1));

        // Unblock the old implementation so a failing test still exits cleanly.
        drop(sample_tx);
        worker.join().expect("join consumer");
        assert!(stopped.is_ok(), "shutdown waited for an audio sample");
    }

    #[test]
    fn boundary_block_forwarded_before_eos() {
        let (tx, rx) = mpsc::channel();
        let stop_flag = AtomicBool::new(false);
        let mut eos_sent = false;
        let mut scratch = Vec::new();
        let mut push = |flag: &AtomicBool, eos: &mut bool, block: &[f32]| {
            handle_input_block::<f32>(block, 1, None, flag, eos, &mut scratch, &tx)
        };

        // Running: blocks forwarded, no sentinel.
        push(&stop_flag, &mut eos_sent, &[0.1]);
        assert!(matches!(rx.try_recv(), Ok(AudioChunk::Samples(_))));
        assert!(rx.try_recv().is_err());

        // The block observing the stop flag is still forwarded, then EOS.
        stop_flag.store(true, Ordering::Relaxed);
        push(&stop_flag, &mut eos_sent, &[0.5, 0.5]);
        match rx.try_recv() {
            Ok(AudioChunk::Samples(samples)) => assert_eq!(samples, vec![0.5, 0.5]),
            _ => panic!("boundary block must be forwarded, not dropped"),
        }
        assert!(matches!(rx.try_recv(), Ok(AudioChunk::EndOfStream)));

        // Later blocks are dropped until the flag clears, then capture resumes.
        push(&stop_flag, &mut eos_sent, &[0.9]);
        assert!(rx.try_recv().is_err(), "blocks after EOS must be dropped");
        stop_flag.store(false, Ordering::Relaxed);
        push(&stop_flag, &mut eos_sent, &[0.2]);
        assert!(matches!(rx.try_recv(), Ok(AudioChunk::Samples(_))));
        assert!(rx.try_recv().is_err(), "no sentinel while running");
    }

    #[test]
    fn disabled_filter_still_collects_raw_vad_evidence() {
        let smoothed = SmoothedVad::new(
            Box::new(ScriptedVad {
                decisions: [true, true].into_iter().collect(),
            }),
            3,
            2,
            2,
        );
        let vad = Some(VadConfig {
            detector: Arc::new(Mutex::new(Box::new(smoothed))),
            offline_hangover_frames: 2,
            streaming_hangover_frames: 4,
        });
        let mut accumulator = CaptureEvidenceAccumulator::new(16_000);
        let mut stream_gate = StreamCallbackGate::new();
        let mut output = Vec::new();
        for amplitude in [0.02, 0.03] {
            let mut frame = vec![amplitude; 480];
            accumulator.observe_and_sanitize(&mut frame);
            process_frame(
                &frame,
                true,
                VadPolicy::Disabled,
                &vad,
                &None,
                &mut stream_gate,
                &mut output,
                &mut accumulator,
            );
        }

        let activity = vad
            .as_ref()
            .unwrap()
            .detector
            .lock()
            .unwrap()
            .activity_report();
        let evidence = accumulator.snapshot(output.len(), activity);
        assert_eq!(output.len(), 960, "disabled means unfiltered output");
        assert_eq!(evidence.vad_analyzed_frames, 2);
        assert_eq!(evidence.vad_voiced_frames, 2);
        assert_eq!(evidence.vad_confirmed_speech_onsets, 1);
        assert_eq!(evidence.vad_onset_frames, 2);
        assert_eq!(evidence.vad_longest_voiced_run_frames, 2);
        assert_eq!(evidence.vad_latest_confirmed_run_frames, 2);
        assert_eq!(evidence.vad_last_voiced_frame, Some(2));
        assert_eq!(evidence.vad_last_confirmed_speech_frame, Some(2));
        assert_eq!(evidence.vad_hangover_frames, 2);
        assert_eq!(evidence.vad_error_frames, 0);
    }

    #[test]
    fn streaming_callback_is_withheld_until_two_frame_speech_onset() {
        let smoothed = SmoothedVad::new(
            Box::new(ScriptedVad {
                decisions: [false, false, true, true].into_iter().collect(),
            }),
            3,
            2,
            2,
        );
        let vad = Some(VadConfig {
            detector: Arc::new(Mutex::new(Box::new(smoothed))),
            offline_hangover_frames: 2,
            streaming_hangover_frames: 4,
        });
        let received = Arc::new(Mutex::new(Vec::new()));
        let callback: Option<AudioFrameCallback> = Some({
            let received = Arc::clone(&received);
            Arc::new(move |samples| {
                received.lock().unwrap().extend_from_slice(samples);
            })
        });
        let mut accumulator = CaptureEvidenceAccumulator::new(16_000);
        let mut stream_gate = StreamCallbackGate::new();
        let mut output = Vec::new();

        for index in 0..4 {
            let frame = vec![0.02 + index as f32 * 0.01; 480];
            process_frame(
                &frame,
                true,
                VadPolicy::Disabled,
                &vad,
                &callback,
                &mut stream_gate,
                &mut output,
                &mut accumulator,
            );
            if index < 3 {
                assert!(
                    received.lock().unwrap().is_empty(),
                    "provider received audio before confirmed speech"
                );
            }
        }

        assert_eq!(output.len(), 4 * 480, "batch output remains unfiltered");
        assert_eq!(received.lock().unwrap().len(), 4 * 480);
    }

    #[test]
    fn missing_vad_withholds_streaming_but_preserves_batch_audio() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let callback: Option<AudioFrameCallback> = Some({
            let received = Arc::clone(&received);
            Arc::new(move |samples| {
                received.lock().unwrap().extend_from_slice(samples);
            })
        });
        let mut accumulator = CaptureEvidenceAccumulator::new(16_000);
        let mut stream_gate = StreamCallbackGate::new();
        let mut output = Vec::new();
        let frame = vec![0.03; 480];

        process_frame(
            &frame,
            true,
            VadPolicy::Streaming,
            &None,
            &callback,
            &mut stream_gate,
            &mut output,
            &mut accumulator,
        );

        assert_eq!(output, frame);
        assert!(received.lock().unwrap().is_empty());
    }

    #[test]
    fn evidence_counts_and_sanitizes_non_finite_samples() {
        let mut samples = vec![0.0, 0.25, f32::NAN, f32::INFINITY, -0.5];
        let mut accumulator = CaptureEvidenceAccumulator::new(1_000);
        accumulator.observe_and_sanitize(&mut samples);
        let evidence = accumulator.snapshot(0, Some(VadActivityReport::default()));

        assert_eq!(samples, vec![0.0, 0.25, 0.0, 0.0, -0.5]);
        assert_eq!(evidence.raw_sample_count, 5);
        assert_eq!(evidence.non_finite_samples, 2);
        assert_eq!(evidence.exact_zero_samples, 1);
        assert_eq!(evidence.peak_amplitude, 0.5);
        assert_eq!(evidence.raw_duration_ms, 5);
    }

    #[test]
    fn detects_access_is_denied() {
        assert!(is_microphone_access_denied("Access is denied"));
    }

    #[test]
    fn detects_permission_denied() {
        assert!(is_microphone_access_denied("permission denied"));
    }

    #[test]
    fn detects_windows_error_code() {
        assert!(is_microphone_access_denied("WASAPI error: 0x80070005"));
    }

    #[test]
    fn does_not_match_unrelated_errors() {
        assert!(!is_microphone_access_denied("device not found"));
    }

    #[test]
    fn detects_no_input_device() {
        assert!(is_no_input_device_error("No input device found"));
    }

    #[test]
    fn detects_coreaudio_config_error() {
        assert!(is_no_input_device_error(
            "Failed to fetch preferred config: A backend-specific error has occurred: An unknown error unknown to the coreaudio-rs API occurred"
        ));
    }

    #[test]
    fn does_not_match_other_errors_for_no_device() {
        assert!(!is_no_input_device_error("permission denied"));
        assert!(!is_no_input_device_error("device not found"));
    }
}

#[allow(clippy::too_many_arguments)]
fn run_consumer(
    in_sample_rate: u32,
    vad: Option<VadConfig>,
    sample_rx: mpsc::Receiver<AudioChunk>,
    cmd_rx: mpsc::Receiver<Cmd>,
    level_cb: Option<Arc<dyn Fn(Vec<f32>) + Send + Sync + 'static>>,
    audio_cb: Option<AudioFrameCallback>,
    stop_flag: Arc<AtomicBool>,
    stream_running_at: Instant,
) {
    let mut frame_resampler = FrameResampler::new(
        in_sample_rate as usize,
        constants::WHISPER_SAMPLE_RATE as usize,
        Duration::from_millis(30),
    );

    let mut processed_samples = Vec::<f32>::new();
    let mut evidence = CaptureEvidenceAccumulator::new(in_sample_rate);
    let mut stream_gate = StreamCallbackGate::new();
    let mut recording = false;
    let mut vad_policy = VadPolicy::Offline;

    // ---------- latency instrumentation ---------------------------------- //
    // First-chunk arrival exposes the play()->samples-flowing gap; the
    // first-captured log confirms capture begins with the chunk in flight
    // when Cmd::Start lands.
    let mut first_chunk_logged = false;
    let mut awaiting_first_captured_chunk: Option<Instant> = None;
    let mut capture_ready_tx: Option<mpsc::Sender<()>> = None;

    // ---------- spectrum visualisation setup ---------------------------- //
    const BUCKETS: usize = 16;
    // Scale the FFT window to the device sample rate so the analysis window
    // (~33 ms) and frequency resolution (~30 Hz/bin) stay roughly constant
    // across devices. A fixed 512-sample window collapses the low vocal
    // buckets onto a single bin at 48 kHz (e.g. built-in laptop mics), and
    // would stutter at ~4-8 updates/sec on an 8-16 kHz Bluetooth headset.
    // Targets: 48 kHz -> 2048, 16 kHz -> 512, 8 kHz -> 256.
    let target_window = (f64::from(in_sample_rate) / 30.0).round() as usize;
    let window_size = [256usize, 512, 1024, 2048]
        .into_iter()
        .min_by_key(|w| w.abs_diff(target_window))
        .unwrap();
    let mut visualizer = AudioVisualiser::new(
        in_sample_rate,
        window_size,
        BUCKETS,
        400.0,  // vocal_min_hz
        4000.0, // vocal_max_hz
    );

    // Poll commands even when a disconnected device stops producing samples
    // without closing its CoreAudio stream.
    loop {
        let mut pending = match sample_rx.recv_timeout(Duration::from_millis(50)) {
            Ok(chunk) => Some(chunk),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };

        // Handle pending commands BEFORE the in-flight chunk so a Start
        // captures it. Commands used to be polled after processing, which
        // silently dropped one buffer period of audio (~10ms built-in, up to
        // ~100ms on Bluetooth) at every recording start.
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                Cmd::Start(policy, sent_at, ready_tx) => {
                    log::debug!(
                        "Cmd::Start processed {:?} after send; capture begins with {} chunk",
                        sent_at.elapsed(),
                        if pending.is_some() {
                            "the in-flight"
                        } else {
                            "the next available"
                        }
                    );
                    awaiting_first_captured_chunk = Some(Instant::now());
                    capture_ready_tx = Some(ready_tx);
                    stop_flag.store(false, Ordering::Relaxed);
                    vad_policy = policy;
                    processed_samples.clear();
                    evidence.reset();
                    stream_gate.reset();
                    recording = true;
                    visualizer.reset();
                    frame_resampler.reset();
                    // Reconfigure and reset even when filtering is disabled:
                    // VAD remains an observer for provider-independent evidence.
                    if let Some(cfg) = &vad {
                        let mut det = cfg.detector.lock().unwrap();
                        det.set_hangover_frames(cfg.hangover_for(vad_policy));
                        det.reset();
                    }
                }
                Cmd::Stop(reply_tx) => {
                    recording = false;
                    // If Stop was queued before the first chunk, dropping this
                    // sender prevents a stale ready UI event or start chime.
                    capture_ready_tx = None;
                    awaiting_first_captured_chunk = None;
                    stop_flag.store(true, Ordering::Relaxed);

                    // The chunk in hand arrived before the stop; it belongs to
                    // the recording, so feed it ahead of the drain below.
                    if let Some(AudioChunk::Samples(mut raw)) = pending.take() {
                        evidence.observe_and_sanitize(&mut raw);
                        frame_resampler.push(&raw, &mut |frame: &[f32]| {
                            process_frame(
                                frame,
                                true,
                                vad_policy,
                                &vad,
                                &audio_cb,
                                &mut stream_gate,
                                &mut processed_samples,
                                &mut evidence,
                            )
                        });
                    }

                    // Drain all remaining audio until the producer confirms end-of-stream.
                    // The cpal callback sees the stop flag, sends EndOfStream, and goes
                    // silent — guaranteeing every captured sample is in the channel
                    // ahead of the sentinel.
                    loop {
                        match sample_rx.recv_timeout(Duration::from_secs(2)) {
                            Ok(AudioChunk::Samples(mut remaining)) => {
                                evidence.observe_and_sanitize(&mut remaining);
                                frame_resampler.push(&remaining, &mut |frame: &[f32]| {
                                    process_frame(
                                        frame,
                                        true,
                                        vad_policy,
                                        &vad,
                                        &audio_cb,
                                        &mut stream_gate,
                                        &mut processed_samples,
                                        &mut evidence,
                                    )
                                });
                            }
                            Ok(AudioChunk::EndOfStream) => break,
                            Err(_) => {
                                log::warn!("Timed out waiting for EndOfStream from audio callback");
                                break;
                            }
                        }
                    }

                    frame_resampler.finish(&mut |frame: &[f32]| {
                        process_frame(
                            frame,
                            true,
                            vad_policy,
                            &vad,
                            &audio_cb,
                            &mut stream_gate,
                            &mut processed_samples,
                            &mut evidence,
                        )
                    });

                    // Diagnostic only: evidence for whether the VAD was
                    // still withholding tail audio when capture stopped.
                    // Suggestive, not conclusive, in either direction.
                    let activity = if let Some(cfg) = &vad {
                        let detector = cfg.detector.lock().unwrap();
                        if vad_policy != VadPolicy::Disabled {
                            if let Some(report) = detector.tail_report() {
                                log::debug!(
                                    "VAD at stop: withheld tail {} frames (~{}ms, {} voiced), in_speech={}, onset_counter={}, hangover_counter={}",
                                    report.withheld_frames,
                                    report.withheld_frames * 30,
                                    report.withheld_voiced_frames,
                                    report.in_speech,
                                    report.onset_counter,
                                    report.hangover_counter
                                );
                            }
                        }
                        detector.activity_report()
                    } else {
                        None
                    };

                    let capture_evidence = evidence.snapshot(processed_samples.len(), activity);
                    let captured = CapturedAudio::new(
                        std::mem::take(&mut processed_samples),
                        capture_evidence,
                    );
                    let _ = reply_tx.send(captured);

                    // Resume the audio callback so the consumer loop can continue
                    // receiving chunks (important for always-on microphone mode).
                    stop_flag.store(false, Ordering::Relaxed);
                }
                Cmd::Shutdown => {
                    stop_flag.store(true, Ordering::Relaxed);
                    return;
                }
            }
        }

        let mut raw = match pending.take() {
            Some(AudioChunk::Samples(s)) => s,
            // EndOfStream, or the chunk was consumed by a Stop above.
            _ => continue,
        };

        let chunk_ms = raw.len() as f64 * 1000.0 / in_sample_rate as f64;
        if !first_chunk_logged {
            first_chunk_logged = true;
            log::debug!(
                "first audio chunk arrived {:?} after stream start ({:.1}ms of audio)",
                stream_running_at.elapsed(),
                chunk_ms
            );
        }

        // ---------- recording-time processing ---------------------------- //
        // In always-on mode the capture stream stays open continuously for
        // zero-latency start, so while idle (not recording) there is nothing to
        // do with a chunk: handle_frame returns early when not recording, which
        // means the resampled output would be discarded, and the level meter has
        // no idle consumer. Skip both the level-meter FFT and the resampler while
        // idle to avoid doing unnecessary work whose output is thrown away. Both
        // are reset on Cmd::Start (visualizer.reset() / frame_resampler.reset()),
        // so they resume cleanly the moment recording begins.
        if recording {
            evidence.observe_and_sanitize(&mut raw);
            if let Some(buckets) = visualizer.feed(&raw) {
                if let Some(cb) = &level_cb {
                    cb(buckets);
                }
            }

            frame_resampler.push(&raw, &mut |frame: &[f32]| {
                process_frame(
                    frame,
                    recording,
                    vad_policy,
                    &vad,
                    &audio_cb,
                    &mut stream_gate,
                    &mut processed_samples,
                    &mut evidence,
                )
            });
        }

        if recording {
            if let Some(started) = awaiting_first_captured_chunk.take() {
                log::debug!(
                    "first captured chunk ({:.1}ms of audio) processed {:?} after Cmd::Start",
                    chunk_ms,
                    started.elapsed()
                );
            }
            if let Some(ready_tx) = capture_ready_tx.take() {
                // Signal only after this chunk has passed through the visualizer
                // and resampler. Silence still counts: readiness means the host
                // is delivering samples, not that VAD has detected speech.
                let _ = ready_tx.send(());
            }
        }
    }
}

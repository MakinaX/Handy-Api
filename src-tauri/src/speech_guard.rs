//! Provider-independent speech-presence and hallucination guard.
//!
//! The recorder owns measurement and populates [`CaptureEvidence`].  This
//! module deliberately contains only pure decisions so Local and cloud
//! transcription paths can share the exact same policy without depending on a
//! model registry or network client.

/// Capture measurements taken before VAD filtering or short-audio padding.
///
/// Amplitudes use cpal's normalized `f32` full scale (`-1.0..=1.0`).  Raw
/// duration is based on the microphone's native mono sample count/rate, while
/// `output_sample_count` is the 16 kHz PCM retained by the capture policy.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CaptureEvidence {
    pub raw_sample_count: usize,
    pub raw_sample_rate_hz: u32,
    pub raw_duration_ms: u64,
    pub peak_amplitude: f32,
    pub rms_amplitude: f32,
    pub exact_zero_samples: usize,
    pub non_finite_samples: usize,
    pub output_sample_count: usize,
    pub vad_analyzed_frames: usize,
    pub vad_voiced_frames: usize,
    pub vad_confirmed_speech_onsets: usize,
    pub vad_onset_frames: usize,
    pub vad_longest_voiced_run_frames: usize,
    pub vad_latest_confirmed_run_frames: usize,
    /// One-based raw VAD frame index.
    pub vad_last_voiced_frame: Option<usize>,
    /// One-based raw VAD frame index for the most recent confirmed run.
    pub vad_last_confirmed_speech_frame: Option<usize>,
    pub vad_hangover_frames: usize,
    pub vad_probability_frames: usize,
    pub vad_mean_probability: Option<f32>,
    pub vad_max_probability: Option<f32>,
    pub vad_probability_threshold: Option<f32>,
    pub vad_error_frames: usize,
}

impl CaptureEvidence {
    pub fn empty(raw_sample_rate_hz: u32) -> Self {
        Self {
            raw_sample_count: 0,
            raw_sample_rate_hz,
            raw_duration_ms: 0,
            peak_amplitude: 0.0,
            rms_amplitude: 0.0,
            exact_zero_samples: 0,
            non_finite_samples: 0,
            output_sample_count: 0,
            vad_analyzed_frames: 0,
            vad_voiced_frames: 0,
            vad_confirmed_speech_onsets: 0,
            vad_onset_frames: 0,
            vad_longest_voiced_run_frames: 0,
            vad_latest_confirmed_run_frames: 0,
            vad_last_voiced_frame: None,
            vad_last_confirmed_speech_frame: None,
            vad_hangover_frames: 0,
            vad_probability_frames: 0,
            vad_mean_probability: None,
            vad_max_probability: None,
            vad_probability_threshold: None,
            vad_error_frames: 0,
        }
    }

    pub fn finite_sample_count(&self) -> usize {
        self.raw_sample_count
            .saturating_sub(self.non_finite_samples)
    }

    pub fn exact_zero_ratio(&self) -> f32 {
        let finite = self.finite_sample_count();
        if finite == 0 {
            0.0
        } else {
            self.exact_zero_samples.min(finite) as f32 / finite as f32
        }
    }

    pub fn vad_voiced_ratio(&self) -> f32 {
        if self.vad_analyzed_frames == 0 {
            0.0
        } else {
            self.vad_voiced_frames.min(self.vad_analyzed_frames) as f32
                / self.vad_analyzed_frames as f32
        }
    }

    pub fn vad_frames_since_last_voice(&self) -> Option<usize> {
        frames_since(self.vad_analyzed_frames, self.vad_last_voiced_frame)
    }

    pub fn vad_frames_since_last_confirmed_speech(&self) -> Option<usize> {
        frames_since(
            self.vad_analyzed_frames,
            self.vad_last_confirmed_speech_frame,
        )
    }

    pub fn crest_factor(&self) -> f32 {
        if self.rms_amplitude <= f32::EPSILON {
            0.0
        } else {
            self.peak_amplitude / self.rms_amplitude
        }
    }

    /// Whether the last confirmed raw-VAD run reaches the capture tail. The
    /// window is the detector's already-configured hangover, not a second
    /// independently tuned time threshold. The existing two-frame onset stays
    /// sufficient at the capture tail so quiet acknowledgements are not given
    /// a new, uncalibrated three-frame requirement.
    pub fn vad_has_recent_confirmed_tail(&self) -> bool {
        if self.vad_onset_frames == 0 || self.vad_hangover_frames == 0 {
            return false;
        }

        let confirmed_tail_is_recent = self
            .vad_frames_since_last_confirmed_speech()
            .is_some_and(|frames| frames <= self.vad_hangover_frames);
        self.vad_latest_confirmed_run_frames >= self.vad_onset_frames && confirmed_tail_is_recent
    }

    /// Minimum whole-capture voiced density used for stale speech evidence.
    /// This is derived from the active VAD onset/hangover contract: at least
    /// `onset_frames / hangover_frames` of analyzed frames must be raw-positive.
    pub fn vad_required_density(&self) -> Option<f32> {
        (self.vad_hangover_frames > 0 && self.vad_onset_frames > 0)
            .then(|| self.vad_onset_frames as f32 / self.vad_hangover_frames as f32)
    }

    pub fn vad_has_sustained_density(&self) -> bool {
        if self.vad_analyzed_frames == 0
            || self.vad_onset_frames == 0
            || self.vad_hangover_frames == 0
            || self.vad_longest_voiced_run_frames <= self.vad_onset_frames
        {
            return false;
        }

        (self.vad_voiced_frames as u128 * self.vad_hangover_frames as u128)
            >= (self.vad_analyzed_frames as u128 * self.vad_onset_frames as u128)
    }
}

fn frames_since(analyzed_frames: usize, one_based_frame: Option<usize>) -> Option<usize> {
    one_based_frame
        .filter(|frame| *frame > 0 && *frame <= analyzed_frames)
        .map(|frame| analyzed_frames - frame)
}

/// Audio returned from a completed recorder session.
///
/// `samples` may be padded later by `AudioRecordingManager` for compatibility
/// with short-input inference engines.  Evidence always describes the real
/// capture and `output_sample_count` therefore remains the pre-padding count.
#[derive(Clone, Debug, PartialEq)]
pub struct CapturedAudio {
    pub samples: Vec<f32>,
    pub evidence: CaptureEvidence,
}

impl CapturedAudio {
    pub fn new(samples: Vec<f32>, evidence: CaptureEvidence) -> Self {
        Self { samples, evidence }
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    pub fn into_samples(self) -> Vec<f32> {
        self.samples
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpeechPresenceVerdict {
    /// Evidence strongly rules out meaningful speech; do not invoke any STT
    /// provider or create normal transcript side effects.
    NoSpeech,
    /// Evidence is inconclusive.  STT is allowed, but its output must pass the
    /// post-STT guard before paste/history side effects.
    Borderline,
    /// Capture contains positive speech evidence.
    Speech,
}

/// Optional evidence supplied by a transcription provider or an independently
/// updatable known-pattern matcher.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PostSttEvidence {
    /// Provider probability that the input contained no speech (`0.0..=1.0`).
    pub provider_no_speech_probability: Option<f32>,
    /// Provider confidence in the returned transcript (`0.0..=1.0`).
    pub provider_confidence: Option<f32>,
    /// `None` uses the small built-in pattern set.  `Some` lets an external,
    /// updatable matcher explicitly supply its result.
    pub known_hallucination_pattern: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TranscriptVerdict {
    Accept,
    RejectLikelyHallucination,
}

// Calibration notes:
// - Handy/Silero works on 30 ms frames. Two positive frames (60 ms) remain the
//   capture onset contract. A confirmed onset is no longer permanent proof for
//   the whole recording: an onset remains affirmative while it is inside the
//   existing tail window. Once stale, it needs both a run beyond the bare
//   onset and enough whole-capture voiced density. "Recent" and the density
//   floor reuse the session's existing VAD onset/hangover contract rather than
//   introducing an independently guessed time or ratio threshold.
// - PCM thresholds are dBFS-derived, not visualizer values.  0.006 RMS is
//   about -44.4 dBFS and separates the deterministic room/fan calibration
//   fixtures from deliberately quiet speech fixtures.  Energy alone never
//   rejects above this boundary.
// - 0.000_032 RMS is approximately -90 dBFS and is treated as electrical
//   near-silence even when exact-zero representation was lost in a driver.
// - A crest factor of 18 (~25 dB peak over RMS), together with zero successful
//   VAD voice decisions, identifies sparse keyboard/mouse impulses.  Crest
//   factor alone is never enough to reject captured speech.
const MIN_MEANINGFUL_CAPTURE_MS: u64 = 45;
const MIN_RELIABLE_VAD_FRAMES: usize = 3;
const ELECTRICAL_SILENCE_RMS: f32 = 0.000_032;
const ELECTRICAL_SILENCE_PEAK: f32 = 0.000_1;
const QUIET_NO_VOICE_RMS: f32 = 0.006;
const IMPULSE_NOISE_CREST_FACTOR: f32 = 18.0;

fn has_affirmative_confirmed_speech(evidence: &CaptureEvidence) -> bool {
    if evidence.vad_confirmed_speech_onsets == 0 || evidence.vad_onset_frames == 0 {
        return false;
    }

    evidence.vad_has_recent_confirmed_tail() || evidence.vad_has_sustained_density()
}

/// Pure pre-provider speech-presence decision.
pub fn pre_stt_verdict(evidence: &CaptureEvidence) -> SpeechPresenceVerdict {
    if evidence.raw_sample_count == 0 || evidence.raw_sample_rate_hz == 0 {
        return SpeechPresenceVerdict::NoSpeech;
    }

    let finite_samples = evidence.finite_sample_count();
    if finite_samples == 0 {
        return SpeechPresenceVerdict::NoSpeech;
    }

    let digital_silence =
        evidence.exact_zero_ratio() >= 0.999_9 && evidence.peak_amplitude <= f32::EPSILON;
    let electrical_silence = evidence.rms_amplitude <= ELECTRICAL_SILENCE_RMS
        && evidence.peak_amplitude <= ELECTRICAL_SILENCE_PEAK;
    if digital_silence || electrical_silence {
        return SpeechPresenceVerdict::NoSpeech;
    }

    // A confirmed onset is affirmative only while supported by duration or
    // recency. This preserves a short tail utterance without allowing one stale
    // two-frame noise blip to bless an arbitrarily long capture forever.
    if has_affirmative_confirmed_speech(evidence) {
        return SpeechPresenceVerdict::Speech;
    }

    // A sub-frame tap with neither a voice decision nor a detector failure
    // cannot contain the two-frame meaningful-speech contract.
    if evidence.raw_duration_ms < MIN_MEANINGFUL_CAPTURE_MS
        && evidence.vad_voiced_frames == 0
        && evidence.vad_error_frames == 0
    {
        return SpeechPresenceVerdict::NoSpeech;
    }

    // Detector failures are uncertainty, never negative evidence.  Likewise,
    // one voiced frame can be the leading edge of a clipped short utterance.
    if evidence.vad_error_frames > 0 || evidence.vad_voiced_frames == 1 {
        return SpeechPresenceVerdict::Borderline;
    }

    let reliable_zero_voice =
        evidence.vad_analyzed_frames >= MIN_RELIABLE_VAD_FRAMES && evidence.vad_voiced_frames == 0;
    if reliable_zero_voice {
        if evidence.output_sample_count == 0
            || evidence.rms_amplitude <= QUIET_NO_VOICE_RMS
            || evidence.crest_factor() >= IMPULSE_NOISE_CREST_FACTOR
        {
            return SpeechPresenceVerdict::NoSpeech;
        }
    }

    SpeechPresenceVerdict::Borderline
}

// Post-STT calibration is intentionally stricter than the provider's own
// defaults: >=0.80 no-speech or <=0.15 transcript confidence is a secondary
// signal only. Neither threshold, a transcript phrase, nor repetition can
// reject when capture has affirmative speech evidence.
const PROVIDER_NO_SPEECH_THRESHOLD: f32 = 0.80;
const PROVIDER_LOW_CONFIDENCE_THRESHOLD: f32 = 0.15;
const PROVIDER_SPEECH_PROBABILITY_THRESHOLD: f32 = 0.20;
const PROVIDER_HIGH_CONFIDENCE_THRESHOLD: f32 = 0.60;
/// Pure post-provider decision.  Lexical properties can reject only when the
/// independent capture evidence is weak; a legitimately dictated stock phrase
/// remains accepted whenever speech was observed.
pub fn post_stt_verdict(
    pre_stt: SpeechPresenceVerdict,
    capture: &CaptureEvidence,
    transcript: &str,
    post_stt: PostSttEvidence,
) -> TranscriptVerdict {
    if pre_stt == SpeechPresenceVerdict::NoSpeech || transcript.trim().is_empty() {
        return TranscriptVerdict::RejectLikelyHallucination;
    }

    if pre_stt == SpeechPresenceVerdict::Speech && has_affirmative_confirmed_speech(capture) {
        return TranscriptVerdict::Accept;
    }

    let provider_no_speech = post_stt
        .provider_no_speech_probability
        .is_some_and(|value| value.is_finite() && value >= PROVIDER_NO_SPEECH_THRESHOLD);
    let provider_low_confidence = post_stt
        .provider_confidence
        .is_some_and(|value| value.is_finite() && value <= PROVIDER_LOW_CONFIDENCE_THRESHOLD);
    let provider_speech_support = post_stt
        .provider_no_speech_probability
        .is_some_and(|value| value.is_finite() && value <= PROVIDER_SPEECH_PROBABILITY_THRESHOLD)
        || post_stt
            .provider_confidence
            .is_some_and(|value| value.is_finite() && value >= PROVIDER_HIGH_CONFIDENCE_THRESHOLD);
    let known_pattern = post_stt
        .known_hallucination_pattern
        .unwrap_or_else(|| matches_known_hallucination_pattern(transcript));
    let anomalous_transcript = known_pattern || has_repetition_anomaly(transcript);

    // Borderline means the microphone supplied no durable affirmative evidence.
    // It can now include a stale/sparse confirmed onset, so neither that onset,
    // RMS, nor normal-looking prose may rescue the transcript. Fail closed
    // unless the provider supplies explicit positive speech or confidence
    // evidence; negative metadata or an anomaly wins even if fields conflict.
    if provider_no_speech
        || provider_low_confidence
        || anomalous_transcript
        || !provider_speech_support
    {
        TranscriptVerdict::RejectLikelyHallucination
    } else {
        TranscriptVerdict::Accept
    }
}

/// A deliberately small secondary-signal set.  It is not a blacklist: callers
/// must use [`post_stt_verdict`], which requires weak independent audio evidence
/// before a match can reject.
pub fn matches_known_hallucination_pattern(transcript: &str) -> bool {
    let normalized = transcript.to_lowercase();
    [
        "thanks for watching",
        "thank you for watching",
        "like and subscribe",
        "please subscribe",
        "시청해 주셔서 감사합니다",
        "시청해주셔서 감사합니다",
        "구독과 좋아요",
        "구독 좋아요 알림",
    ]
    .iter()
    .any(|pattern| normalized.contains(pattern))
}

fn has_repetition_anomaly(transcript: &str) -> bool {
    let tokens: Vec<String> = transcript
        .split_whitespace()
        .map(|token| {
            token
                .trim_matches(|ch: char| !ch.is_alphanumeric())
                .to_lowercase()
        })
        .filter(|token| !token.is_empty())
        .collect();

    if tokens.is_empty() {
        return !transcript.trim().is_empty();
    }
    if tokens.len() < 4 {
        return false;
    }

    let max_frequency = tokens
        .iter()
        .map(|candidate| tokens.iter().filter(|token| *token == candidate).count())
        .max()
        .unwrap_or(0);
    max_frequency * 4 >= tokens.len() * 3
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::TAU;

    const RATE: u32 = 16_000;

    fn evidence_from_signal(
        samples: &[f32],
        analyzed: usize,
        voiced: usize,
        errors: usize,
        output_sample_count: usize,
    ) -> CaptureEvidence {
        let mut peak = 0.0_f32;
        let mut sum_squares = 0.0_f64;
        let mut finite = 0usize;
        let mut zeros = 0usize;
        let mut non_finite = 0usize;
        for &sample in samples {
            if sample.is_finite() {
                finite += 1;
                zeros += usize::from(sample == 0.0);
                peak = peak.max(sample.abs());
                sum_squares += f64::from(sample) * f64::from(sample);
            } else {
                non_finite += 1;
            }
        }
        let rms = if finite == 0 {
            0.0
        } else {
            (sum_squares / finite as f64).sqrt() as f32
        };
        CaptureEvidence {
            raw_sample_count: samples.len(),
            raw_sample_rate_hz: RATE,
            raw_duration_ms: samples.len() as u64 * 1_000 / u64::from(RATE),
            peak_amplitude: peak,
            rms_amplitude: rms,
            exact_zero_samples: zeros,
            non_finite_samples: non_finite,
            output_sample_count,
            vad_analyzed_frames: analyzed,
            vad_voiced_frames: voiced,
            vad_confirmed_speech_onsets: usize::from(voiced >= 2),
            vad_onset_frames: 2,
            vad_longest_voiced_run_frames: voiced,
            vad_latest_confirmed_run_frames: if voiced >= 2 { voiced } else { 0 },
            vad_last_voiced_frame: (voiced > 0).then_some(analyzed),
            vad_last_confirmed_speech_frame: (voiced >= 2).then_some(analyzed),
            vad_hangover_frames: 15,
            vad_probability_frames: 0,
            vad_mean_probability: None,
            vad_max_probability: None,
            vad_probability_threshold: None,
            vad_error_frames: errors,
        }
    }

    fn sine(duration_ms: usize, amplitude: f32, frequency_hz: f32) -> Vec<f32> {
        let len = RATE as usize * duration_ms / 1_000;
        (0..len)
            .map(|index| amplitude * (TAU * frequency_hz * index as f32 / RATE as f32).sin())
            .collect()
    }

    fn deterministic_noise(duration_ms: usize, amplitude: f32) -> Vec<f32> {
        let len = RATE as usize * duration_ms / 1_000;
        let mut state = 0x1234_5678_u32;
        (0..len)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let unit = (state as f32 / u32::MAX as f32) * 2.0 - 1.0;
                unit * amplitude
            })
            .collect()
    }

    #[test]
    fn digital_silence_is_no_speech() {
        for duration_ms in [5_000, 15_000, 30_000] {
            let samples = vec![0.0; RATE as usize * duration_ms / 1_000];
            let evidence = evidence_from_signal(&samples, samples.len() / 480, 0, 0, 0);
            assert_eq!(
                pre_stt_verdict(&evidence),
                SpeechPresenceVerdict::NoSpeech,
                "{duration_ms} ms digital silence"
            );
        }
    }

    #[test]
    fn room_fan_and_keyboard_like_evidence_are_no_speech() {
        for duration_ms in [5_000, 15_000, 30_000] {
            let room = deterministic_noise(duration_ms, 0.001);
            let fan = sine(duration_ms, 0.006, 120.0);
            let mut keyboard = vec![0.0; RATE as usize * duration_ms / 1_000];
            for index in (800..keyboard.len()).step_by(2_400) {
                keyboard[index] = 0.12;
                keyboard[index + 1] = -0.08;
            }

            for (name, samples) in [("room", room), ("fan", fan), ("keyboard", keyboard)] {
                let frames = samples.len() / 480;
                let evidence = evidence_from_signal(&samples, frames, 0, 0, samples.len());
                assert_eq!(
                    pre_stt_verdict(&evidence),
                    SpeechPresenceVerdict::NoSpeech,
                    "{duration_ms} ms {name} fixture"
                );
            }
        }
    }

    #[test]
    fn two_frame_short_korean_utterances_are_preserved() {
        for transcript in ["네", "응", "아니", "오케이"] {
            let samples = sine(60, 0.035, 190.0);
            let evidence = evidence_from_signal(&samples, 2, 2, 0, samples.len());
            assert_eq!(
                pre_stt_verdict(&evidence),
                SpeechPresenceVerdict::Speech,
                "short utterance {transcript}"
            );
            assert_eq!(
                post_stt_verdict(
                    SpeechPresenceVerdict::Speech,
                    &evidence,
                    transcript,
                    PostSttEvidence::default()
                ),
                TranscriptVerdict::Accept
            );
        }
    }

    #[test]
    fn stale_sparse_two_frame_onset_is_not_permanent_speech_evidence() {
        let reported_failures = [
            "감사합니다.",
            "직원분 IN DevOps님 말씀 뜻밖으로 고맙습니다 부탁드립니다",
            "수고하셨습니다.",
        ];

        for transcript in reported_failures {
            assert!(
                !matches_known_hallucination_pattern(transcript),
                "physical regression phrases must not be added to the lexical pattern set"
            );
        }

        for duration_ms in [5_000, 15_000, 30_000] {
            let samples = deterministic_noise(duration_ms, 0.012);
            let analyzed = samples.len() / 480;
            let mut evidence = evidence_from_signal(&samples, analyzed, 2, 0, samples.len());
            evidence.vad_last_voiced_frame = Some(2);
            evidence.vad_last_confirmed_speech_frame = Some(2);

            let pre = pre_stt_verdict(&evidence);
            assert_eq!(
                pre,
                SpeechPresenceVerdict::Borderline,
                "{duration_ms} ms stale onset"
            );
            for transcript in reported_failures {
                assert_eq!(
                    post_stt_verdict(pre, &evidence, transcript, PostSttEvidence::default()),
                    TranscriptVerdict::RejectLikelyHallucination,
                    "{duration_ms} ms stale onset: {transcript}"
                );
            }
        }
    }

    #[test]
    fn recent_two_frame_tail_preserves_short_korean_after_long_silence() {
        for duration_ms in [5_000, 15_000, 30_000] {
            for transcript in ["네", "응", "아니", "오케이", "테스트입니다"] {
                let samples = deterministic_noise(duration_ms, 0.012);
                let analyzed = samples.len() / 480;
                let evidence = evidence_from_signal(&samples, analyzed, 2, 0, samples.len());
                let pre = pre_stt_verdict(&evidence);
                assert_eq!(
                    pre,
                    SpeechPresenceVerdict::Speech,
                    "{duration_ms} ms recent short utterance {transcript}"
                );
                assert_eq!(
                    post_stt_verdict(pre, &evidence, transcript, PostSttEvidence::default()),
                    TranscriptVerdict::Accept,
                    "{duration_ms} ms recent short utterance {transcript}"
                );
            }
        }
    }

    #[test]
    fn stale_sparse_three_frame_run_is_not_sustained_capture_evidence() {
        let samples = sine(30_000, 0.028, 205.0);
        let analyzed = samples.len() / 480;
        let mut evidence = evidence_from_signal(&samples, analyzed, 3, 0, samples.len());
        evidence.vad_last_voiced_frame = Some(3);
        evidence.vad_last_confirmed_speech_frame = Some(3);

        assert_eq!(
            pre_stt_verdict(&evidence),
            SpeechPresenceVerdict::Borderline,
            "one stale 90 ms run cannot bless a 30 second capture"
        );
    }

    #[test]
    fn dense_sustained_capture_survives_a_long_trailing_pause() {
        let samples = sine(30_000, 0.028, 205.0);
        let analyzed = samples.len() / 480;
        let mut evidence = evidence_from_signal(&samples, analyzed, 180, 0, samples.len());
        evidence.vad_last_voiced_frame = Some(180);
        evidence.vad_last_confirmed_speech_frame = Some(180);

        assert_eq!(evidence.vad_required_density(), Some(2.0 / 15.0));
        assert!(evidence.vad_has_sustained_density());
        assert_eq!(
            pre_stt_verdict(&evidence),
            SpeechPresenceVerdict::Speech,
            "sustained, capture-dense speech remains affirmative when it is not recent"
        );
    }

    #[test]
    fn inconsistent_speech_preverdict_cannot_restore_stale_sparse_onset_bypass() {
        let samples = deterministic_noise(15_000, 0.012);
        let analyzed = samples.len() / 480;
        let mut evidence = evidence_from_signal(&samples, analyzed, 2, 0, samples.len());
        evidence.vad_last_voiced_frame = Some(2);
        evidence.vad_last_confirmed_speech_frame = Some(2);

        assert_eq!(
            post_stt_verdict(
                SpeechPresenceVerdict::Speech,
                &evidence,
                "평범해 보이는 문장입니다.",
                PostSttEvidence::default(),
            ),
            TranscriptVerdict::RejectLikelyHallucination
        );
    }

    #[test]
    fn normal_technical_long_and_background_speech_are_classified_as_speech() {
        let fixtures = [
            ("normal Korean sentence", 2_000, 28usize),
            ("GPT-5.6 Sol X-High technical sentence", 3_000, 45),
            ("long prompt with correction", 15_000, 260),
            ("actual background speech", 4_000, 60),
        ];
        for (name, duration_ms, voiced) in fixtures {
            let samples = sine(duration_ms, 0.028, 205.0);
            let analyzed = samples.len() / 480;
            let evidence =
                evidence_from_signal(&samples, analyzed, voiced.min(analyzed), 0, samples.len());
            assert_eq!(
                pre_stt_verdict(&evidence),
                SpeechPresenceVerdict::Speech,
                "{name}"
            );
        }
    }

    #[test]
    fn vad_error_is_uncertain_not_no_speech() {
        let samples = deterministic_noise(500, 0.001);
        let evidence = evidence_from_signal(&samples, 12, 0, 4, samples.len());
        assert_eq!(
            pre_stt_verdict(&evidence),
            SpeechPresenceVerdict::Borderline
        );
    }

    #[test]
    fn isolated_vad_positives_do_not_claim_confirmed_speech() {
        let samples = deterministic_noise(2_000, 0.004);
        let mut evidence = evidence_from_signal(&samples, 66, 2, 0, samples.len());
        evidence.vad_confirmed_speech_onsets = 0;

        assert_ne!(
            pre_stt_verdict(&evidence),
            SpeechPresenceVerdict::Speech,
            "non-consecutive positives are not a two-frame onset"
        );
        assert_eq!(
            post_stt_verdict(
                SpeechPresenceVerdict::Borderline,
                &evidence,
                "Thanks for watching",
                PostSttEvidence::default(),
            ),
            TranscriptVerdict::RejectLikelyHallucination
        );
    }

    #[test]
    fn vad_error_does_not_disable_quiet_audio_post_guard() {
        let samples = deterministic_noise(1_000, 0.001);
        let evidence = evidence_from_signal(&samples, 30, 0, 1, samples.len());
        assert_eq!(
            pre_stt_verdict(&evidence),
            SpeechPresenceVerdict::Borderline,
            "detector errors remain fail-open before STT"
        );
        assert_eq!(
            post_stt_verdict(
                SpeechPresenceVerdict::Borderline,
                &evidence,
                "Please subscribe",
                PostSttEvidence::default(),
            ),
            TranscriptVerdict::RejectLikelyHallucination
        );
    }

    #[test]
    fn loud_steady_hvac_energy_cannot_rescue_a_no_onset_transcript() {
        let samples = sine(2_000, 0.020, 120.0);
        let evidence = evidence_from_signal(&samples, 66, 0, 0, samples.len());
        assert_eq!(
            pre_stt_verdict(&evidence),
            SpeechPresenceVerdict::Borderline,
            "energy is intentionally too high for the quiet-noise pre-gate"
        );
        assert_eq!(
            post_stt_verdict(
                SpeechPresenceVerdict::Borderline,
                &evidence,
                "회의 내용을 확인해 주세요.",
                PostSttEvidence::default(),
            ),
            TranscriptVerdict::RejectLikelyHallucination
        );
    }

    #[test]
    fn known_phrase_never_rejects_on_lexical_signal_alone() {
        let samples = sine(900, 0.03, 180.0);
        let evidence = evidence_from_signal(&samples, 30, 14, 0, samples.len());
        let post = PostSttEvidence {
            provider_no_speech_probability: Some(0.99),
            provider_confidence: Some(0.01),
            known_hallucination_pattern: Some(true),
        };
        assert_eq!(
            post_stt_verdict(
                SpeechPresenceVerdict::Speech,
                &evidence,
                "시청해 주셔서 감사합니다",
                post,
            ),
            TranscriptVerdict::Accept
        );
    }

    #[test]
    fn weak_capture_plus_anomaly_is_rejected() {
        let samples = deterministic_noise(1_000, 0.012);
        let evidence = evidence_from_signal(&samples, 33, 0, 0, samples.len());
        assert_eq!(
            pre_stt_verdict(&evidence),
            SpeechPresenceVerdict::Borderline
        );
        assert_eq!(
            post_stt_verdict(
                SpeechPresenceVerdict::Borderline,
                &evidence,
                "Thanks for watching",
                PostSttEvidence::default(),
            ),
            TranscriptVerdict::RejectLikelyHallucination
        );
    }

    #[test]
    fn borderline_normal_transcript_without_positive_evidence_is_rejected() {
        let samples = deterministic_noise(1_000, 0.012);
        let evidence = evidence_from_signal(&samples, 33, 0, 0, samples.len());
        assert_eq!(
            post_stt_verdict(
                SpeechPresenceVerdict::Borderline,
                &evidence,
                "Codex에서 ProjectX 작업을 먼저 확인해줘.",
                PostSttEvidence::default(),
            ),
            TranscriptVerdict::RejectLikelyHallucination
        );
    }

    #[test]
    fn repeated_weak_noise_runs_reject_unlisted_plausible_text() {
        let samples = deterministic_noise(1_000, 0.012);
        let evidence = evidence_from_signal(&samples, 33, 0, 1, samples.len());
        let plausible_hallucinations = [
            "Hello.",
            "오늘 주요 뉴스를 전해드렸습니다.",
            "회의 내용을 확인해 주세요.",
            "This is a completely ordinary sentence.",
        ];

        for run in 0..100 {
            let transcript = plausible_hallucinations[run % plausible_hallucinations.len()];
            assert_eq!(
                post_stt_verdict(
                    SpeechPresenceVerdict::Borderline,
                    &evidence,
                    transcript,
                    PostSttEvidence::default(),
                ),
                TranscriptVerdict::RejectLikelyHallucination,
                "weak-noise run {run}: {transcript}",
            );
        }
    }

    #[test]
    fn provider_speech_support_can_rescue_a_weak_borderline_capture() {
        let samples = deterministic_noise(1_000, 0.012);
        let evidence = evidence_from_signal(&samples, 33, 0, 0, samples.len());
        assert_eq!(
            post_stt_verdict(
                SpeechPresenceVerdict::Borderline,
                &evidence,
                "Codex에서 ProjectX 작업을 먼저 확인해줘.",
                PostSttEvidence {
                    provider_no_speech_probability: Some(0.10),
                    provider_confidence: Some(0.80),
                    known_hallucination_pattern: Some(false),
                },
            ),
            TranscriptVerdict::Accept
        );
    }
}

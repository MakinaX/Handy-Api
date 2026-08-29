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

    fn crest_factor(&self) -> f32 {
        if self.rms_amplitude <= f32::EPSILON {
            0.0
        } else {
            self.peak_amplitude / self.rms_amplitude
        }
    }
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
// - Handy/Silero works on 30 ms frames.  Two positive frames (60 ms) are the
//   existing onset contract and cover short Korean acknowledgements such as
//   "네" and "응"; this guard must never raise that onset requirement.
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

    // A successful two-frame onset is affirmative evidence even for a 60 ms
    // utterance.  Do this before duration/noise heuristics to avoid clipping
    // short Korean responses.
    if evidence.vad_confirmed_speech_onsets > 0 {
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
// signal only.  Neither threshold, a transcript phrase, nor repetition can
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

    if pre_stt == SpeechPresenceVerdict::Speech {
        return TranscriptVerdict::Accept;
    }

    // Stage B returns Speech for every confirmed two-frame onset. A Borderline
    // call with an onset can only come from a future caller that supplied an
    // inconsistent pre-verdict; preserve the affirmative microphone evidence.
    if capture.vad_confirmed_speech_onsets > 0 {
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

    // Borderline means the microphone supplied no confirmed onset. RMS alone
    // cannot rescue it: loud HVAC, fans, and keyboard impulses may all have
    // substantial energy. Normal-looking prose is not proof of speech either.
    // Fail closed unless the provider supplies explicit positive speech or
    // confidence evidence; negative metadata or an anomaly wins even if
    // provider fields contradict one another.
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
        let samples = vec![0.0; RATE as usize * 2];
        let evidence = evidence_from_signal(&samples, 66, 0, 0, 0);
        assert_eq!(pre_stt_verdict(&evidence), SpeechPresenceVerdict::NoSpeech);
    }

    #[test]
    fn room_fan_and_keyboard_like_evidence_are_no_speech() {
        let room = deterministic_noise(2_000, 0.001);
        let fan = sine(2_000, 0.006, 120.0);
        let mut keyboard = vec![0.0; RATE as usize * 2];
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
                "{name} fixture"
            );
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

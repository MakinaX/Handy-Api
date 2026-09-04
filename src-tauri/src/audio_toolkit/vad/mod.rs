use anyhow::Result;

pub const VAD_PREFILL_FRAMES: usize = 15;
pub const VAD_OFFLINE_HANGOVER_FRAMES: usize = 15;
pub const VAD_STREAMING_HANGOVER_FRAMES: usize = 55;
/// Two consecutive 30 ms positives preserve ~60 ms acknowledgements such as
/// short Korean "네"/"응" while rejecting isolated clicks.  The speech guard
/// is calibrated to this contract; do not raise it without re-running its
/// short-utterance fixtures.
pub const VAD_ONSET_FRAMES: usize = 2;

pub enum VadFrame<'a> {
    /// Speech – may aggregate several frames (prefill + current + hangover)
    Speech(&'a [f32]),
    /// Non-speech (silence, noise). Down-stream code can ignore it.
    Noise,
}

impl<'a> VadFrame<'a> {
    #[inline]
    pub fn is_speech(&self) -> bool {
        matches!(self, VadFrame::Speech(_))
    }
}

pub trait VoiceActivityDetector: Send + Sync {
    /// Primary streaming API: feed one 30-ms frame, get keep/drop decision.
    fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>>;

    fn is_voice(&mut self, frame: &[f32]) -> Result<bool> {
        Ok(self.push_frame(frame)?.is_speech())
    }

    /// Probability produced for the most recently analyzed frame, when the
    /// detector exposes one. This is diagnostic evidence only: callers must
    /// not assume that every VAD family has comparable probability semantics.
    fn last_voice_probability(&self) -> Option<f32> {
        None
    }

    /// Decision threshold paired with [`Self::last_voice_probability`], when
    /// available. Keeping the threshold beside the observed probabilities
    /// makes physical calibration receipts self-describing.
    fn voice_probability_threshold(&self) -> Option<f32> {
        None
    }

    /// Set the post-speech hangover tail (in 30 ms frames) applied to
    /// subsequent frames. Detectors without a smoothing tail can ignore this.
    fn set_hangover_frames(&mut self, _frames: usize) {}

    /// End-of-recording diagnostic snapshot, taken after the final frame.
    /// Purely observational — implementations must not change what they emit.
    /// Detectors without smoothing state return None.
    fn tail_report(&self) -> Option<VadTailReport> {
        None
    }

    /// Cumulative raw VAD decisions since the last reset.  Unlike emitted
    /// `VadFrame::Speech` buffers, this excludes smoothing pre-roll/hangover so
    /// it can be used as capture evidence without inflating the voiced ratio.
    fn activity_report(&self) -> Option<VadActivityReport> {
        None
    }

    fn reset(&mut self) {}
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct VadActivityReport {
    pub analyzed_frames: usize,
    pub voiced_frames: usize,
    /// Number of times the detector satisfied its consecutive-frame onset
    /// contract and entered confirmed speech.
    pub confirmed_speech_onsets: usize,
    /// Consecutive raw positive frames required to confirm one onset.
    pub onset_frames: usize,
    /// Longest run of consecutive raw positive decisions.
    pub longest_voiced_run_frames: usize,
    /// Length of the most recent run that reached the onset contract. A later
    /// isolated positive does not overwrite this value.
    pub latest_confirmed_run_frames: usize,
    /// One-based index of the last raw positive frame, or `None` if there was
    /// no positive decision.
    pub last_voiced_frame: Option<usize>,
    /// One-based index of the last frame in the most recent confirmed run.
    pub last_confirmed_speech_frame: Option<usize>,
    /// Hangover configured for this capture. This is also the policy-defined
    /// recent-speech window used by the speech-presence guard.
    pub hangover_frames: usize,
    /// Number of frames for which a detector probability was available.
    pub probability_frames: usize,
    pub mean_voice_probability: Option<f32>,
    pub max_voice_probability: Option<f32>,
    pub voice_probability_threshold: Option<f32>,
}

/// End-of-recording snapshot of a smoothing detector's state. Voiced frames
/// in the withheld tail suggest — but don't prove — a final word cut off at
/// the stop; a clean report doesn't rule VAD loss out either (soft trailing
/// speech can be classified as noise).
#[derive(Debug, Clone, Copy)]
pub struct VadTailReport {
    /// Trailing frames buffered but never emitted downstream.
    pub withheld_frames: usize,
    /// How many of those withheld frames the inner VAD classified as voiced.
    pub withheld_voiced_frames: usize,
    pub in_speech: bool,
    /// Voiced frames counted toward an unconfirmed speech onset.
    pub onset_counter: usize,
    pub hangover_counter: usize,
}

mod silero;
mod smoothed;

pub use silero::SileroVad;
pub use smoothed::SmoothedVad;

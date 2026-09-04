use super::{VadActivityReport, VadFrame, VadTailReport, VoiceActivityDetector};
use anyhow::Result;
use std::collections::VecDeque;

/// One pre-roll buffer slot. `emitted` and `voiced` exist only to power the
/// end-of-recording `tail_report()` diagnostic; they never affect emission.
struct BufferedFrame {
    samples: Vec<f32>,
    emitted: bool,
    voiced: bool,
}

pub struct SmoothedVad {
    inner_vad: Box<dyn VoiceActivityDetector>,
    prefill_frames: usize,
    hangover_frames: usize,
    onset_frames: usize,

    frame_buffer: VecDeque<BufferedFrame>,
    hangover_counter: usize,
    onset_counter: usize,
    in_speech: bool,
    analyzed_frames: usize,
    voiced_frames: usize,
    confirmed_speech_onsets: usize,
    current_voiced_run_frames: usize,
    longest_voiced_run_frames: usize,
    latest_confirmed_run_frames: usize,
    last_voiced_frame: Option<usize>,
    last_confirmed_speech_frame: Option<usize>,
    probability_frames: usize,
    probability_sum: f64,
    max_voice_probability: Option<f32>,

    temp_out: Vec<f32>,
}

impl SmoothedVad {
    pub fn new(
        inner_vad: Box<dyn VoiceActivityDetector>,
        prefill_frames: usize,
        hangover_frames: usize,
        onset_frames: usize,
    ) -> Self {
        Self {
            inner_vad,
            prefill_frames,
            hangover_frames,
            onset_frames,
            frame_buffer: VecDeque::new(),
            hangover_counter: 0,
            onset_counter: 0,
            in_speech: false,
            analyzed_frames: 0,
            voiced_frames: 0,
            confirmed_speech_onsets: 0,
            current_voiced_run_frames: 0,
            longest_voiced_run_frames: 0,
            latest_confirmed_run_frames: 0,
            last_voiced_frame: None,
            last_confirmed_speech_frame: None,
            probability_frames: 0,
            probability_sum: 0.0,
            max_voice_probability: None,
            temp_out: Vec::new(),
        }
    }

    fn mark_last_emitted(&mut self) {
        if let Some(frame) = self.frame_buffer.back_mut() {
            frame.emitted = true;
        }
    }
}

impl VoiceActivityDetector for SmoothedVad {
    fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>> {
        // 1. Buffer every incoming frame for possible pre-roll
        self.frame_buffer.push_back(BufferedFrame {
            samples: frame.to_vec(),
            emitted: false,
            voiced: false,
        });
        while self.frame_buffer.len() > self.prefill_frames + 1 {
            self.frame_buffer.pop_front();
        }

        // 2. Delegate to the wrapped boolean VAD
        let is_voice = self.inner_vad.is_voice(frame)?;
        self.analyzed_frames += 1;
        self.voiced_frames += usize::from(is_voice);
        if let Some(probability) = self
            .inner_vad
            .last_voice_probability()
            .filter(|value| value.is_finite())
        {
            self.probability_frames = self.probability_frames.saturating_add(1);
            self.probability_sum += f64::from(probability);
            self.max_voice_probability = Some(
                self.max_voice_probability
                    .map_or(probability, |current| current.max(probability)),
            );
        }
        if is_voice {
            self.current_voiced_run_frames = self.current_voiced_run_frames.saturating_add(1);
            self.longest_voiced_run_frames = self
                .longest_voiced_run_frames
                .max(self.current_voiced_run_frames);
            self.last_voiced_frame = Some(self.analyzed_frames);
            if self.current_voiced_run_frames >= self.onset_frames {
                self.latest_confirmed_run_frames = self.current_voiced_run_frames;
                self.last_confirmed_speech_frame = Some(self.analyzed_frames);
            }
        } else {
            self.current_voiced_run_frames = 0;
        }
        if let Some(last) = self.frame_buffer.back_mut() {
            last.voiced = is_voice;
        }

        match (self.in_speech, is_voice) {
            // Potential start of speech - need to accumulate onset frames
            (false, true) => {
                self.onset_counter += 1;
                if self.onset_counter >= self.onset_frames {
                    // We have enough consecutive voice frames to trigger speech
                    self.in_speech = true;
                    self.confirmed_speech_onsets = self.confirmed_speech_onsets.saturating_add(1);
                    self.hangover_counter = self.hangover_frames;
                    self.onset_counter = 0; // Reset for next time

                    // Collect prefill + current frame
                    self.temp_out.clear();
                    for buffered in self.frame_buffer.iter_mut() {
                        self.temp_out.extend(buffered.samples.iter());
                        buffered.emitted = true;
                    }
                    Ok(VadFrame::Speech(&self.temp_out))
                } else {
                    // Not enough frames yet, still silence
                    Ok(VadFrame::Noise)
                }
            }

            // Ongoing Speech
            (true, true) => {
                self.hangover_counter = self.hangover_frames;
                self.mark_last_emitted();
                Ok(VadFrame::Speech(frame))
            }

            // End of Speech or interruption during onset phase
            (true, false) => {
                if self.hangover_counter > 0 {
                    self.hangover_counter -= 1;
                    self.mark_last_emitted();
                    Ok(VadFrame::Speech(frame))
                } else {
                    self.in_speech = false;
                    Ok(VadFrame::Noise)
                }
            }

            // Silence or broken onset sequence
            (false, false) => {
                self.onset_counter = 0; // Reset onset counter on silence
                Ok(VadFrame::Noise)
            }
        }
    }

    fn set_hangover_frames(&mut self, frames: usize) {
        self.hangover_frames = frames;
    }

    /// Trailing run of withheld frames plus smoothing state. Interior
    /// withheld frames (before already-emitted speech) are not counted.
    fn tail_report(&self) -> Option<VadTailReport> {
        let mut withheld_frames = 0;
        let mut withheld_voiced_frames = 0;
        for frame in self
            .frame_buffer
            .iter()
            .rev()
            .take_while(|frame| !frame.emitted)
        {
            withheld_frames += 1;
            if frame.voiced {
                withheld_voiced_frames += 1;
            }
        }

        Some(VadTailReport {
            withheld_frames,
            withheld_voiced_frames,
            in_speech: self.in_speech,
            onset_counter: self.onset_counter,
            hangover_counter: self.hangover_counter,
        })
    }

    fn activity_report(&self) -> Option<VadActivityReport> {
        let mean_voice_probability = (self.probability_frames > 0)
            .then(|| (self.probability_sum / self.probability_frames as f64) as f32);
        Some(VadActivityReport {
            analyzed_frames: self.analyzed_frames,
            voiced_frames: self.voiced_frames,
            confirmed_speech_onsets: self.confirmed_speech_onsets,
            onset_frames: self.onset_frames,
            longest_voiced_run_frames: self.longest_voiced_run_frames,
            latest_confirmed_run_frames: self.latest_confirmed_run_frames,
            last_voiced_frame: self.last_voiced_frame,
            last_confirmed_speech_frame: self.last_confirmed_speech_frame,
            hangover_frames: self.hangover_frames,
            probability_frames: self.probability_frames,
            mean_voice_probability,
            max_voice_probability: self.max_voice_probability,
            voice_probability_threshold: self.inner_vad.voice_probability_threshold(),
        })
    }

    fn reset(&mut self) {
        self.inner_vad.reset();
        self.frame_buffer.clear();
        self.hangover_counter = 0;
        self.onset_counter = 0;
        self.in_speech = false;
        self.analyzed_frames = 0;
        self.voiced_frames = 0;
        self.confirmed_speech_onsets = 0;
        self.current_voiced_run_frames = 0;
        self.longest_voiced_run_frames = 0;
        self.latest_confirmed_run_frames = 0;
        self.last_voiced_frame = None;
        self.last_confirmed_speech_frame = None;
        self.probability_frames = 0;
        self.probability_sum = 0.0;
        self.max_voice_probability = None;
        self.temp_out.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Inner VAD that replays a scripted voice/no-voice sequence.
    struct ScriptedVad {
        script: VecDeque<bool>,
        last_probability: Option<f32>,
    }

    impl ScriptedVad {
        fn new(script: &[bool]) -> Self {
            Self {
                script: script.iter().copied().collect(),
                last_probability: None,
            }
        }
    }

    impl VoiceActivityDetector for ScriptedVad {
        fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>> {
            let voiced = self.script.pop_front().unwrap_or(false);
            self.last_probability = Some(if voiced { 0.85 } else { 0.05 });
            if voiced {
                Ok(VadFrame::Speech(frame))
            } else {
                Ok(VadFrame::Noise)
            }
        }

        fn last_voice_probability(&self) -> Option<f32> {
            self.last_probability
        }

        fn voice_probability_threshold(&self) -> Option<f32> {
            Some(0.3)
        }

        fn reset(&mut self) {
            self.last_probability = None;
        }
    }

    fn frame(value: f32) -> Vec<f32> {
        vec![value; 4]
    }

    fn smoothed(script: &[bool], onset_frames: usize) -> SmoothedVad {
        SmoothedVad::new(Box::new(ScriptedVad::new(script)), 3, 2, onset_frames)
    }

    #[test]
    fn tail_report_counts_withheld_onset_tail() {
        // One voiced frame at the end: onset (2 frames) never confirms, so
        // both trailing frames are withheld and one of them is voiced —
        // consistent with a final word cut off at the stop boundary.
        let mut vad = smoothed(&[false, true], 2);
        assert!(!vad.push_frame(&frame(0.1)).unwrap().is_speech());
        assert!(!vad.push_frame(&frame(0.9)).unwrap().is_speech());

        let report = vad.tail_report().expect("smoothed VAD always reports");
        assert_eq!(report.withheld_frames, 2);
        assert_eq!(report.withheld_voiced_frames, 1);
        assert_eq!(report.onset_counter, 1);
        assert!(!report.in_speech);
    }

    #[test]
    fn tail_report_counts_only_trailing_run() {
        // Speech emitted through hangover, then silence past the hangover is
        // withheld. Only the trailing run counts — frames older than an
        // emitted frame are excluded.
        let mut vad = smoothed(&[true, true, false, false, false, false], 2);
        for v in [0.1, 0.2, 0.3, 0.4] {
            let _ = vad.push_frame(&frame(v)).unwrap();
        }
        assert!(!vad.push_frame(&frame(0.5)).unwrap().is_speech()); // past hangover
        assert!(!vad.push_frame(&frame(0.6)).unwrap().is_speech());

        let report = vad.tail_report().unwrap();
        assert_eq!(report.withheld_frames, 2);
        assert_eq!(report.withheld_voiced_frames, 0);
    }

    #[test]
    fn two_frame_onset_emits_short_utterance_and_reports_both_voiced_frames() {
        let mut vad = smoothed(&[true, true], 2);
        assert!(!vad.push_frame(&frame(0.3)).unwrap().is_speech());
        let second_frame = frame(0.4);
        let emitted = vad.push_frame(&second_frame).unwrap();
        assert!(emitted.is_speech(), "second 30 ms frame must confirm onset");

        let activity = vad.activity_report().unwrap();
        assert_eq!(activity.analyzed_frames, 2);
        assert_eq!(activity.voiced_frames, 2);
        assert_eq!(activity.confirmed_speech_onsets, 1);
        assert_eq!(activity.onset_frames, 2);
        assert_eq!(activity.longest_voiced_run_frames, 2);
        assert_eq!(activity.latest_confirmed_run_frames, 2);
        assert_eq!(activity.last_voiced_frame, Some(2));
        assert_eq!(activity.last_confirmed_speech_frame, Some(2));
        assert_eq!(activity.hangover_frames, 2);
        assert_eq!(activity.probability_frames, 2);
        assert_eq!(activity.mean_voice_probability, Some(0.85));
        assert_eq!(activity.max_voice_probability, Some(0.85));
        assert_eq!(activity.voice_probability_threshold, Some(0.3));
    }

    #[test]
    fn activity_report_keeps_last_confirmed_run_when_later_positive_is_isolated() {
        let mut vad = smoothed(&[false, true, true, false, true, false, false], 2);
        for value in 0..7 {
            let _ = vad.push_frame(&frame(value as f32)).unwrap();
        }

        let activity = vad.activity_report().unwrap();
        assert_eq!(activity.analyzed_frames, 7);
        assert_eq!(activity.voiced_frames, 3);
        assert_eq!(activity.confirmed_speech_onsets, 1);
        assert_eq!(activity.longest_voiced_run_frames, 2);
        assert_eq!(activity.latest_confirmed_run_frames, 2);
        assert_eq!(activity.last_voiced_frame, Some(5));
        assert_eq!(activity.last_confirmed_speech_frame, Some(3));
    }

    #[test]
    fn activity_report_resets_between_sessions() {
        let mut vad = smoothed(&[true, true, false], 2);
        let _ = vad.push_frame(&frame(0.3)).unwrap();
        let _ = vad.push_frame(&frame(0.4)).unwrap();
        assert_eq!(vad.activity_report().unwrap().voiced_frames, 2);

        vad.reset();
        let activity = vad.activity_report().unwrap();
        assert_eq!(activity.analyzed_frames, 0);
        assert_eq!(activity.voiced_frames, 0);
        assert_eq!(activity.confirmed_speech_onsets, 0);
        assert_eq!(activity.onset_frames, 2);
        assert_eq!(activity.longest_voiced_run_frames, 0);
        assert_eq!(activity.latest_confirmed_run_frames, 0);
        assert_eq!(activity.last_voiced_frame, None);
        assert_eq!(activity.last_confirmed_speech_frame, None);
        assert_eq!(activity.hangover_frames, 2);
        assert_eq!(activity.probability_frames, 0);
        assert_eq!(activity.mean_voice_probability, None);
        assert_eq!(activity.max_voice_probability, None);
        assert_eq!(activity.voice_probability_threshold, Some(0.3));
    }
}

import { invoke } from "@tauri-apps/api/core";
import type { GeminiTranscriptionMode, TranscriptionBackend } from "@/bindings";

export const geminiCommands = {
  setBackend: (backend: TranscriptionBackend) =>
    invoke<void>("change_transcription_backend_setting", { backend }),
  setMode: (mode: GeminiTranscriptionMode) =>
    invoke<void>("change_gemini_transcription_mode_setting", { mode }),
  setLanguage: (language: string) =>
    invoke<void>("change_gemini_language_setting", { language }),
  keyConfigured: () => invoke<boolean>("gemini_api_key_status"),
  saveApiKey: (apiKey: string) =>
    invoke<void>("save_gemini_api_key", { apiKey }),
  testConnection: () => invoke<void>("test_gemini_connection"),
  testApiKey: (apiKey: string) =>
    invoke<void>("test_gemini_api_key", { apiKey }),
};

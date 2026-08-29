import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { GeminiTranscriptionMode } from "@/bindings";
import { geminiCommands } from "@/lib/geminiCommands";
import { useSettings } from "@/hooks/useSettings";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { SettingContainer } from "@/components/ui/SettingContainer";

export const GeminiSettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const [apiKey, setApiKey] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const mode = getSetting("gemini_transcription_mode") ?? "smart";
  const language = getSetting("gemini_language") ?? "auto";

  useEffect(() => {
    geminiCommands
      .keyConfigured()
      .then(setKeyConfigured)
      .catch(() => setKeyConfigured(false));
  }, []);

  const saveKey = async (): Promise<boolean> => {
    if (!apiKey.trim()) return keyConfigured;
    setSaving(true);
    try {
      await geminiCommands.saveApiKey(apiKey);
      setApiKey("");
      setKeyConfigured(true);
      toast.success(t("settings.gemini.apiKey.saved"));
      return true;
    } catch {
      toast.error(t("settings.gemini.apiKey.saveError"));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      if (apiKey.trim()) {
        // Test typed replacement credentials without overwriting a working
        // Credential Manager entry. Persistence remains an explicit Save.
        await geminiCommands.testApiKey(apiKey);
      } else {
        await geminiCommands.testConnection();
      }
      toast.success(t("settings.gemini.connection.success"));
    } catch {
      toast.error(t("settings.gemini.connection.error"));
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <SettingContainer
        title={t("settings.gemini.apiKey.title")}
        description={t("settings.gemini.apiKey.description")}
        grouped
        layout="stacked"
      >
        <div className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              keyConfigured
                ? t("settings.gemini.apiKey.configured")
                : t("settings.gemini.apiKey.placeholder")
            }
            className="flex-1"
            aria-label={t("settings.gemini.apiKey.title")}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={!apiKey.trim() || saving}
            onClick={() => void saveKey()}
          >
            {saving
              ? t("settings.gemini.apiKey.saving")
              : t("settings.gemini.apiKey.save")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={testing || (!keyConfigured && !apiKey.trim())}
            onClick={() => void testConnection()}
          >
            {testing
              ? t("settings.gemini.connection.testing")
              : t("settings.gemini.connection.test")}
          </Button>
        </div>
      </SettingContainer>

      <SettingContainer
        title={t("settings.gemini.mode.title")}
        description={t("settings.gemini.mode.description")}
        grouped
      >
        <Select
          value={mode}
          options={[
            { value: "smart", label: t("settings.gemini.mode.smart") },
            { value: "verbatim", label: t("settings.gemini.mode.verbatim") },
          ]}
          isClearable={false}
          disabled={isUpdating("gemini_transcription_mode")}
          onChange={(value) => {
            if (value) {
              void updateSetting(
                "gemini_transcription_mode",
                value as GeminiTranscriptionMode,
              );
            }
          }}
          className="min-w-48"
        />
      </SettingContainer>

      <SettingContainer
        title={t("settings.gemini.language.title")}
        description={t("settings.gemini.language.description")}
        grouped
      >
        <Select
          value={language}
          options={[
            { value: "auto", label: t("settings.gemini.language.auto") },
            { value: "ko-KR", label: t("settings.gemini.language.korean") },
            { value: "en-US", label: t("settings.gemini.language.english") },
          ]}
          isClearable={false}
          disabled={isUpdating("gemini_language")}
          onChange={(value) => {
            if (value) void updateSetting("gemini_language", value);
          }}
          className="min-w-48"
        />
      </SettingContainer>
    </>
  );
};

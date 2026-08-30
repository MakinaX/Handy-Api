//! Gemini API-key storage.
//!
//! The production target is Windows, where the key is stored in Credential
//! Manager instead of the JSON settings store. `HANDY_GEMINI_API_KEY` is a
//! process-scoped development/CI override and is never persisted or logged.

#[cfg(any(target_os = "windows", test))]
const SERVICE: &str = "computer.handy.api";
#[cfg(any(target_os = "windows", test))]
const ACCOUNT: &str = "gemini-api-key";
const ENV_KEY: &str = "HANDY_GEMINI_API_KEY";

pub fn load() -> Result<Option<String>, String> {
    if let Ok(value) = std::env::var(ENV_KEY) {
        let value = value.trim().to_string();
        if !value.is_empty() {
            return Ok(Some(value));
        }
    }

    load_from_os_store()
}

pub fn is_configured() -> Result<bool, String> {
    Ok(load()?.is_some())
}

#[cfg(target_os = "windows")]
fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|_| "Windows Credential Manager is unavailable".to_string())
}

#[cfg(target_os = "windows")]
fn load_from_os_store() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Unable to read the Gemini API key from Windows Credential Manager".into()),
    }
}

#[cfg(not(target_os = "windows"))]
fn load_from_os_store() -> Result<Option<String>, String> {
    Ok(None)
}

pub fn store(value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return delete();
    }
    store_in_os_store(value)
}

#[cfg(target_os = "windows")]
fn store_in_os_store(value: &str) -> Result<(), String> {
    entry()?
        .set_password(value)
        .map_err(|_| "Unable to save the Gemini API key in Windows Credential Manager".into())
}

#[cfg(not(target_os = "windows"))]
fn store_in_os_store(_value: &str) -> Result<(), String> {
    Err("Gemini API-key persistence is available only in the Windows build".into())
}

pub fn delete() -> Result<(), String> {
    delete_from_os_store()
}

#[cfg(target_os = "windows")]
fn delete_from_os_store() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Unable to remove the Gemini API key from Windows Credential Manager".into()),
    }
}

#[cfg(not(target_os = "windows"))]
fn delete_from_os_store() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_is_app_common_and_account_is_provider_specific() {
        assert_eq!(SERVICE, "computer.handy.api");
        assert_ne!(SERVICE, "com.pais.handy");
        assert_eq!(ACCOUNT, "gemini-api-key");
    }
}

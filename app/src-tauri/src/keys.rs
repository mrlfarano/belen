use std::{fs, path::PathBuf};

#[cfg(windows)]
use windows::Win32::Foundation::{HLOCAL, LocalFree};
#[cfg(windows)]
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

/// Keychain service all BELEN keys live under (macOS).
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "dev.belen.desktop";

/// `errSecItemNotFound` — no keychain item under this service/account.
#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

/// `data/` lives beside the executable unless `BELEN_DATA_DIR` overrides it.
pub fn data_root() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("BELEN_DATA_DIR") {
        let p = PathBuf::from(p);
        fs::create_dir_all(&p).map_err(|e| e.to_string())?;
        return Ok(p);
    }

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .parent()
        .ok_or("executable has no parent directory")?
        .join("data");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Key ids historically used `provider:<id>`; `:` is illegal in Windows file
/// names, which made every API-key save fail. Normalise to `-`.
fn normalize_key_name(name: &str) -> Result<String, String> {
    let normalized = name.replace(':', "-");

    if normalized.is_empty()
        || !normalized
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(format!("invalid key name: {name}"));
    }

    Ok(normalized)
}

#[cfg(windows)]
pub fn set(name: &str, value: &[u8]) -> Result<(), String> {
    let blob = protect(value)?;
    fs::write(key_path(name)?, blob).map_err(|e| e.to_string())
}

#[cfg(windows)]
pub fn get(name: &str) -> Result<Option<Vec<u8>>, String> {
    let path = key_path(name)?;
    if !path.exists() {
        return Ok(None);
    }
    let blob = fs::read(path).map_err(|e| e.to_string())?;
    Ok(Some(unprotect(&blob)?))
}

#[cfg(target_os = "macos")]
pub fn set(name: &str, value: &[u8]) -> Result<(), String> {
    let account = normalize_key_name(name)?;
    // The Keychain silently ignores an update that writes an empty password
    // (clearOAuth saves ""), so replace the item instead of updating it.
    if value.is_empty() {
        let _ = security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, &account);
    }
    security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, &account, value)
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
pub fn get(name: &str) -> Result<Option<Vec<u8>>, String> {
    let account = normalize_key_name(name)?;
    match security_framework::passwords::generic_password(
        security_framework::passwords::PasswordOptions::new_generic_password(
            KEYCHAIN_SERVICE,
            &account,
        ),
    ) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        // Anything else — including a denied Keychain prompt — is a real
        // error; the UI must be able to show the cause, not "not connected".
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(windows)]
fn key_path(name: &str) -> Result<PathBuf, String> {
    let normalized = normalize_key_name(name)?;

    let root = data_root()?;
    let dir = root.join("keys");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{normalized}.dpapi")))
}

#[cfg(windows)]
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    unsafe {
        CryptProtectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            .map_err(|e| e.to_string())?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        Ok(bytes)
    }
}

#[cfg(windows)]
fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    unsafe {
        CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            .map_err(|e| e.to_string())?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip() {
        let dir = std::env::temp_dir().join("belen-keytest");
        unsafe { std::env::set_var("BELEN_DATA_DIR", &dir) };

        set("test.key", b"sk-secret-123").expect("protect + write");
        let got = get("test.key").expect("read + unprotect").expect("value");

        assert_eq!(got, b"sk-secret-123");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn colon_names_normalize() {
        let path = key_path("provider:zai:oauth").expect("normalise");
        assert!(
            path.to_string_lossy().ends_with("provider-zai-oauth.dpapi"),
            "unexpected path: {}",
            path.display()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn keychain_roundtrip() {
        // Unique per run so reruns never collide with a leftover item.
        let account = format!(
            "belen-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );

        // Deletes the item even if an assertion below panics.
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ =
                    security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, &self.0);
            }
        }
        let _cleanup = Cleanup(account.clone());

        set(&account, b"sk-secret-123").expect("set");
        let got = get(&account).expect("get").expect("value");
        assert_eq!(got, b"sk-secret-123");

        // Overwrite: clearOAuth writes "", and an empty value must come back
        // as empty, not absent.
        set(&account, b"").expect("set empty");
        let empty = get(&account).expect("get empty").expect("value");
        assert!(empty.is_empty(), "empty value must round-trip, got {empty:?}");

        security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, &account)
            .expect("delete");
        assert!(get(&account).expect("get after delete").is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn keychain_names_normalize() {
        set("provider:zai:oauth", b"token").expect("set via colon name");
        let got = get("provider-zai-oauth")
            .expect("get via normalised name")
            .expect("value");
        assert_eq!(got, b"token");
        let _ = security_framework::passwords::delete_generic_password(
            KEYCHAIN_SERVICE,
            "provider-zai-oauth",
        );
        assert!(normalize_key_name("bad name!").is_err());
    }

    #[test]
    fn missing_key_is_none() {
        let dir = std::env::temp_dir().join("belen-keytest-missing");
        unsafe { std::env::set_var("BELEN_DATA_DIR", &dir) };

        let got = get("absent.key").expect("read");
        assert!(got.is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}

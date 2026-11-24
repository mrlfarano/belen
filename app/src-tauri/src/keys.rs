use std::{fs, path::PathBuf};

use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

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

fn key_path(name: &str) -> Result<PathBuf, String> {
    // Key ids historically used `provider:<id>`; `:` is illegal in Windows file
    // names, which made every API-key save fail. Normalise to `-`.
    let normalized = name.replace(':', "-");

    if normalized.is_empty()
        || !normalized
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(format!("invalid key name: {name}"));
    }

    let root = data_root()?;
    let dir = root.join("keys");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{normalized}.dpapi")))
}

pub fn set(name: &str, value: &[u8]) -> Result<(), String> {
    let blob = protect(value)?;
    fs::write(key_path(name)?, blob).map_err(|e| e.to_string())
}

pub fn get(name: &str) -> Result<Option<Vec<u8>>, String> {
    let path = key_path(name)?;
    if !path.exists() {
        return Ok(None);
    }
    let blob = fs::read(path).map_err(|e| e.to_string())?;
    Ok(Some(unprotect(&blob)?))
}

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

    #[test]
    fn dpapi_roundtrip() {
        let dir = std::env::temp_dir().join("belen-keytest");
        unsafe { std::env::set_var("BELEN_DATA_DIR", &dir) };

        set("test.key", b"sk-secret-123").expect("protect + write");
        let got = get("test.key").expect("read + unprotect").expect("value");

        assert_eq!(got, b"sk-secret-123");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn colon_names_normalize() {
        let path = key_path("provider:zai:oauth").expect("normalise");
        assert!(
            path.to_string_lossy().ends_with("provider-zai-oauth.dpapi"),
            "unexpected path: {}",
            path.display()
        );
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

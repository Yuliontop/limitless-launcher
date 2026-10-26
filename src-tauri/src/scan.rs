//! Finds installed games. Each scanner returns nothing if its launcher isn't installed.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::{env, fs};
use winreg::{enums::*, RegKey};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub name: String,
    pub kind: &'static str,
    pub target: String,
    pub args: String,
    pub cwd: String,
    pub source: &'static str,
    pub source_id: String,
}

pub fn scan_all() -> Vec<Found> {
    let mut seen = HashSet::new();
    let mut all = steam();
    all.extend(epic());
    all.extend(gog());
    all.retain(|f| seen.insert((f.source, f.source_id.clone())));
    all
}

// ---- Steam -------------------------------------------------------------

/// Every `"key"  "value"` line. Handles \\ and \" escapes; nesting is ignored (first match wins in `get`).
fn vdf_pairs(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let (mut out, mut cur, mut inq, mut esc) = (Vec::new(), String::new(), false, false);
            for c in line.chars() {
                if !inq {
                    inq = c == '"';
                } else if esc {
                    cur.push(c);
                    esc = false;
                } else if c == '\\' {
                    esc = true;
                } else if c == '"' {
                    out.push(std::mem::take(&mut cur));
                    inq = false;
                } else {
                    cur.push(c);
                }
            }
            match <[String; 2]>::try_from(out) {
                Ok([k, v]) => Some((k, v)),
                Err(_) => None,
            }
        })
        .collect()
}

fn get<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

fn steam_item(acf: &str) -> Option<Found> {
    let p = vdf_pairs(acf);
    let (id, name) = (get(&p, "appid")?, get(&p, "name")?);
    let flags: u32 = get(&p, "StateFlags")?.parse().ok()?;
    let tool = id == "228980" || ["Steamworks Common", "Steam Linux Runtime", "Proton"].iter().any(|s| name.starts_with(s));
    // StateFlags bit 4 = fully installed
    (flags & 4 != 0 && !tool).then(|| Found {
        name: name.into(),
        kind: "uri",
        target: format!("steam://rungameid/{id}"),
        args: String::new(),
        cwd: String::new(),
        source: "steam",
        source_id: id.into(),
    })
}

fn steam_libs() -> Vec<PathBuf> {
    let root = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Valve\\Steam")
        .and_then(|k| k.get_value::<String, _>("SteamPath"));
    let Ok(root) = root else { return vec![] };
    let root = PathBuf::from(root);
    let mut libs = vec![root.clone()];
    if let Ok(t) = fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
        libs.extend(vdf_pairs(&t).into_iter().filter(|(k, _)| k == "path").map(|(_, v)| PathBuf::from(v)));
    }
    libs
}

fn steam() -> Vec<Found> {
    steam_libs()
        .iter()
        .flat_map(|l| fs::read_dir(l.join("steamapps")).into_iter().flatten().flatten())
        .filter(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.starts_with("appmanifest_") && n.ends_with(".acf")
        })
        .filter_map(|e| steam_item(&fs::read_to_string(e.path()).ok()?))
        .collect()
}

// ---- Epic --------------------------------------------------------------

fn epic_item(json: &str) -> Option<Found> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
    let (name, app, main) = (s("DisplayName"), s("AppName"), s("MainGameAppName"));
    // Skip DLC/add-ons (they point at a main game or have nothing to run) and half-installed games.
    let dlc = (!main.is_empty() && main != app) || s("LaunchExecutable").is_empty();
    if name.is_empty() || app.is_empty() || dlc || v["bIsIncompleteInstall"].as_bool() == Some(true) {
        return None;
    }
    Some(Found {
        name,
        kind: "uri",
        target: format!("com.epicgames.launcher://apps/{app}?action=launch&silent=true"),
        args: String::new(),
        cwd: String::new(),
        source: "epic",
        source_id: app,
    })
}

fn epic() -> Vec<Found> {
    let pd = env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
    let dir = PathBuf::from(pd).join("Epic\\EpicGamesLauncher\\Data\\Manifests");
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "item"))
        .filter_map(|e| epic_item(&fs::read_to_string(e.path()).ok()?))
        .collect()
}

// ---- icons -------------------------------------------------------------

/// The file whose icon stands for an item: its own exe/shortcut, or the game's exe found via its store.
pub fn icon_file(target: &str, source: &str, source_id: &str) -> Option<PathBuf> {
    match source {
        "steam" => steam_libs().iter().find_map(|lib| {
            let acf = fs::read_to_string(lib.join(format!("steamapps/appmanifest_{source_id}.acf"))).ok()?;
            main_exe(&lib.join("steamapps/common").join(get(&vdf_pairs(&acf), "installdir")?))
        }),
        "epic" => {
            let pd = env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
            let dir = PathBuf::from(pd).join("Epic\\EpicGamesLauncher\\Data\\Manifests");
            fs::read_dir(dir).ok()?.flatten().find_map(|e| {
                let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(e.path()).ok()?).ok()?;
                let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
                (s("AppName") == source_id).then(|| Path::new(&s("InstallLocation")).join(s("LaunchExecutable")))
            })
        }
        _ => Some(PathBuf::from(target)).filter(|p| p.is_absolute() && p.exists()),
    }
}

/// Steam only says which folder a game is in. Guess its exe: the biggest one a few levels down that isn't
/// a crash reporter, installer or redistributable.
// ponytail: size heuristic; wrong when a launcher stub outweighs the game. "Set cover" overrides it.
fn main_exe(dir: &Path) -> Option<PathBuf> {
    const SKIP: [&str; 11] = ["crash", "unins", "redist", "setup", "prereq", "anticheat", "eac_", "vc_", "dotnet", "report", "vconsole"];
    let mut best: Option<(u64, PathBuf)> = None;
    let mut stack = vec![(dir.to_path_buf(), 0)];
    while let Some((d, depth)) = stack.pop() {
        for e in fs::read_dir(&d).into_iter().flatten().flatten() {
            let (p, Ok(meta)) = (e.path(), e.metadata()) else { continue };
            let rel = p.strip_prefix(dir).unwrap_or(&p).to_string_lossy().to_lowercase();
            if SKIP.iter().any(|s| rel.contains(s)) {
                continue;
            }
            if meta.is_dir() && depth < 4 {
                stack.push((p, depth + 1));
            } else if rel.ends_with(".exe") && best.as_ref().map_or(true, |(n, _)| meta.len() > *n) {
                best = Some((meta.len(), p));
            }
        }
    }
    best.map(|(_, p)| p)
}

// ---- GOG ---------------------------------------------------------------

fn gog_item(id: &str, k: &RegKey) -> Option<Found> {
    let s = |n: &str| k.get_value::<String, _>(n).unwrap_or_default();
    let (name, exe) = (s("gameName"), s("exe"));
    // dependsOn is set on DLC entries
    if name.is_empty() || exe.is_empty() || !s("dependsOn").is_empty() {
        return None;
    }
    let cwd = if s("workingDir").is_empty() { s("path") } else { s("workingDir") };
    Some(Found { name, kind: "exe", target: exe, args: s("launchParam"), cwd, source: "gog", source_id: id.into() })
}

fn gog_items(games: &RegKey) -> Vec<Found> {
    games
        .enum_keys()
        .flatten()
        .filter_map(|id| gog_item(&id, &games.open_subkey(&id).ok()?))
        .collect()
}

fn gog() -> Vec<Found> {
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\WOW6432Node\\GOG.com\\Games")
        .map(|k| gog_items(&k))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACF: &str = "\"AppState\"\n{\n\t\"appid\"\t\t\"1422450\"\n\t\"name\"\t\t\"Dead\\\"lock\"\n\t\"StateFlags\"\t\t\"4\"\n\t\"InstalledDepots\"\n\t{\n\t\t\"1422451\"\n\t\t{\n\t\t\t\"name\"\t\t\"nested\"\n\t\t}\n\t}\n}\n";

    #[test]
    fn steam_acf() {
        let f = steam_item(ACF).unwrap();
        assert_eq!((f.name.as_str(), f.target.as_str(), f.source_id.as_str()), ("Dead\"lock", "steam://rungameid/1422450", "1422450"));
        assert!(steam_item(&ACF.replace("\"4\"", "\"2\"")).is_none(), "not fully installed");
        assert!(steam_item(&ACF.replace("1422450", "228980")).is_none(), "redistributables");
    }

    #[test]
    fn steam_libraries() {
        let vdf = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\Games\\\\SteamLibrary\"\n\t}\n}\n";
        let paths: Vec<_> = vdf_pairs(vdf).into_iter().filter(|(k, _)| k == "path").map(|(_, v)| v).collect();
        assert_eq!(paths, ["C:\\Program Files (x86)\\Steam", "D:\\Games\\SteamLibrary"]);
    }

    #[test]
    fn epic_manifest() {
        let j = r#"{"DisplayName":"Fortnite","AppName":"Fortnite","LaunchExecutable":"FortniteGame/x.exe","MainGameAppName":"","bIsIncompleteInstall":false}"#;
        let f = epic_item(j).unwrap();
        assert_eq!(f.target, "com.epicgames.launcher://apps/Fortnite?action=launch&silent=true");
        assert!(epic_item(&j.replace("\"MainGameAppName\":\"\"", "\"MainGameAppName\":\"Other\"")).is_none(), "dlc");
        assert!(epic_item(&j.replace("false", "true")).is_none(), "incomplete");
    }

    #[test]
    fn main_exe_skips_junk() {
        let d = env::temp_dir().join("launcher-main-exe-test");
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("Binaries/Win64")).unwrap();
        fs::create_dir_all(d.join("_CommonRedist")).unwrap();
        fs::write(d.join("Game.exe"), [0; 10]).unwrap();
        fs::write(d.join("Binaries/Win64/Game-Shipping.exe"), [0; 100]).unwrap();
        fs::write(d.join("UnityCrashHandler64.exe"), [0; 500]).unwrap();
        fs::write(d.join("_CommonRedist/vc_redist.x64.exe"), [0; 900]).unwrap();
        fs::write(d.join("big.dll"), [0; 900]).unwrap();
        let got = main_exe(&d);
        fs::remove_dir_all(&d).unwrap();
        assert_eq!(got, Some(d.join("Binaries/Win64/Game-Shipping.exe")));
    }

    #[test]
    fn gog_registry() {
        let root = RegKey::predef(HKEY_CURRENT_USER);
        let path = "Software\\LauncherTest\\Games";
        let (games, _) = root.create_subkey(path).unwrap();
        let (g, _) = games.create_subkey("1234").unwrap();
        g.set_value("gameName", &"Witcher").unwrap();
        g.set_value("exe", &"C:\\GOG\\w.exe").unwrap();
        g.set_value("path", &"C:\\GOG").unwrap();
        let (dlc, _) = games.create_subkey("5678").unwrap();
        dlc.set_value("gameName", &"Witcher DLC").unwrap();
        dlc.set_value("exe", &"C:\\GOG\\w.exe").unwrap();
        dlc.set_value("dependsOn", &"1234").unwrap();
        let found = gog_items(&games);
        root.delete_subkey_all("Software\\LauncherTest").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].name.as_str(), found[0].cwd.as_str()), ("Witcher", "C:\\GOG"));
    }
}

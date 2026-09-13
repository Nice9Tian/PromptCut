//! PromptCut Windows LPAC JSONL broker. User Python only ever travels as JSON.
use rappct::{
    AppContainerProfile, JobLimits, SecurityCapabilitiesBuilder,
    acl::{AccessMask, AceInheritance, ResourcePath, grant_to_package},
    launch::{LaunchOptions, LaunchedIo, StdioConfig, launch_in_container_with_io},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    env,
    ffi::OsString,
    fs::File,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::Duration,
};
const MAX: usize = 8 * 1024 * 1024;
const RO: AccessMask = AccessMask(0x0012_00A9);
const MAX_WORKERS: usize = 4;
fn emit(v: &Value) {
    let mut o = std::io::stdout();
    let _ = serde_json::to_writer(&mut o, v);
    let _ = o.write_all(b"\n");
    let _ = o.flush();
}
fn answer(r: &Value, body: Value) -> Value {
    json!({"id":r.get("id"),"revision":r.get("revision"),"ok":true,"result":body})
}
fn fail(r: &Value, c: &str, m: impl AsRef<str>) -> Value {
    json!({"id":r.get("id"),"revision":r.get("revision"),"ok":false,"error":{"code":c,"message":m.as_ref()}})
}
fn cp(v: &Value, n: &str) -> Result<PathBuf, String> {
    let p = std::fs::canonicalize(v.as_str().ok_or_else(|| format!("{n} must be a path"))?)
        .map_err(|e| format!("invalid {n}: {e}"))?;
    if !p.is_dir() {
        return Err(format!("{n} is not a directory"));
    }
    Ok(p)
}
fn overlap(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}
fn q(p: &Path) -> String {
    format!("\"{}\"", p.display())
}
fn h(s: &str) -> usize {
    let mut x: usize = 1469598103934665603;
    for b in s.bytes() {
        x ^= b as usize;
        x = x.wrapping_mul(1099511628211)
    }
    x
}
struct W {
    input: Mutex<File>,
    _child: LaunchedIo,
}
struct Scope {
    profile: AppContainerProfile,
    sid: String,
    grants: Vec<PathBuf>,
    roots: Vec<PathBuf>,
    workers: Vec<Option<Arc<W>>>,
    queues: Vec<VecDeque<Value>>,
    active: Vec<Option<String>>,
    runtime: PathBuf,
    temp: PathBuf,
    tx: mpsc::Sender<(String, Value)>,
    routes: HashMap<String, (usize, Value)>,
}
impl Scope {
    fn close(self) {
        drop(self.workers);
        for p in self.roots {
            let _ = std::process::Command::new("icacls")
                .arg(p)
                .arg("/remove")
                .arg(format!("*{}", self.sid))
                .arg("/T")
                .arg("/C")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        for p in self.grants {
            let _ = std::process::Command::new("icacls")
                .arg(p)
                .arg("/remove")
                .arg(format!("*{}", self.sid))
                .arg("/C")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        let _ = self.profile.delete();
    }
}
fn sanitize() {
    let root = env::var_os("SystemRoot").unwrap_or_else(|| OsString::from("C:\\Windows"));
    let user: Vec<_> = ["USERPROFILE", "LOCALAPPDATA", "APPDATA"]
        .into_iter()
        .filter_map(|k| env::var_os(k).map(|v| (k, v)))
        .collect();
    unsafe {
        for (k, _) in env::vars_os() {
            env::remove_var(k)
        }
        env::set_var("SystemRoot", &root);
        env::set_var("windir", &root);
        env::set_var("ComSpec", "C:\\Windows\\System32\\cmd.exe");
        env::set_var("PATHEXT", ".COM;.EXE;.BAT;.CMD");
        let runtime = std::env::current_dir().ok().and_then(|d| {
            std::fs::canonicalize(d.join("..\\..\\desktop\\src-tauri\\runtime\\python")).ok()
        });
        env::set_var(
            "PATH",
            match runtime {
                Some(p) => format!("C:\\Windows\\System32;{}", p.display()),
                None => "C:\\Windows\\System32".into(),
            },
        );
        env::set_var("TEMP", PathBuf::from(&root).join("Temp"));
        env::set_var("TMP", PathBuf::from(&root).join("Temp"));
        env::set_var("SystemDrive", "C:\\");
        for (k, v) in user {
            env::set_var(k, v)
        }
    }
}
fn ancestors(p: &Path, sid: &rappct::AppContainerSid, g: &mut Vec<PathBuf>) -> Result<(), String> {
    if let Some(d) = p.parent() {
        grant_to_package(
            ResourcePath::DirectoryCustom(d.to_path_buf(), AceInheritance::NONE),
            sid,
            RO,
        )
        .map_err(|e| e.to_string())?;
        g.push(d.to_path_buf());
    }
    Ok(())
}
fn worker(
    scope: &str,
    runtime: &Path,
    temp: &Path,
    caps: &rappct::SecurityCapabilities,
    tx: mpsc::Sender<(String, Value)>,
) -> Result<Arc<W>, String> {
    let py = runtime.join("python.exe");
    if !py.is_file() {
        return Err("runtimeDir lacks python.exe".into());
    }
    let opts = LaunchOptions {
        exe: py.clone(),
        cmdline: Some(format!(
            "{} -I -u -m promptcut_cards --temp-dir {}",
            q(&py),
            q(temp)
        )),
        cwd: Some(runtime.to_path_buf()),
        stdio: StdioConfig::Pipe,
        startup_timeout: Some(Duration::from_secs(15)),
        join_job: Some(JobLimits {
            memory_bytes: Some(512 * 1024 * 1024),
            cpu_rate_percent: None,
            kill_on_job_close: true,
        }),
        ..Default::default()
    };
    let mut c =
        launch_in_container_with_io(caps, &opts).map_err(|e| format!("LPAC launch failed: {e}"))?;
    let i = c.stdin.take().ok_or("worker stdin unavailable")?;
    let o = c.stdout.take().ok_or("worker stdout unavailable")?;
    if let Some(e) = c.stderr.take() {
        thread::spawn(move || {
            let mut r = BufReader::new(e);
            let mut sink = Vec::new();
            let _ = std::io::Read::read_to_end(&mut r, &mut sink);
        });
    }
    let s = scope.to_owned();
    thread::spawn(move || {
        let mut r = BufReader::new(o);
        let mut b = Vec::new();
        loop {
            b.clear();
            match r.by_ref().take((MAX + 1) as u64).read_until(b'\n', &mut b) {
                Ok(0) => break,
                Ok(n) if n <= MAX && b.last() == Some(&b'\n') => match serde_json::from_slice(&b) {
                    Ok(v) => {
                        let _ = tx.send((s.clone(), v));
                    }
                    Err(_) => {
                        let _=tx.send((s.clone(),json!({"type":"broker_error","error":{"code":"worker_protocol","message":"malformed worker JSON"}})));
                        break;
                    }
                },
                _ => {
                    let _=tx.send((s.clone(),json!({"type":"broker_error","error":{"code":"worker_protocol","message":"oversized worker reply"}})));
                    break;
                }
            }
        }
    });
    Ok(Arc::new(W {
        input: Mutex::new(i),
        _child: c,
    }))
}
fn opening(r: &Value, tx: mpsc::Sender<(String, Value)>) -> Result<Scope, String> {
    let p = r.get("payload").ok_or("missing payload")?;
    let rt = cp(&p["runtimeDir"], "runtimeDir")?;
    let out = cp(&p["outputDir"], "outputDir")?;
    let tmp = cp(&p["tempDir"], "tempDir")?;
    let ins = p["inputDirs"]
        .as_array()
        .ok_or("inputDirs must be an array")?
        .iter()
        .map(|x| cp(x, "inputDirs"))
        .collect::<Result<Vec<_>, _>>()?;
    if ins.len() > 128
        || overlap(&rt, &out)
        || overlap(&rt, &tmp)
        || overlap(&out, &tmp)
        || ins
            .iter()
            .any(|x| overlap(x, &rt) || overlap(x, &out) || overlap(x, &tmp))
    {
        return Err("authorization directories overlap".into());
    }
    let n = p.get("workers").and_then(Value::as_u64).unwrap_or(1) as usize;
    if n == 0 || n > MAX_WORKERS {
        return Err("workers must be 1 through 4".into());
    }
    let prof = AppContainerProfile::ensure(
        &format!(
            "PromptCut.CardRuntime.{}.{}",
            std::process::id(),
            h(r["scope"].as_str().unwrap_or(""))
        ),
        "PromptCut card worker",
        Some("ephemeral LPAC card scope"),
    )
    .map_err(|e| e.to_string())?;
    let sid = prof.sid.as_string().to_string();
    let mut roots = ins.clone();
    roots.extend([rt.clone(), out.clone(), tmp.clone()]);
    let mut g = Vec::new();
    let made = (|| {
        for x in ins.iter().chain([&rt, &out, &tmp]) {
            ancestors(x, &prof.sid, &mut g)?
        }
        grant_to_package(ResourcePath::Directory(rt.clone()), &prof.sid, RO)
            .map_err(|e| e.to_string())?;
        g.push(rt.clone());
        for x in &ins {
            grant_to_package(ResourcePath::Directory(x.clone()), &prof.sid, RO)
                .map_err(|e| e.to_string())?;
            g.push(x.clone())
        }
        for x in [&out, &tmp] {
            grant_to_package(
                ResourcePath::Directory(x.clone()),
                &prof.sid,
                AccessMask::GENERIC_ALL,
            )
            .map_err(|e| e.to_string())?;
            g.push(x.clone())
        }
        let caps = SecurityCapabilitiesBuilder::new(&prof.sid)
            .with_lpac_defaults()
            .build()
            .map_err(|e| e.to_string())?;
        let mut ws = Vec::new();
        for _ in 0..n {
            ws.push(worker(
                r["scope"].as_str().unwrap_or(""),
                &rt,
                &tmp,
                &caps,
                tx.clone(),
            )?)
        }
        Ok::<_, String>(ws)
    })();
    match made {
        Ok(workers) => Ok(Scope {
            profile: prof,
            sid,
            grants: g,
            roots: roots.clone(),
            workers: workers.into_iter().map(Some).collect(),
            queues: (0..n).map(|_| VecDeque::new()).collect(),
            active: (0..n).map(|_| None).collect(),
            runtime: rt,
            temp: tmp,
            tx,
            routes: HashMap::new(),
        }),
        Err(e) => {
            for x in &g {
                let mut c = std::process::Command::new("icacls");
                c.arg(x).arg("/remove").arg(format!("*{}", sid));
                if roots.contains(x) {
                    c.arg("/T");
                }
                let _ = c
                    .arg("/C")
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            }
            let _ = prof.delete();
            Err(e)
        }
    }
}
fn write_worker(s: &mut Scope, ix: usize, r: Value) -> Result<(), String> {
    if ix >= s.workers.len() {
        return Err("worker slot unavailable".into());
    }
    if s.active[ix].is_some() {
        s.queues[ix].push_back(r);
        return Ok(());
    }
    let w = s.workers[ix].as_ref().ok_or("worker slot unavailable")?;
    let b = serde_json::to_vec(&r).map_err(|_| "bad json")?;
    let mut i = w.input.lock().map_err(|_| "worker lock poisoned")?;
    i.write_all(&b)
        .and_then(|_| i.write_all(b"\n"))
        .and_then(|_| i.flush())
        .map_err(|e| e.to_string())?;
    let id = r
        .get("id")
        .and_then(Value::as_str)
        .ok_or("request id required")?
        .to_string();
    s.active[ix] = Some(id.clone());
    s.routes.insert(id, (ix, r));
    Ok(())
}
fn pump(s: &mut Scope, ix: usize) {
    if s.active[ix].is_none() {
        if let Some(r) = s.queues[ix].pop_front() {
            let _ = write_worker(s, ix, r);
        }
    }
}
fn main() {
    if rappct::supports_lpac().is_err() {
        for l in std::io::stdin().lock().lines() {
            if let Ok(r) = serde_json::from_str::<Value>(&l.unwrap_or_default()) {
                emit(&fail(&r, "isolation_unavailable", "Windows LPAC required"))
            }
        }
        return;
    }
    sanitize();
    let (htx, hrx) = mpsc::channel();
    let (etx, erx) = mpsc::channel::<(String, Value)>();
    thread::spawn(move || {
        let mut r = BufReader::new(std::io::stdin());
        let mut b = Vec::new();
        loop {
            b.clear();
            match r
                .by_ref()
                .take((MAX + 1) as u64)
                .read_until(b"\n"[0], &mut b)
            {
                Ok(0) => break,
                Ok(n) if n <= MAX && b.last() == Some(&b"\n"[0]) => {
                    if let Ok(v) = serde_json::from_slice(&b) {
                        let _ = htx.send(v);
                    }
                }
                _ => {}
            }
        }
    });
    let mut scopes = HashMap::<String, Scope>::new();
    loop {
        while let Ok((event_scope, v)) = erx.try_recv() {
            if v.get("type").and_then(Value::as_str) != Some("input") {
                if let Some(s) = scopes.get_mut(&event_scope) {
                    if let Some(id) = v.get("id").and_then(Value::as_str) {
                        if let Some((ix, _)) = s.routes.remove(id) {
                            s.active[ix] = None;
                            pump(s, ix);
                        }
                    }
                }
            }
            emit(&v)
        }
        let r = match hrx.recv_timeout(Duration::from_millis(20)) {
            Ok(v) => v,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => break,
        };
        if serde_json::to_vec(&r).map_or(true, |b| b.len() > MAX) {
            emit(&fail(
                &r,
                "message_too_large",
                "control message exceeds 8MB",
            ));
            continue;
        }
        let scope = match r["scope"].as_str() {
            Some(x) if !x.is_empty() => x.to_owned(),
            _ => {
                emit(&fail(&r, "bad_scope", "scope is required"));
                continue;
            }
        };
        match r["op"].as_str() {
            Some("open") => {
                if scopes.contains_key(&scope) {
                    emit(&fail(
                        &r,
                        "scope_exists",
                        "scope authorization is immutable",
                    ));
                    continue;
                }
                match opening(&r, etx.clone()) {
                    Ok(s) => {
                        scopes.insert(scope, s);
                        emit(&answer(&r, json!({})))
                    }
                    Err(e) => emit(&fail(&r, "isolation_startup", e)),
                }
            }
            Some("close") => {
                if let Some(s) = scopes.remove(&scope) {
                    s.close()
                }
                emit(&answer(&r, json!({})))
            }
            Some("cancel") => {
                let target = r
                    .pointer("/payload/id")
                    .or_else(|| r.pointer("/payload/requestId"))
                    .and_then(Value::as_str);
                match (scopes.get_mut(&scope), target) {
                    (Some(s), Some(id)) => {
                        if let Some((ix, _)) = s.routes.get(id).cloned() {
                            let dead = s.workers[ix].take();
                            drop(dead);
                            let doomed: Vec<Value> = s
                                .routes
                                .iter()
                                .filter(|(_, x)| x.0 == ix)
                                .map(|(_, x)| x.1.clone())
                                .collect();
                            s.routes.retain(|_, x| x.0 != ix);
                            s.queues[ix].clear();
                            s.active[ix] = None;
                            for q in doomed {
                                emit(&fail(&q, "card_cancelled", "worker job cancelled"))
                            }
                            if let Ok(c) = SecurityCapabilitiesBuilder::new(&s.profile.sid)
                                .with_lpac_defaults()
                                .build()
                            {
                                if let Ok(w) = worker(&scope, &s.runtime, &s.temp, &c, s.tx.clone())
                                {
                                    s.workers[ix] = Some(w)
                                }
                            }
                            emit(&answer(&r, json!({})))
                        } else {
                            emit(&fail(
                                &r,
                                "request_missing",
                                "request is not active in this scope",
                            ))
                        }
                    }
                    _ => emit(&fail(
                        &r,
                        "request_missing",
                        "cancel requires payload.id or requestId",
                    )),
                }
            }
            Some("inspect") | Some("evaluate") | Some("register") | Some("input_result") => {
                match scopes.get_mut(&scope) {
                    Some(s) => {
                        let id = r.get("id").and_then(Value::as_str).unwrap_or("");
                        let is_input = r["op"].as_str() == Some("input_result");
                        let ix = if is_input {
                            s.routes.get(id).map(|x| x.0)
                        } else {
                            let node = r
                                .pointer("/payload/nodeId")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            Some(h(node) % s.workers.len())
                        };
                        let ix = match ix {
                            Some(x) => x,
                            None => {
                                emit(&fail(
                                    &r,
                                    "request_missing",
                                    "input result has no active worker",
                                ));
                                continue;
                            }
                        };
                        if !is_input {
                            s.routes.insert(id.to_string(), (ix, r.clone()));
                        }
                        if is_input {
                            if let Some(w) = s.workers[ix].as_ref() {
                                let b = serde_json::to_vec(&r).unwrap();
                                if let Ok(mut i) = w.input.lock() {
                                    let _ = i
                                        .write_all(&b)
                                        .and_then(|_| i.write_all(b"\n"))
                                        .and_then(|_| i.flush());
                                }
                            } else {
                                emit(&fail(&r, "worker_io", "worker unavailable"))
                            }
                        } else if let Err(e) = write_worker(s, ix, r.clone()) {
                            emit(&fail(&r, "worker_io", e))
                        }
                    }
                    None => emit(&fail(&r, "scope_missing", "open scope first")),
                }
            }
            _ => emit(&fail(&r, "bad_op", "unsupported operation")),
        }
    }
    for (_, s) in scopes {
        s.close()
    }
}

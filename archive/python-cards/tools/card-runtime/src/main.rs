//! PromptCut Windows LPAC JSONL broker. User Python only ever travels as JSON.
use rappct::{
    AppContainerProfile, JobLimits, SecurityCapabilitiesBuilder,
    acl::{AccessMask, AceInheritance, ResourcePath, grant_to_package},
    launch::{LaunchOptions, LaunchedIo, StdioConfig, launch_in_container_with_io},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    ffi::OsString,
    fs::File,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};
#[cfg(windows)]
use windows::{
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
    },
    core::w,
};
const MAX: usize = 8 * 1024 * 1024;
const RO: AccessMask = AccessMask(0x0012_00A9);
const MAX_WORKERS: usize = 4;
const STDERR_TAIL: usize = 8192;
const ACL_TRANSACTION_TIMEOUT_MS: u32 = 30_000;
static NEXT_WORKER: AtomicU64 = AtomicU64::new(1);

// grant_to_package performs a read/modify/write of a filesystem DACL. Separate
// broker processes use different ephemeral SIDs but may share runtime/python,
// so their setup and exact-SID cleanup must not race each other.
#[cfg(windows)]
struct AclTransaction(HANDLE);
#[cfg(windows)]
impl AclTransaction {
    fn acquire() -> Result<Self, String> {
        unsafe {
            let handle = CreateMutexW(
                None,
                false,
                w!("Local\\PromptCut.CardRuntime.AclTransaction.v1"),
            )
            .map_err(|e| format!("create ACL transaction mutex: {e}"))?;
            let wait = WaitForSingleObject(handle, ACL_TRANSACTION_TIMEOUT_MS);
            // WAIT_OBJECT_0 and WAIT_ABANDONED both transfer ownership. An
            // abandoned prior owner is safe here because this process repeats
            // its own complete DACL transaction while holding the mutex.
            if wait.0 == 0 || wait.0 == 0x80 {
                Ok(Self(handle))
            } else if wait.0 == 0x102 {
                let _ = CloseHandle(handle);
                Err(format!(
                    "ACL transaction timed out after {ACL_TRANSACTION_TIMEOUT_MS}ms"
                ))
            } else {
                let _ = CloseHandle(handle);
                Err(format!("wait for ACL transaction mutex failed: {}", wait.0))
            }
        }
    }
}
#[cfg(windows)]
impl Drop for AclTransaction {
    fn drop(&mut self) {
        unsafe {
            let _ = ReleaseMutex(self.0);
            let _ = CloseHandle(self.0);
        }
    }
}
#[cfg(not(windows))]
struct AclTransaction;
#[cfg(not(windows))]
impl AclTransaction {
    fn acquire() -> Result<Self, String> {
        Err("Windows ACL transaction required".into())
    }
}
fn next_worker() -> u64 {
    NEXT_WORKER.fetch_add(1, Ordering::Relaxed)
}
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
    diagnostic: Arc<Mutex<String>>,
    _child: LaunchedIo,
}
struct Scope {
    profile: AppContainerProfile,
    sid: String,
    grants: Vec<PathBuf>,
    roots: Vec<PathBuf>,
    workers: Vec<Option<Arc<W>>>,
    generations: Vec<u64>,
    queues: Vec<VecDeque<Value>>,
    active: Vec<Option<String>>,
    runtime: PathBuf,
    temp: PathBuf,
    tx: mpsc::Sender<(String, u64, Value)>,
    routes: HashMap<String, (usize, Value)>,
}
impl Scope {
    fn close(self) -> Result<(), String> {
        // Do not allow another runner to read/modify/write an overlapping ACL
        // while this scope removes its exact SID and deletes its profile.
        let _transaction = AclTransaction::acquire()?;
        let Scope {
            profile,
            sid,
            grants,
            roots,
            workers,
            ..
        } = self;
        drop(workers);
        for p in &roots {
            let _ = std::process::Command::new("icacls")
                .arg(p)
                .arg("/remove")
                .arg(format!("*{sid}"))
                .arg("/T")
                .arg("/C")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        // Direct roots were already cleaned recursively above. Only clean
        // unique ancestor/direct grants that are not covered by that walk.
        for p in grants.into_iter().filter(|p| !roots.contains(p)) {
            let _ = std::process::Command::new("icacls")
                .arg(p)
                .arg("/remove")
                .arg(format!("*{sid}"))
                .arg("/C")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        profile.delete().map_err(|e| e.to_string())
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
        // The LPAC job limit is intentionally 512 MiB.  NumPy's BLAS backend
        // otherwise sizes its native pool from the host CPU count; reserved
        // worker stacks can consume the job's commit budget before a card
        // allocates even one 1080p float32 frame.  These are runner-owned,
        // fixed constants set before this process creates any threads.  They
        // are inherited by Python because LaunchOptions deliberately has no
        // caller-controlled environment override.
        for key in [
            "OPENBLAS_NUM_THREADS",
            "OMP_NUM_THREADS",
            "MKL_NUM_THREADS",
            "NUMEXPR_NUM_THREADS",
            "VECLIB_MAXIMUM_THREADS",
            "BLIS_NUM_THREADS",
        ] {
            env::set_var(key, "1");
        }
        for (k, v) in user {
            env::set_var(k, v)
        }
    }
}
fn push_unique(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}
fn ancestors(p: &Path, sid: &rappct::AppContainerSid, g: &mut Vec<PathBuf>) -> Result<(), String> {
    if let Some(d) = p.parent() {
        let d = d.to_path_buf();
        if !g.contains(&d) {
            grant_to_package(
                ResourcePath::DirectoryCustom(d.clone(), AceInheritance::NONE),
                sid,
                RO,
            )
            .map_err(|e| e.to_string())?;
            push_unique(g, d);
        }
    }
    Ok(())
}
fn worker(
    scope: &str,
    generation: u64,
    runtime: &Path,
    temp: &Path,
    caps: &rappct::SecurityCapabilities,
    tx: mpsc::Sender<(String, u64, Value)>,
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
    let diagnostic = Arc::new(Mutex::new(String::new()));
    if let Some(e) = c.stderr.take() {
        let diagnostic = diagnostic.clone();
        thread::spawn(move || {
            let mut r = BufReader::new(e);
            let mut chunk = [0_u8; 1024];
            loop {
                match r.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut tail) = diagnostic.lock() {
                            tail.push_str(&String::from_utf8_lossy(&chunk[..n]));
                            if tail.len() > STDERR_TAIL {
                                let bytes = tail.as_bytes();
                                let mut start = bytes.len() - STDERR_TAIL;
                                while start < bytes.len() && !tail.is_char_boundary(start) {
                                    start += 1;
                                }
                                *tail = tail[start..].to_owned();
                            }
                        }
                    }
                }
            }
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
                        let _ = tx.send((s.clone(), generation, v));
                    }
                    Err(_) => {
                        let _ = tx.send((
                            s.clone(),
                            generation,
                            json!({"type":"worker_dead","reason":"malformed worker JSON"}),
                        ));
                        break;
                    }
                },
                _ => {
                    let _ = tx.send((
                        s.clone(),
                        generation,
                        json!({"type":"worker_dead","reason":"oversized worker reply"}),
                    ));
                    break;
                }
            }
        }
        let _ = tx.send((
            s,
            generation,
            json!({"type":"worker_dead","reason":"worker stdout closed"}),
        ));
    });
    Ok(Arc::new(W {
        input: Mutex::new(i),
        diagnostic,
        _child: c,
    }))
}
fn opening(r: &Value, tx: mpsc::Sender<(String, u64, Value)>) -> Result<Scope, String> {
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
    let mut unique_ins = Vec::new();
    for input in ins {
        push_unique(&mut unique_ins, input);
    }
    let ins = unique_ins;
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
    // This guard covers every DACL/profile mutation and initial worker launch.
    // It deliberately drops when open returns: Python evaluation never holds it.
    let _transaction = AclTransaction::acquire()?;
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
    let mut roots = Vec::new();
    for path in ins.iter().chain([&rt, &out, &tmp]) {
        push_unique(&mut roots, path.clone());
    }
    let mut g = Vec::new();
    let made = (|| {
        for x in ins.iter().chain([&rt, &out, &tmp]) {
            ancestors(x, &prof.sid, &mut g)?
        }
        grant_to_package(ResourcePath::Directory(rt.clone()), &prof.sid, RO)
            .map_err(|e| e.to_string())?;
        push_unique(&mut g, rt.clone());
        for x in &ins {
            grant_to_package(ResourcePath::Directory(x.clone()), &prof.sid, RO)
                .map_err(|e| e.to_string())?;
            push_unique(&mut g, x.clone())
        }
        for x in [&out, &tmp] {
            grant_to_package(
                ResourcePath::Directory(x.clone()),
                &prof.sid,
                AccessMask::GENERIC_ALL,
            )
            .map_err(|e| e.to_string())?;
            push_unique(&mut g, x.clone())
        }
        let caps = SecurityCapabilitiesBuilder::new(&prof.sid)
            .with_lpac_defaults()
            .build()
            .map_err(|e| e.to_string())?;
        let mut ws = Vec::new();
        let mut generations = Vec::new();
        for _ in 0..n {
            let generation = next_worker();
            ws.push(worker(
                r["scope"].as_str().unwrap_or(""),
                generation,
                &rt,
                &tmp,
                &caps,
                tx.clone(),
            )?);
            generations.push(generation)
        }
        Ok::<_, String>((ws, generations))
    })();
    match made {
        Ok((workers, generations)) => Ok(Scope {
            profile: prof,
            sid,
            grants: g,
            roots: roots.clone(),
            workers: workers.into_iter().map(Some).collect(),
            generations,
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
fn fail_queue(s: &mut Scope, ix: usize, code: &str, message: &str) -> Vec<Value> {
    let mut failed = Vec::new();
    while let Some(request) = s.queues[ix].pop_front() {
        if let Some(id) = request.get("id").and_then(Value::as_str) {
            s.routes.remove(id);
        }
        failed.push(fail(&request, code, message));
    }
    failed
}
fn pump(s: &mut Scope, ix: usize) -> Vec<Value> {
    let mut failed = Vec::new();
    if s.active[ix].is_none() {
        if let Some(r) = s.queues[ix].pop_front() {
            if let Err(e) = write_worker(s, ix, r.clone()) {
                if let Some(id) = r.get("id").and_then(Value::as_str) {
                    s.routes.remove(id);
                }
                failed.push(fail(&r, "worker_write", &e));
                // A dispatch write means this slot cannot safely accept the
                // remaining FIFO.  Do not recursively restart here: a new
                // external request gets one bounded replacement attempt.
                let old = s.workers[ix].take();
                drop(old);
                s.generations[ix] = next_worker();
                failed.extend(fail_queue(
                    s,
                    ix,
                    "worker_write",
                    "worker pipe write failed",
                ));
            }
        }
    }
    failed
}
fn recover_worker(s: &mut Scope, scope: &str, ix: usize) -> Result<(), String> {
    if ix >= s.workers.len() {
        return Err("worker slot unavailable".into());
    }
    // Advance before dropping the old job.  Its reader may still report EOF,
    // but generation matching below makes that late event harmless.
    let generation = next_worker();
    s.generations[ix] = generation;
    let old = s.workers[ix].take();
    drop(old);
    let caps = SecurityCapabilitiesBuilder::new(&s.profile.sid)
        .with_lpac_defaults()
        .build()
        .map_err(|e| e.to_string())?;
    let w = worker(scope, generation, &s.runtime, &s.temp, &caps, s.tx.clone())?;
    s.workers[ix] = Some(w);
    Ok(())
}
fn worker_dead(s: &mut Scope, scope: &str, ix: usize, generation: u64, reason: &str) -> Vec<Value> {
    if ix >= s.workers.len() || s.generations[ix] != generation {
        return Vec::new();
    }
    let detail = s.workers[ix]
        .as_ref()
        .and_then(|w| w.diagnostic.lock().ok().map(|x| x.clone()));
    let message = match detail.filter(|x| !x.trim().is_empty()) {
        Some(stderr) => format!("{reason}: {}", stderr.trim()),
        None => reason.to_owned(),
    };
    let mut failed = Vec::new();
    if let Some(id) = s.active[ix].take() {
        if let Some((_, request)) = s.routes.remove(&id) {
            failed.push(fail(&request, "worker_exited", &message));
        }
    }
    // A dead job never receives queued work.  Keep its FIFO entries and their
    // request routes for the replacement; only the request actually executing
    // at the crash boundary is failed, never replayed.
    let should_restart = !failed.is_empty() || !s.queues[ix].is_empty();
    if should_restart && recover_worker(s, scope, ix).is_ok() {
        failed.extend(pump(s, ix));
    } else if !should_restart {
        // EOF while idle must not create an unbounded respawn loop.  A later
        // incoming request can make exactly one replacement attempt.
        let old = s.workers[ix].take();
        drop(old);
        s.generations[ix] = next_worker();
    } else {
        failed.extend(fail_queue(
            s,
            ix,
            "worker_restart_failed",
            "LPAC worker could not be restarted",
        ));
    }
    failed
}
const MAX_SCOPES: usize = 4;
const MAX_LIFECYCLE_JOBS: usize = 8;
enum LifecycleJob {
    Open {
        request: Value,
        scope: String,
    },
    Close {
        request: Value,
        scope: String,
        state: Scope,
    },
}
enum LifecycleDone {
    Open {
        request: Value,
        scope: String,
        result: Result<Scope, String>,
    },
    Close {
        request: Value,
        scope: String,
        result: Result<(), String>,
    },
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
    let (etx, erx) = mpsc::channel::<(String, u64, Value)>();
    let (lifecycle_tx, lifecycle_rx) = mpsc::sync_channel::<LifecycleJob>(MAX_LIFECYCLE_JOBS);
    let (done_tx, done_rx) = mpsc::channel::<LifecycleDone>();
    let lifecycle_events = etx.clone();
    let lifecycle_thread = thread::spawn(move || {
        while let Ok(job) = lifecycle_rx.recv() {
            match job {
                LifecycleJob::Open { request, scope } => {
                    let result = opening(&request, lifecycle_events.clone());
                    let _ = done_tx.send(LifecycleDone::Open {
                        request,
                        scope,
                        result,
                    });
                }
                LifecycleJob::Close {
                    request,
                    scope,
                    state,
                } => {
                    let result = state.close();
                    let _ = done_tx.send(LifecycleDone::Close {
                        request,
                        scope,
                        result,
                    });
                }
            }
        }
    });
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
    let mut pending_scopes = HashSet::<String>::new();
    loop {
        while let Ok(done) = done_rx.try_recv() {
            match done {
                LifecycleDone::Open {
                    request,
                    scope,
                    result,
                } => {
                    pending_scopes.remove(&scope);
                    match result {
                        Ok(state) => {
                            scopes.insert(scope, state);
                            emit(&answer(&request, json!({})));
                        }
                        Err(e) => emit(&fail(&request, "isolation_startup", e)),
                    }
                }
                LifecycleDone::Close {
                    request,
                    scope,
                    result,
                } => {
                    pending_scopes.remove(&scope);
                    match result {
                        Ok(()) => emit(&answer(&request, json!({}))),
                        Err(e) => emit(&fail(&request, "acl_cleanup", e)),
                    }
                }
            }
        }
        while let Ok((event_scope, generation, v)) = erx.try_recv() {
            let mut emit_event = true;
            let mut failures = Vec::new();
            if let Some(s) = scopes.get_mut(&event_scope) {
                if v.get("type").and_then(Value::as_str) == Some("worker_dead") {
                    if let Some(ix) = s.generations.iter().position(|x| *x == generation) {
                        failures = worker_dead(
                            s,
                            &event_scope,
                            ix,
                            generation,
                            v.get("reason")
                                .and_then(Value::as_str)
                                .unwrap_or("worker exited"),
                        );
                    }
                    emit_event = false;
                } else if let Some(id) = v.get("id").and_then(Value::as_str) {
                    let route = s.routes.get(id).cloned();
                    if let Some((ix, _)) = route {
                        // A replaced worker may have a late reply in its pipe.
                        // Do not let it complete an identically routed new job.
                        if s.generations[ix] != generation {
                            emit_event = false;
                        } else if v.get("type").and_then(Value::as_str) != Some("input") {
                            s.routes.remove(id);
                            s.active[ix] = None;
                            failures.extend(pump(s, ix));
                        }
                    } else {
                        emit_event = false;
                    }
                }
            } else {
                emit_event = false;
            }
            for failure in failures {
                emit(&failure);
            }
            if emit_event {
                emit(&v)
            }
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
                if scopes.contains_key(&scope) || pending_scopes.contains(&scope) {
                    emit(&fail(
                        &r,
                        "scope_exists",
                        "scope authorization is immutable",
                    ));
                    continue;
                }
                if scopes.len() + pending_scopes.len() >= MAX_SCOPES {
                    emit(&fail(
                        &r,
                        "scope_capacity",
                        "at most four scopes may be admitted",
                    ));
                    continue;
                }
                match lifecycle_tx.try_send(LifecycleJob::Open {
                    request: r.clone(),
                    scope: scope.clone(),
                }) {
                    Ok(()) => {
                        pending_scopes.insert(scope);
                    }
                    Err(mpsc::TrySendError::Full(_)) => {
                        emit(&fail(&r, "lifecycle_busy", "scope lifecycle queue is full"))
                    }
                    Err(mpsc::TrySendError::Disconnected(_)) => emit(&fail(
                        &r,
                        "lifecycle_unavailable",
                        "scope lifecycle worker stopped",
                    )),
                }
            }
            Some("close") => {
                if let Some(s) = scopes.remove(&scope) {
                    pending_scopes.insert(scope.clone());
                    match lifecycle_tx.try_send(LifecycleJob::Close {
                        request: r.clone(),
                        scope: scope.clone(),
                        state: s,
                    }) {
                        Ok(()) => {}
                        Err(mpsc::TrySendError::Full(LifecycleJob::Close { state, .. })) => {
                            pending_scopes.remove(&scope);
                            scopes.insert(scope, state);
                            emit(&fail(&r, "lifecycle_busy", "scope lifecycle queue is full"));
                        }
                        Err(mpsc::TrySendError::Disconnected(LifecycleJob::Close {
                            state,
                            ..
                        })) => {
                            pending_scopes.remove(&scope);
                            scopes.insert(scope, state);
                            emit(&fail(
                                &r,
                                "lifecycle_unavailable",
                                "scope lifecycle worker stopped",
                            ));
                        }
                        Err(_) => unreachable!(),
                    }
                } else if pending_scopes.contains(&scope) {
                    emit(&fail(&r, "scope_busy", "scope lifecycle is pending"))
                } else {
                    emit(&answer(&r, json!({})))
                }
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
                            let _ = recover_worker(s, &scope, ix);
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
                        if !is_input && s.workers[ix].is_none() {
                            if let Err(e) = recover_worker(s, &scope, ix) {
                                emit(&fail(&r, "worker_restart_failed", e));
                                continue;
                            }
                        }
                        if !is_input {
                            s.routes.insert(id.to_string(), (ix, r.clone()));
                        }
                        if is_input {
                            let write_error = if let Some(w) = s.workers[ix].as_ref() {
                                let b = serde_json::to_vec(&r).unwrap();
                                match w.input.lock() {
                                    Ok(mut i) => i
                                        .write_all(&b)
                                        .and_then(|_| i.write_all(b"\n"))
                                        .and_then(|_| i.flush())
                                        .err()
                                        .map(|e| e.to_string()),
                                    Err(_) => Some("worker input lock poisoned".into()),
                                }
                            } else {
                                Some("worker unavailable".into())
                            };
                            if let Some(reason) = write_error {
                                let generation = s.generations[ix];
                                for failure in worker_dead(
                                    s,
                                    &scope,
                                    ix,
                                    generation,
                                    &format!("worker pipe write failed: {reason}"),
                                ) {
                                    emit(&failure);
                                }
                            }
                        } else if let Err(e) = write_worker(s, ix, r.clone()) {
                            // The route was registered above so cancel can see queued work.
                            // A failed direct write has no active slot yet; fail it explicitly,
                            // replace the dead slot, and never retry user code implicitly.
                            s.routes.remove(id);
                            let generation = s.generations[ix];
                            for failure in worker_dead(
                                s,
                                &scope,
                                ix,
                                generation,
                                &format!("worker pipe write failed: {e}"),
                            ) {
                                emit(&failure);
                            }
                            emit(&fail(&r, "worker_write", e))
                        }
                    }
                    None => emit(&fail(&r, "scope_missing", "open scope first")),
                }
            }
            _ => emit(&fail(&r, "bad_op", "unsupported operation")),
        }
    }
    drop(lifecycle_tx);
    while let Ok(done) = done_rx.recv() {
        if let LifecycleDone::Open { result, .. } = done {
            if let Ok(scope) = result {
                let _ = scope.close();
            }
        }
    }
    let _ = lifecycle_thread.join();
    for (_, s) in scopes {
        let _ = s.close();
    }
}

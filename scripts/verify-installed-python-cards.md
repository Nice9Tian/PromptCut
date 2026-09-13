# Installed Python-card acceptance

This harness never builds, installs, starts PromptCut, launches Chrome, or reads API keys/configuration. First create the protected copy:

```powershell
node scripts/verify-installed-python-cards.mjs --prepare-only --exe 'C:\Path\PromptCut.exe' --project 'C:\Path\original.pcproj' --out '.\work\installed-card-evidence'
```

It prints `copy`. Start the installed desktop app with its existing WebView2 remote-debugging port **and launch/open that exact copy**. The run phase checks the launch URL, the product's displayed filename and project ID against that copy. It asks the real Harness Agent to author and apply effects, saves through the installed product's `saveDraft` entry point, and reopens that persisted draft through the normal Shell route:

```powershell
node scripts/verify-installed-python-cards.mjs --exe 'C:\Path\PromptCut.exe' --project 'C:\Path\original.pcproj' --copy '.\work\installed-card-evidence\original.acceptance-copy.pcproj' --out '.\work\installed-card-evidence' --cdp 9222 --provider api
```

`--origin` defaults to `http://127.0.0.1:5210`. The server must already be the installed app's server. It hashes the original before and after, writes the redacted SSE trace incrementally, and retains errors even when acceptance fails. Playback is measured by actual canvas frame presentation over ten seconds after clicking the existing Play button. Passing requires at least 80% of project frame rate, fewer than 5% blank samples, and no presentation gap of 300 ms or longer after a two-second warmup. A moving playhead alone is insufficient. The script then clicks Pause and disconnects from CDP.

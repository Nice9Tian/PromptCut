# Installed Python-card acceptance

This harness never builds, installs, starts PromptCut, launches Chrome, or reads API keys/configuration. First create the protected copy:

```powershell
node scripts/verify-installed-python-cards.mjs --prepare-only --exe 'C:\Path\PromptCut.exe' --project 'C:\Path\original.pcproj' --out '.\work\installed-card-evidence'
```

It prints `copy`. Start the installed desktop app yourself with its existing WebView2 remote-debugging port **and launch/open that exact copy**. The run phase reads the product's actual editor store through the already-running page and fails unless `filePath` equals `--copy`; it then sends Ctrl+S through the UI, then runs:

```powershell
node scripts/verify-installed-python-cards.mjs --exe 'C:\Path\PromptCut.exe' --project 'C:\Path\original.pcproj' --copy '.\work\installed-card-evidence\original.acceptance-copy.pcproj' --out '.\work\installed-card-evidence' --cdp 9222 --provider agy
```

`--origin` defaults to `http://127.0.0.1:5210`. The server must already be the installed app's server. It hashes the original before and after, records a redacted SSE trace and UI metadata, explicitly clicks the existing Play button, samples playback for at least ten seconds, then clicks Pause. A stationary/missing playhead is a failure, never a pass.

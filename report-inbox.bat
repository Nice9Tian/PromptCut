@echo off
rem PromptCut - diagnostic report inbox (GUI).
rem Double-click to run. First run builds the exe, after that it just opens.
rem
rem Keep this file ASCII-only: cmd.exe parses .bat with the OEM codepage
rem (GBK on this machine), so UTF-8 Chinese here corrupts the parsing.
rem The GUI itself is in Chinese - only these fallback messages are English.
setlocal

set "ROOT=%~dp0"
set "CRATE=%ROOT%tools\report-inbox-gui"
set "EXE=%CRATE%\target\release\report-inbox-gui.exe"

if exist "%EXE%" goto run

echo Building the report inbox (first run only, takes a minute or two)...
where cargo >nul 2>nul
if errorlevel 1 goto nocargo
pushd "%CRATE%"
cargo build --release
set "BUILD_FAILED=%errorlevel%"
popd
if not "%BUILD_FAILED%"=="0" goto buildfail
if not exist "%EXE%" goto buildfail

:run
start "" "%EXE%"
exit /b 0

:nocargo
echo.
echo cargo not found. Install Rust first: https://rustup.rs
echo Then open a new terminal and double-click this file again.
pause
exit /b 1

:buildfail
echo.
echo Build failed. Run "cargo build --release" in:
echo   %CRATE%
echo to see the actual error.
pause
exit /b 1

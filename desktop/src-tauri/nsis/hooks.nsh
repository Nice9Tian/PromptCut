; NSIS uninstall hook for PromptCut
;
; Only remove build-time caches that vite/rolldown create at runtime.
; Do NOT delete the entire runtime/ tree — the user may have placed
; custom assets there.
; Do NOT touch %APPDATA% directories (pylibs, models) — those hold
; user-downloaded engines and models; the "Reset Python Libraries" menu
; item is the only intended way to clear them.

!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$INSTDIR\runtime\app\node_modules\.vite"
  RMDir /r "$INSTDIR\runtime\app\node_modules\.vite-temp"
  RMDir /r "$INSTDIR\runtime\app\dist"
  RMDir /r "$INSTDIR\runtime\app\out"
!macroend

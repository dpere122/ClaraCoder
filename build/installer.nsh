; Custom NSIS hooks, included by electron-builder (electron-builder.yml `nsis.include`).
;
; "Restart and install" runs the installer with `--updated` but without `/S`. The assisted
; installer then skips its license, install-mode and directory pages for an update, so the
; first thing the user sees is the progress page while the files are replaced.
;
; customFinishPage replaces electron-builder's default Finish page (assistedInstaller.nsh):
; - Updates skip the page and relaunch the app straight away. `--force-run` only works for
;   silent assisted installs, so the relaunch has to happen here.
; - Fresh installs keep the usual Finish page with its "Run Clara Coder" checkbox.
;
; Don't use electron-builder's StartApp macro here: it declares `Var /GLOBAL startAppArgs`,
; and installSection.nsh already inserts it once, so a second insert won't compile.

!macro customFinishPage
  Function ClaraFinishPagePre
    ${if} ${isUpdated}
      ; ExecShellAsUser, so an elevated (per-machine) update doesn't start the app elevated.
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
      ; Aborting the last page's pre function ends the installer.
      Abort
    ${endif}
  FunctionEnd

  Function ClaraFinishPageRun
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE ClaraFinishPagePre
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION ClaraFinishPageRun
  !insertmacro MUI_PAGE_FINISH
!macroend

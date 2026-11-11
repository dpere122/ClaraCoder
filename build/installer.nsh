; Custom NSIS hooks, included by electron-builder (electron-builder.yml `nsis.include`).
;
; "Restart and install" runs the installer with `--updated` but without `/S`. The assisted
; installer skips its license and directory pages for an update by itself; customInstallMode
; below skips the "Installation Options" (per-user / per-machine) page too, so the first
; thing the user sees is the progress page while the files are replaced.
;
; customInstallMode runs at the top of the install-mode page's pre function. That page is
; only skipped for `/currentuser`, `/allusers` or a forced mode, not for `--updated`. On an
; update, force the mode of the existing install, which initMultiUser already found in the
; registry. When both a per-user and a per-machine install exist, the page still shows so
; the user picks which one to update. A per-machine update elevates itself if it needs to.
;
; customFinishPage replaces electron-builder's default Finish page (assistedInstaller.nsh):
; - Updates skip the page and relaunch the app straight away. `--force-run` only works for
;   silent assisted installs, so the relaunch has to happen here.
; - Fresh installs keep the usual Finish page with its "Run Clara Coder" checkbox.
;
; Don't use electron-builder's StartApp macro here: it declares `Var /GLOBAL startAppArgs`,
; and installSection.nsh already inserts it once, so a second insert won't compile.

!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ${if} ${isUpdated}
      ${if} $hasPerUserInstallation == "1"
      ${andIf} $hasPerMachineInstallation == "0"
        StrCpy $isForceCurrentInstall "1"
      ${elseIf} $hasPerUserInstallation == "0"
      ${andIf} $hasPerMachineInstallation == "1"
        StrCpy $isForceMachineInstall "1"
      ${endIf}
    ${endIf}
  !endif
!macroend

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

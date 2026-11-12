; Veyra Study installer additions (electron-builder "nsis.include").

; Removes Android plug-in files that Veyra 0.2.6 to 0.2.8 shipped by mistake.
; Their paths were so deep that the old version's uninstaller couldn't move
; them aside during an upgrade (Windows' 260-character path limit), so every
; update failed with "Failed to uninstall old application files ... : 2" or
; "Veyra Study cannot be closed". They're never used by the app.
!macro veyraRemoveLeftovers DIR
  ${if} "${DIR}" != ""
    RMDir /r "${DIR}\resources\app.asar.unpacked\node_modules\@capacitor"
  ${endif}
!macroend

!macro customInit
  ; 1. Close every running copy of this app (Veyra Study, or Veyra Study Dev for a Dev build): the window, the copy waiting in
  ;    the tray, and any AI-app helper (MCP bridge) started from the same exe,
  ;    so Windows lets go of the old files.
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 1200

  ; 2. Clear the leftovers from wherever the old version is installed.
  ReadRegStr $1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  !insertmacro veyraRemoveLeftovers "$1"
  ReadRegStr $1 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  !insertmacro veyraRemoveLeftovers "$1"
  !insertmacro veyraRemoveLeftovers "$INSTDIR"
!macroend

; Colax Native (Rust edition) — per-user installer.
;
; Installs ALONGSIDE the Electron Colax app, never into it. This edition writes
; an exe called colax.exe; Windows paths are case-insensitive, so installing
; into the Electron app's folder (%LOCALAPPDATA%\Programs\colax) would overwrite
; its Colax.exe and destroy that installation. The guard below refuses any
; folder that carries the Electron payload, and every name here (folder, exe,
; shortcuts, uninstall key, Run value) is distinct from every other Colax
; edition on this machine.
;
; Built by packaging\build-setup.ps1, which passes PRODUCT_VERSION and APP_EXE.

!include "MUI2.nsh"

!ifndef PRODUCT_VERSION
  !error "PRODUCT_VERSION is not defined - run build-setup.ps1"
!endif
!ifndef APP_EXE
  !error "APP_EXE is not defined - run build-setup.ps1"
!endif

Name "Colax Native"
OutFile "..\Colax Rust Setup ${PRODUCT_VERSION}.exe"
; Sibling of the other editions, not inside Program Files\colax.
InstallDir "$LOCALAPPDATA\Colax Native"
InstallDirRegKey HKCU "Software\Colax Native" "InstallDir"
RequestExecutionLevel user
Unicode True
SetCompressor /SOLID lzma

VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey "ProductName" "Colax Native"
VIAddVersionKey "FileDescription" "Colax Native installer (Rust edition)"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "CompanyName" "iraveos"
VIAddVersionKey "LegalCopyright" "iraveos"

!define MUI_ICON "..\assets\icon.ico"
!define MUI_UNICON "..\assets\icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\colax.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Colax Native"

; An install that is already on this machine is upgraded in place; asking for
; a folder again is how people end up with two copies and an old one still in
; the Start menu.
!define MUI_PAGE_CUSTOMFUNCTION_PRE DirectoryPre
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; The directory page calls this as the user browses. Abort greys out Next, so a
; folder holding the Electron app cannot be chosen in the first place.
Function DirectoryPre
  ReadRegStr $0 HKCU "Software\Colax Native" "InstallDir"
  StrCmp $0 "" 0 upgrade_in_place
  Return
  upgrade_in_place:
    StrCpy $INSTDIR $0
    Abort
FunctionEnd

Function .onVerifyInstDir
  IfFileExists "$INSTDIR\resources\app.asar" 0 +1
  Abort
  IfFileExists "$INSTDIR\LICENSE.electron.txt" 0 +1
  Abort
  IfFileExists "$INSTDIR\resources.pak" 0 +1
  Abort
FunctionEnd

Section "Colax Native" SecInstall
  ; Shortcuts and registry entries belong to the signed-in user, matching the
  ; per-user install directory.
  SetShellVarContext current

  ; Same guard as the directory page, for /S installs that skip it. Silent runs
  ; set an error level instead of showing a box nobody can see.
  IfFileExists "$INSTDIR\resources\app.asar" guard_fail 0
  IfFileExists "$INSTDIR\LICENSE.electron.txt" guard_fail 0
  IfFileExists "$INSTDIR\resources.pak" guard_fail 0
  Goto guard_pass
  guard_fail:
    IfSilent guard_quiet
    MessageBox MB_ICONSTOP "That folder already contains the Colax desktop app. Choose a different folder — Colax Native installs alongside it, and writing here would overwrite the other app."
    guard_quiet:
    SetErrorLevel 2
    Abort
  guard_pass:

  ; Windows will not replace the exe of a running program, and that is what
  ; made updates impossible: NSIS reported "Error opening file for writing" and
  ; the install was rolled back, still on the old version.
  ;
  ; Here the file is tested for writing. In UI mode the setup waits for the user
  ; to close the app and retries, instead of failing. A silent run cannot ask, so
  ; it parks the old exe and installs anyway -- the running copy keeps working
  ; until it is closed, and the next launch is the new version.
  IfFileExists "$INSTDIR\colax.exe" 0 write_exe
  retry_write:
    ClearErrors
    FileOpen $2 "$INSTDIR\colax.exe" a
    IfErrors 0 writable
    IfSilent park_old_exe
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Colax Native is running.$\r$\nClose it, then click Retry to finish the update." IDRETRY retry_write
    SetErrorLevel 4
    Abort
  park_old_exe:
    Delete "$INSTDIR\colax.exe.old"
    Rename "$INSTDIR\colax.exe" "$INSTDIR\colax.exe.old"
    Delete /REBOOTOK "$INSTDIR\colax.exe.old"
    Goto write_exe
  writable:
    FileClose $2
  write_exe:

  SetOutPath $INSTDIR
  File "${APP_EXE}"
  ; Shipped next to the exe so shortcuts keep their icon even if the installer
  ; file itself is deleted.
  File "..\assets\icon.ico"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; A folder of its own in the Start menu, so nothing here shares a name with
  ; the Electron build's shortcuts.
  CreateDirectory "$SMPROGRAMS\Colax Native"
  CreateShortcut "$SMPROGRAMS\Colax Native\Colax Native.lnk" "$INSTDIR\colax.exe" "" "$INSTDIR\icon.ico" 0
  CreateShortcut "$SMPROGRAMS\Colax Native\Uninstall Colax Native.lnk" "$INSTDIR\uninstall.exe"
  CreateShortcut "$DESKTOP\Colax Native.lnk" "$INSTDIR\colax.exe" "" "$INSTDIR\icon.ico" 0

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Colax Native" \
    "DisplayName" "Colax Native (Rust edition)"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Colax Native" \
    "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Colax Native" \
    "Publisher" "iraveos"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Colax Native" \
    "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Colax Native" \
    "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Colax Native" \
    "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Colax Native" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Colax Native" "NoRepair" 1
  WriteRegStr HKCU "Software\Colax Native" "InstallDir" "$INSTDIR"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ; %APPDATA%\Colax Native holds this edition's vault. The Electron app's data
  ; (%APPDATA%\colax) is never touched by either half of this script.
  Delete "$INSTDIR\colax.exe"
  Delete "$INSTDIR\icon.ico"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  Delete "$SMPROGRAMS\Colax Native\Colax Native.lnk"
  Delete "$SMPROGRAMS\Colax Native\Uninstall Colax Native.lnk"
  RMDir "$SMPROGRAMS\Colax Native"
  Delete "$DESKTOP\Colax Native.lnk"

  ; The sign-in entry this app can create belongs to this install only.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ColaxNative"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Colax Native"
  DeleteRegKey HKCU "Software\Colax Native"
SectionEnd

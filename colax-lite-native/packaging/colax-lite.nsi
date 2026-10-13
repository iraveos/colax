; Colax Lite (native) installer.
;
; Mirrors the Tauri build's NSIS settings from tauri.conf.json: per-user
; install (no elevation), English only, no language selector. Built by
; packaging\build-installer.ps1, which passes PRODUCT_VERSION and APP_EXE.

!include "MUI2.nsh"

!ifndef PRODUCT_VERSION
  !error "PRODUCT_VERSION is not defined - run build-installer.ps1"
!endif
!ifndef APP_EXE
  !error "APP_EXE is not defined - run build-installer.ps1"
!endif

Name "Colax Lite"
OutFile "..\Colax Lite Setup ${PRODUCT_VERSION}.exe"
InstallDir "$LOCALAPPDATA\Colax Lite"
InstallDirRegKey HKCU "Software\Colax Lite" "InstallDir"
RequestExecutionLevel user
Unicode True

!define MUI_ICON "..\app\colax-lite\assets\icon.ico"
!define MUI_UNICON "..\app\colax-lite\assets\icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\colax-lite.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Colax Lite"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_INSTFILES

; The Tauri config pins languages: ["English"] with the selector off —
; this is the same pair, expressed as NSIS's one supported language.
!insertmacro MUI_LANGUAGE "English"

Section "Colax Lite"
  SetOutPath $INSTDIR
  File "${APP_EXE}"

  ; No elevation, no services: the app and its uninstaller are the payload.
  WriteUninstaller "$INSTDIR\uninstall.exe"

  CreateDirectory "$SMPROGRAMS\Colax Lite"
  CreateShortcut "$SMPROGRAMS\Colax Lite\Colax Lite.lnk" "$INSTDIR\colax-lite.exe"
  CreateShortcut "$DESKTOP\Colax Lite.lnk" "$INSTDIR\colax-lite.exe"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Colax Lite" \
    "DisplayName" "Colax Lite"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Colax Lite" \
    "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Colax Lite" \
    "Publisher" "iraveos"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Colax Lite" \
    "DisplayIcon" "$INSTDIR\colax-lite.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Colax Lite" \
    "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "Software\Colax Lite" "InstallDir" "$INSTDIR"
SectionEnd

Section "Uninstall"
  ; The vault and shell state live in %APPDATA%\app.colax.lite and are
  ; deliberately left behind — uninstalling the program must not delete
  ; the user's passwords.
  Delete "$INSTDIR\colax-lite.exe"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  Delete "$SMPROGRAMS\Colax Lite\Colax Lite.lnk"
  RMDir "$SMPROGRAMS\Colax Lite"
  Delete "$DESKTOP\Colax Lite.lnk"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Colax Lite"
  DeleteRegKey HKCU "Software\Colax Lite"
SectionEnd

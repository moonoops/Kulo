; Kulo per-user Windows NSIS installer (zero UAC elevation required)
Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!ifndef APP_NAME
  !define APP_NAME "Kulo"
!endif
!ifndef APP_ID
  !define APP_ID "io.kulo.desktop"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "0.1.11"
!endif
!ifndef SOURCE_DIR
  !error "SOURCE_DIR must be defined via -DSOURCE_DIR=..."
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE must be defined via -DOUTPUT_FILE=..."
!endif
!ifndef ICON_FILE
  !error "ICON_FILE must be defined via -DICON_FILE=..."
!endif

Name "${APP_NAME} ${APP_VERSION}"
OutFile "${OUTPUT_FILE}"
RequestExecutionLevel user
ManifestDPIAware true
ManifestLongPathAware true
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_ID}" "InstallDir"
SetCompressor lzma
ReserveFile /plugin nsExec.dll

!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_NAME}.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${APP_NAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  ; Gracefully ask any running instance to quit and wait until file locks clear.
  ${If} ${FileExists} "$INSTDIR\${APP_NAME}.exe"
    nsExec::ExecToLog '"$INSTDIR\${APP_NAME}.exe" --kulo-quit'
    Pop $0
    StrCpy $1 0
    ${DoWhile} $1 < 20
      ClearErrors
      FileOpen $2 "$INSTDIR\${APP_NAME}.exe" a
      ${IfNot} ${Errors}
        FileClose $2
        ${ExitDo}
      ${EndIf}
      Sleep 500
      IntOp $1 $1 + 1
    ${Loop}
    ; Remove stale resources from prior versions so kulo-release.json verification stays exact.
    RMDir /r "$INSTDIR\resources"
  ${EndIf}

  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r "${SOURCE_DIR}\*.*"

  ; Create Start Menu and Desktop shortcuts
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_NAME}.exe" "" "$INSTDIR\${APP_NAME}.exe" 0
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_NAME}.exe" "" "$INSTDIR\${APP_NAME}.exe" 0

  ; Write per-user uninstall metadata
  WriteUninstaller "$INSTDIR\Uninstall ${APP_NAME}.exe"
  WriteRegStr HKCU "Software\${APP_ID}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayIcon" "$INSTDIR\${APP_NAME}.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "Publisher" "Kulo"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "UninstallString" '"$INSTDIR\Uninstall ${APP_NAME}.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "EstimatedSize" "$0"
SectionEnd

Section "Uninstall"
  ${If} ${FileExists} "$INSTDIR\${APP_NAME}.exe"
    nsExec::ExecToLog '"$INSTDIR\${APP_NAME}.exe" --kulo-quit'
    Pop $0
    StrCpy $1 0
    ${DoWhile} $1 < 20
      ClearErrors
      FileOpen $2 "$INSTDIR\${APP_NAME}.exe" a
      ${IfNot} ${Errors}
        FileClose $2
        ${ExitDo}
      ${EndIf}
      Sleep 500
      IntOp $1 $1 + 1
    ${Loop}
  ${EndIf}

  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
  DeleteRegKey HKCU "Software\${APP_ID}"
SectionEnd

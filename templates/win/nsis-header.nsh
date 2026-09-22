!include "${NSIS_STDLIBS_NSH_PATH}"
!addincludedir "${NSIS_INCLUDE_DIR}"
!addincludedir "${NSIS_TEMPLATES_DIR}"

!macro _isUpdated _a _b _t _f
  ${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isUpdated `"" isUpdated ""`

!macro _isForceRun _a _b _t _f
  ${StdUtils.TestParameter} $R9 "force-run"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isForceRun `"" isForceRun ""`

!macro _isKeepShortcuts _a _b _t _f
  ${StdUtils.TestParameter} $R9 "keep-shortcuts"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isKeepShortcuts `"" isKeepShortcuts ""`

!macro _isNoDesktopShortcut _a _b _t _f
  ${StdUtils.TestParameter} $R9 "no-desktop-shortcut"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isNoDesktopShortcut `"" isNoDesktopShortcut ""`

!macro _isDeleteAppData _a _b _t _f
  ${StdUtils.TestParameter} $R9 "delete-app-data"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isDeleteAppData `"" isDeleteAppData ""`

!macro _isForAllUsers _a _b _t _f
  ${StdUtils.TestParameter} $R9 "allusers"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isForAllUsers `"" isForAllUsers ""`

!macro _isForCurrentUser _a _b _t _f
  ${StdUtils.TestParameter} $R9 "currentuser"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isForCurrentUser `"" isForCurrentUser ""`

!macro addLangs
  !insertmacro MUI_LANGUAGE "English"
  !insertmacro MUI_LANGUAGE "SimpChinese"
!macroend

!addplugindir /${NSIS_PLUGIN_ARCH} "${NSIS_PLUGINS_DIR}"

!include "${NSIS_MESSAGES_NSH}"

!macro customMessageBox
!macroend

' Runs Restart-WWAN-Service.bat completely invisibly, regardless of
' what triggers it or how often - the scheduled task normally shows a
' brief console window by default when running a .bat file directly,
' which is what's been causing the flashing box. This wrapper uses the
' same proven invisible-launch technique already used for the main
' reader and Node programs.

Set objShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectFolder = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = projectFolder & "\Restart-WWAN-Service.bat"

' windowStyle 0 = hidden, waitOnReturn True = task isn't considered
' "done" until the actual work (net stop/start, logging) finishes.
objShell.Run """" & batPath & """", 0, True

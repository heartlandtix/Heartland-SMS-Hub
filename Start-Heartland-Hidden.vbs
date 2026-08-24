' Starts the Heartland SMS Reader and Node server completely invisibly,
' redirecting their console output to log files instead of a window.
' This is meant to replace Start-Heartland.bat in the Startup folder.

Set objShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Figures out the folder this script itself lives in, so it works no
' matter which account name or drive it's copied to.
projectFolder = fso.GetParentFolderName(WScript.ScriptFullName)

logFolder = "C:\HeartlandData\logs"
If Not fso.FolderExists(logFolder) Then
    fso.CreateFolder(logFolder)
End If

' --- Log rotation: archive any log file older than 2 weeks ---
' Runs once per restart/login (not on every internal auto-restart
' within Run-Reader-Loop.bat's own loop), so today's data is never
' touched mid-day - only genuinely old data gets rotated. Rather than
' deleting the old file outright, it's renamed to "-previous.log" -
' this means there's NEVER a moment with zero recent history, since
' the prior ~2 weeks is still sitting right there even the instant
' after a rotation happens. Only the period before that (over a
' month old) actually gets discarded, when the next rotation replaces
' whatever "-previous" file was there before.
Sub RotateLogIfOld(logPath, maxAgeDays)
    If fso.FileExists(logPath) Then
        Set logFile = fso.GetFile(logPath)
        If DateDiff("d", logFile.DateCreated, Now) > maxAgeDays Then
            archivePath = Replace(logPath, ".log", "-previous.log")
            On Error Resume Next
            If fso.FileExists(archivePath) Then fso.DeleteFile archivePath, True
            fso.MoveFile logPath, archivePath
            On Error Goto 0
        End If
    End If
End Sub

RotateLogIfOld logFolder & "\reader.log", 14
RotateLogIfOld logFolder & "\node.log", 14
RotateLogIfOld logFolder & "\wwan-restart.log", 14
RotateLogIfOld logFolder & "\connectivity.log", 14

' --- Start the SMS reader (through its auto-restarting wrapper) ---
readerCmd = "cmd /c cd /d """ & projectFolder & """ && " & _
            "Run-Reader-Loop.bat >> ""C:\HeartlandData\logs\reader.log"" 2>&1"
objShell.Run readerCmd, 0, False

' Give the reader a few seconds to open its database and start listening
' before starting Node, same as the visible launcher already did.
WScript.Sleep 5000

' --- Start the Node server ---
' Uses the bundled portable Node runtime if it exists (deployment
' machines), otherwise falls back to a normal system-wide "node"
' command (this dev PC, which has Node installed the regular way).
nodeRuntimeExe = projectFolder & "\node-runtime\node.exe"
If fso.FileExists(nodeRuntimeExe) Then
    nodeExe = """" & nodeRuntimeExe & """"
Else
    nodeExe = "node"
End If

nodeCmd = "cmd /c cd /d """ & projectFolder & "\server"" && " & _
          nodeExe & " index.js >> ""C:\HeartlandData\logs\node.log"" 2>&1"
objShell.Run nodeCmd, 0, False

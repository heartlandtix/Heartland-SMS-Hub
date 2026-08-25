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
' Runs once per restart/login. Rather than deleting the old file
' outright, it's renamed to "-previous.log" - so there's NEVER a
' moment with zero recent history.
'
' This deliberately does NOT use the log file's own creation date to
' decide whether it's old enough to rotate. Windows can "tunnel" a
' recreated file's timestamp - if a file is renamed away and a new
' file with the SAME name is created again shortly after (exactly
' what rotation does), Windows can silently give that "new" file the
' OLD file's original creation date instead of today's. That would
' make every single restart think the fresh file was already weeks
' old, rotating it again immediately and wiping out whatever had just
' been saved into "-previous" - which is exactly what was observed in
' the field. Instead, a small separate marker file tracks the real
' rotation date ourselves, sidestepping the whole issue.
Sub RotateLogIfOld(logPath, maxAgeDays)
    markerPath = logPath & ".rotated-on"
    needsRotate = False

    If fso.FileExists(markerPath) Then
        Set markerFile = fso.OpenTextFile(markerPath, 1)
        markerDateStr = ""
        If Not markerFile.AtEndOfStream Then
            markerDateStr = markerFile.ReadLine()
        End If
        markerFile.Close

        markerDate = Now
        On Error Resume Next
        markerDate = CDate(markerDateStr)
        On Error Goto 0

        If DateDiff("d", markerDate, Now) > maxAgeDays Then
            needsRotate = True
        End If
    End If
    ' If no marker exists yet, this is the first time rotation has
    ' ever run for this log - don't rotate immediately, just start
    ' tracking from today.

    If needsRotate And fso.FileExists(logPath) Then
        archivePath = Replace(logPath, ".log", "-previous.log")
        On Error Resume Next
        If fso.FileExists(archivePath) Then fso.DeleteFile archivePath, True
        fso.MoveFile logPath, archivePath
        On Error Goto 0
    End If

    If needsRotate Or Not fso.FileExists(markerPath) Then
        Set markerFile = fso.CreateTextFile(markerPath, True)
        markerFile.WriteLine CStr(Now)
        markerFile.Close
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

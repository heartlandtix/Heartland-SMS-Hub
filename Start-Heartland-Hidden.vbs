' Starts the Heartland SMS Reader and Node server completely invisibly,
' redirecting their console output to log files instead of a window.
' This is meant to replace Start-Heartland.bat in the Startup folder.

Set objShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

logFolder = "C:\HeartlandData\logs"
If Not fso.FolderExists(logFolder) Then
    fso.CreateFolder(logFolder)
End If

' --- Start the SMS reader (through its auto-restarting wrapper) ---
readerCmd = "cmd /c cd /d ""C:\Users\Owner\Projects\Heartland-SMS-Hub"" && " & _
            "Run-Reader-Loop.bat >> ""C:\HeartlandData\logs\reader.log"" 2>&1"
objShell.Run readerCmd, 0, False

' Give the reader a few seconds to open its database and start listening
' before starting Node, same as the visible launcher already did.
WScript.Sleep 5000

' --- Start the Node server ---
nodeCmd = "cmd /c cd /d ""C:\Users\Owner\Projects\Heartland-SMS-Hub\server"" && " & _
          "node index.js >> ""C:\HeartlandData\logs\node.log"" 2>&1"
objShell.Run nodeCmd, 0, False

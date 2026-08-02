' Starts the Heartland SMS Reader and Node server completely invisibly,
' redirecting their console output to log files instead of a window.
' This is meant to replace Start-Heartland.bat in the Startup folder.

' Uses WMI to launch processes with genuinely no window at all. Unlike
' WScript.Shell.Run's "hide the window" setting (which is only a hint
' Windows can sometimes ignore for a chain of console programs like
' cmd.exe launching node.exe), this method guarantees no window or
' taskbar presence appears for the launched process.
Sub RunHidden(commandLine)
    Set objWMIService = GetObject("winmgmts:\\.\root\cimv2")
    Set objStartup = objWMIService.Get("Win32_ProcessStartup").SpawnInstance_()
    objStartup.ShowWindow = 0
    Set objProcess = objWMIService.Get("Win32_Process")
    objProcess.Create commandLine, Null, objStartup, intProcessID
End Sub

Set objShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Figures out the folder this script itself lives in, so it works no
' matter which account name or drive this is copied to.
projectFolder = fso.GetParentFolderName(WScript.ScriptFullName)

logFolder = "C:\HeartlandData\logs"
If Not fso.FolderExists(logFolder) Then
    fso.CreateFolder(logFolder)
End If

' --- Start the SMS reader (through its auto-restarting wrapper) ---
readerCmd = "cmd /c cd /d """ & projectFolder & """ && " & _
            "Run-Reader-Loop.bat >> ""C:\HeartlandData\logs\reader.log"" 2>&1"
RunHidden readerCmd

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
RunHidden nodeCmd

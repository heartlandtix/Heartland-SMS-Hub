' Shown by the Heartland Node server (server\index.js) when this
' computer's cellular modem has faulted in Device Manager. It only
' displays a message - it does not change anything on the computer.
'
' It is an always-on-top box, so it appears over whatever is open.
' Click OK to close it. It will not come back until the modem recovers
' and then fails again. If the modem recovers on its own, Heartland
' closes this box automatically.
'
' Usage (done by Heartland, not by hand):
'   wscript.exe Modem-Fault-Popup.vbs 43        (Code 43)
'   wscript.exe Modem-Fault-Popup.vbs missing   (modem not visible, usually Code 45)
'   wscript.exe Modem-Fault-Popup.vbs other     (any other modem problem)

Dim kind, headline, msg
kind = ""
If WScript.Arguments.Count > 0 Then kind = WScript.Arguments(0)

Select Case kind
    Case "43"
        headline = "Windows has stopped this computer's cellular modem because it reported an error (Device Manager Code 43)."
    Case "missing"
        headline = "Windows can no longer see this computer's cellular modem (usually Device Manager Code 45)."
    Case Else
        headline = "This computer's cellular modem is reporting a problem."
End Select

msg = "HEARTLAND - MODEM PROBLEM" & vbCrLf & vbCrLf & _
      headline & vbCrLf & _
      "Until it is fixed, this computer cannot receive texts." & vbCrLf & vbCrLf & _
      "A normal Restart does NOT fix this." & vbCrLf & vbCrLf & _
      "TO FIX:" & vbCrLf & _
      "   1. Click Start, then Power. Hold SHIFT and click Shut down." & vbCrLf & _
      "   2. Wait about 30 seconds, then turn the computer back on." & vbCrLf & _
      "   3. If this box comes back, shut down again, take out the SIM" & vbCrLf & _
      "       card, put it back in firmly, and power on." & vbCrLf & vbCrLf & _
      "Click OK to close this box. It will not come back until the" & vbCrLf & _
      "modem recovers and then fails again."

' 4096 = always on top (system modal), 48 = warning icon
MsgBox msg, 4096 + 48, "Heartland - Modem problem"

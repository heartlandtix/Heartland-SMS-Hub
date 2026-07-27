HEARTLAND SMS READER — READ-ONLY TEST
=====================================

Purpose
-------
This is the next engineering test. It asks the Windows Mobile Broadband API to
enumerate all stored SMS messages from the modem in raw GSM PDU form.

It does NOT:
- send SMS
- delete SMS
- change the SMS service-center address
- change modem settings

Why PDU?
--------
Your diagnostic report showed that this Sierra/Dell modem advertises:
"PDU receive, PDU send." Microsoft's documented Win32 Mobile Broadband API says
GSM devices must be read in PDU mode.

What the test proves
--------------------
If this program successfully returns the stored messages, we have confirmed that
the future collector can access the modem without relying on Skylight.

What you need
-------------
This package contains source code, not a prebuilt EXE. It requires Microsoft's
free Visual Studio 2022 Build Tools because this ChatGPT environment cannot
compile a native Windows program against the Windows SDK.

Install these workloads/components:
- Desktop development with C++
- Windows 10 SDK or Windows 11 SDK

After installation
------------------
1. Extract this ZIP.
2. Double-click BUILD-READER.bat.
3. If the build succeeds, double-click RUN-READER.bat.
4. Leave Skylight closed for the first test.
5. Wait up to 90 seconds.
6. A results file will be written to the Windows desktop:
   Heartland-SMS-Read-YYYYMMDD-HHMMSS.txt
7. Upload that results file here.

Privacy warning
---------------
The results file contains raw SMS PDUs. Those PDUs encode message sender,
timestamp, and body, including possible verification codes. Do not post the file
publicly.

Expected first-test result
--------------------------
Your modem reports 285 available stored messages. A successful API call may
return many messages and can call the completion callback more than once.

Potential behavior
------------------
The documented API is a read operation and the program never calls SmsDelete.
However, reading may cause a modem to change a message's status from unread to
read. Test first on one machine and confirm messages remain visible in Skylight.

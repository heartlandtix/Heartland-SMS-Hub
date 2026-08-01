HEARTLAND SMS HUB v1
====================

This version continuously monitors the modem for incoming SMS messages.

WHAT IT DOES
------------
- Reads the full modem inbox at startup.
- Opens the searchable HTML inbox once.
- Polls the modem every 5 seconds.
- Detects only messages not seen previously.
- Prints each new decoded message in the console.
- Rewrites the same TXT, CSV, and HTML files when a new SMS arrives.
- The HTML inbox refreshes itself every 5 seconds.
- Press Q in the console to stop the monitor.

SAFETY
------
This application remains read-only. It does not send or delete SMS messages.

HOW TO RUN
----------
1. Open HeartlandSmsReader.slnx in Visual Studio.
2. Choose Build > Rebuild Solution.
3. Choose Debug > Start Without Debugging.
4. Leave the black console window open.
5. Press Q in that console window when you want to stop.

IMPORTANT
---------
This source package was assembled from the version that already succeeded on
this modem and from the confirmed two-read/new-message test. It cannot be
compiled in this Linux environment against the Windows SDK, so the final build
verification must occur in Visual Studio on the modem PC.

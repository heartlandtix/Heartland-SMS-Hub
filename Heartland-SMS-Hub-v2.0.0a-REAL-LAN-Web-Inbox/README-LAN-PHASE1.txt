HEARTLAND SMS HUB v2.0.0a — LAN WEB INBOX
===========================================

WHAT THIS BUILD DOES
--------------------

- Keeps the proven continuous SMS monitor from v1.1.
- Starts a real HTTP server inside Heartland SMS Hub on TCP port 8080.
- Serves the current searchable SMS inbox at http://localhost:8080/
- Prints one or more LAN addresses that other computers can open.
- Continues refreshing the inbox every five seconds.
- Does not require IIS, Node.js, Python, Apache, or an external web library.
- Remains read-only: it does not send or delete SMS messages.

INSTALL AND TEST — ONE STEP AT A TIME
-------------------------------------

1. Extract this ZIP completely. Do not open the .slnx from inside the ZIP.
2. Open HeartlandSmsReader.slnx from the extracted folder.
3. In Visual Studio choose Build > Rebuild Solution.
4. Choose Debug > Start Without Debugging.
5. The black console should print:
       Web inbox started:
       This computer: http://localhost:8080/
       Other computers: http://<address>:8080/
6. Your browser should open http://localhost:8080/ automatically.

WINDOWS FIREWALL
----------------

When Windows asks, allow Heartland SMS Hub on PRIVATE networks.
Public access is not needed.

If the original prompt was answered incorrectly, right-click
ALLOW-PRIVATE-NETWORK.bat and choose Run as administrator. That script creates
an inbound PRIVATE-network rule for TCP port 8080.

TESTING FROM ANOTHER COMPUTER
-----------------------------

The second computer must be on the same local network as the Hub computer.
Open the LAN URL printed in the black console, for example:

    http://192.168.1.50:8080/

Do not use localhost on the second computer; localhost always means the computer
that you are currently using.

SECURITY FOR THIS PHASE
-----------------------

This first LAN phase has no username or password. Use it only on a trusted
private network. Do not forward port 8080 through the router and do not allow
the firewall rule on Public networks.

TROUBLESHOOTING
---------------

A. localhost does not open:
   - Keep the black console open.
   - Look for a line beginning "Web server could not..." and capture it.
   - Another application may already be using port 8080.

B. localhost works, but another computer cannot connect:
   - Run ALLOW-PRIVATE-NETWORK.bat as administrator.
   - Confirm both computers are on the same LAN.
   - Use the exact LAN address printed by the Hub.

C. Visual Studio says the project is not found:
   - Close Visual Studio.
   - Extract the ZIP.
   - Open the .slnx from the extracted folder, not from the ZIP preview.

TECHNICAL NOTE
--------------

The web server uses Windows Winsock directly and binds to all IPv4 interfaces
(INADDR_ANY) on port 8080. It serves only GET / and GET /index.html. Other paths
return 404. The generated HTML is read under a mutex so the server does not read
it while the SMS monitor is rewriting it.

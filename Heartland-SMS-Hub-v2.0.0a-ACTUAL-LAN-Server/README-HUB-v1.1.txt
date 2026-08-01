Heartland SMS Hub v1.1

Changes from v1 Continuous:
- Fixed the blank HTML inbox by correctly defining rawMessages in JavaScript.
- Existing stored messages should now appear when the inbox opens.
- New messages continue to be detected every 5 seconds.
- The same HTML/TXT/CSV files are updated when new messages arrive.
- The browser page reloads every 5 seconds to show updates.
- Added a status bar with message count and page-check time.
- Added timestamped Poll OK / Poll FAILED console logging.

Build:
1. Extract the ZIP completely.
2. Open HeartlandSmsReader.slnx from the extracted folder.
3. Build > Rebuild Solution.
4. Run with Ctrl+F5 or Local Windows Debugger.
5. Press Q in the console to stop.

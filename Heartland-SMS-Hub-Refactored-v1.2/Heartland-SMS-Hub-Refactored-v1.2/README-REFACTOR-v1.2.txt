Heartland SMS Hub v1.2 - behavior-preserving refactor

What changed:
- Restored the proven v1.1 continuous-monitoring source as the baseline.
- Split modem event/read logic into SmsReaderCore and SmsMonitor.
- Split HTML/TXT/CSV generation into InboxWriter.
- Reduced HeartlandSmsReader.cpp to application startup and the monitoring loop.
- Updated the Visual Studio project and filters.

What did not change:
- Five-second SMS polling.
- Read-only behavior.
- Searchable HTML inbox.
- New-message detection and console display.
- Q-to-stop behavior.

Build test required:
Open HeartlandSmsReader.slnx and choose Build > Rebuild Solution.

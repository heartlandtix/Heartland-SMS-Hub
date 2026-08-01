HEARTLAND SMS READER — SECOND READ TEST
=======================================

This project has been repaired and updated to test whether a newly arriving SMS
can be detected without restarting Windows or the program.

TEST STEPS
----------
1. Open HeartlandSmsReader.slnx.
2. Choose Build > Rebuild Solution.
3. Choose Debug > Start Without Debugging.
4. The first inbox opens.
5. When the console says "Waiting 30 seconds," send a text to this modem.
6. After 30 seconds, the program reads the modem again.
7. The console reports:
   - second message count
   - number of newly detected messages
   - sender, timestamp, and text for each new message
8. An updated inbox opens.

The program remains read-only. It does not send or delete SMS messages.

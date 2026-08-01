#pragma once
#include <string>
#include "sqlite3.h"
#include "PduDecoder.h"

// MessageStore owns one SQLite database connection and knows how to
// create its schema and insert decoded SMS messages into it.
//
// This class does not know anything about the modem, COM, or the HTTP
// server. It is intentionally self-contained so it can be tested and
// wired in without touching any existing file.
class MessageStore
{
public:
    MessageStore();
    ~MessageStore();

    // Opens (creating if necessary) the database file at dbPath,
    // creating any missing parent folders, and ensures the
    // "messages" table exists. Returns true on success.
    bool Open(const std::wstring& dbPath);

    // Closes the database connection if open. Safe to call multiple times.
    void Close();

    // Inserts one decoded message. Returns true if a NEW row was
    // inserted. Returns false if this exact message was already
    // stored before (duplicate), or if an error occurred -- call
    // LastError() to tell the difference.
    bool InsertMessage(
        unsigned long modemIndex,
        int status,
        const std::wstring& rawPdu,
        const DecodedSms& decoded);

    // Human-readable text describing the most recent error, if any.
    std::wstring LastError() const { return lastError_; }

private:
    bool EnsureSchema();

    sqlite3* db_ = nullptr;
    std::wstring deviceId_;
    std::wstring lastError_;
};

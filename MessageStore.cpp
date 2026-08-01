#include "MessageStore.h"

#include <windows.h>
#include <filesystem>
#include <sstream>

namespace
{
    std::string ToUtf8Local(const std::wstring& value)
    {
        if (value.empty()) return {};

        int required = WideCharToMultiByte(
            CP_UTF8, 0,
            value.data(), static_cast<int>(value.size()),
            nullptr, 0, nullptr, nullptr);

        if (required <= 0) return {};

        std::string output(static_cast<size_t>(required), '\0');

        WideCharToMultiByte(
            CP_UTF8, 0,
            value.data(), static_cast<int>(value.size()),
            output.data(), required, nullptr, nullptr);

        return output;
    }

    std::wstring Utf8ToWideLocal(const char* value)
    {
        if (!value || !*value) return L"";

        int required = MultiByteToWideChar(CP_UTF8, 0, value, -1, nullptr, 0);
        if (required <= 0) return L"";

        std::wstring output(static_cast<size_t>(required), L'\0');
        MultiByteToWideChar(CP_UTF8, 0, value, -1, output.data(), required);

        // MultiByteToWideChar with -1 includes the terminating null;
        // trim it so std::wstring's own length is correct.
        if (!output.empty() && output.back() == L'\0')
        {
            output.pop_back();
        }

        return output;
    }
}

MessageStore::MessageStore()
{
}

MessageStore::~MessageStore()
{
    Close();
}

bool MessageStore::Open(const std::wstring& dbPath)
{
    namespace fs = std::filesystem;

    std::error_code ec;
    fs::path path(dbPath);
    if (path.has_parent_path())
    {
        fs::create_directories(path.parent_path(), ec);
    }

    std::string utf8Path = ToUtf8Local(dbPath);

    int rc = sqlite3_open(utf8Path.c_str(), &db_);
    if (rc != SQLITE_OK)
    {
        lastError_ = L"Could not open database: " +
            (db_ ? Utf8ToWideLocal(sqlite3_errmsg(db_)) : L"unknown error");
        return false;
    }

    wchar_t nameBuffer[256]{};
    DWORD nameSize = 256;
    deviceId_ = GetComputerNameW(nameBuffer, &nameSize)
        ? std::wstring(nameBuffer)
        : L"UNKNOWN-DEVICE";

    return EnsureSchema();
}

void MessageStore::Close()
{
    if (db_)
    {
        sqlite3_close(db_);
        db_ = nullptr;
    }
}

bool MessageStore::EnsureSchema()
{
    static const char* createTableSql =
        "CREATE TABLE IF NOT EXISTS messages ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "device_id TEXT NOT NULL,"
        "modem_index INTEGER NOT NULL,"
        "message_type TEXT,"
        "status INTEGER,"
        "address TEXT,"
        "timestamp_original TEXT,"
        "encoding TEXT,"
        "text TEXT,"
        "error TEXT,"
        "multipart INTEGER,"
        "concat_reference INTEGER,"
        "concat_part INTEGER,"
        "concat_total INTEGER,"
        "raw_pdu TEXT,"
        "message_key TEXT NOT NULL UNIQUE,"
        "first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))"
        ");";

    char* errMsg = nullptr;
    int rc = sqlite3_exec(db_, createTableSql, nullptr, nullptr, &errMsg);

    if (rc != SQLITE_OK)
    {
        lastError_ = L"Could not create schema: " +
            (errMsg ? Utf8ToWideLocal(errMsg) : L"unknown error");

        if (errMsg)
        {
            sqlite3_free(errMsg);
        }

        return false;
    }

    return true;
}

bool MessageStore::InsertMessage(
    unsigned long modemIndex,
    int status,
    const std::wstring& rawPdu,
    const DecodedSms& decoded)
{
    if (!db_)
    {
        lastError_ = L"Database is not open.";
        return false;
    }

    const std::wstring address =
        !decoded.sender.empty() ? decoded.sender : decoded.recipient;

    // The unique key identifies "this exact message, on this exact
    // device". Combining device id + modem index + raw PDU means a
    // message already stored will never be inserted twice, even if
    // the program restarts and re-reads the modem's inbox.
    std::wstringstream keyStream;
    keyStream << deviceId_ << L"|" << modemIndex << L"|" << rawPdu;
    const std::wstring messageKey = keyStream.str();

    static const char* insertSql =
        "INSERT OR IGNORE INTO messages "
        "(device_id, modem_index, message_type, status, address, "
        "timestamp_original, encoding, text, error, multipart, "
        "concat_reference, concat_part, concat_total, raw_pdu, message_key) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);";

    sqlite3_stmt* stmt = nullptr;
    int rc = sqlite3_prepare_v2(db_, insertSql, -1, &stmt, nullptr);

    if (rc != SQLITE_OK)
    {
        lastError_ = L"Prepare failed: " + Utf8ToWideLocal(sqlite3_errmsg(db_));
        return false;
    }

    const std::string deviceIdUtf8 = ToUtf8Local(deviceId_);
    const std::string typeUtf8 = ToUtf8Local(decoded.messageType);
    const std::string addressUtf8 = ToUtf8Local(address);
    const std::string timestampUtf8 = ToUtf8Local(decoded.timestamp);
    const std::string encodingUtf8 = ToUtf8Local(decoded.encoding);
    const std::string textUtf8 = ToUtf8Local(decoded.text);
    const std::string errorUtf8 = ToUtf8Local(decoded.error);
    const std::string pduUtf8 = ToUtf8Local(rawPdu);
    const std::string keyUtf8 = ToUtf8Local(messageKey);

    sqlite3_bind_text(stmt, 1, deviceIdUtf8.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 2, static_cast<int>(modemIndex));
    sqlite3_bind_text(stmt, 3, typeUtf8.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 4, status);
    sqlite3_bind_text(stmt, 5, addressUtf8.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 6, timestampUtf8.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 7, encodingUtf8.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 8, textUtf8.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 9, errorUtf8.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, 10, decoded.isMultipart ? 1 : 0);
    sqlite3_bind_int(stmt, 11, decoded.concatReference);
    sqlite3_bind_int(stmt, 12, decoded.concatPart);
    sqlite3_bind_int(stmt, 13, decoded.concatTotal);
    sqlite3_bind_text(stmt, 14, pduUtf8.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 15, keyUtf8.c_str(), -1, SQLITE_TRANSIENT);

    rc = sqlite3_step(stmt);

    bool inserted = false;
    if (rc == SQLITE_DONE)
    {
        inserted = sqlite3_changes(db_) > 0;
    }
    else
    {
        lastError_ = L"Insert failed: " + Utf8ToWideLocal(sqlite3_errmsg(db_));
    }

    sqlite3_finalize(stmt);
    return inserted;
}

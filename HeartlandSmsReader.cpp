#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>
#include <atlbase.h>
#include <atlcom.h>
#pragma warning(disable: 4995)
#include <mbnapi.h>
#include <comutil.h>
#include "Logger.h"
#include "PduDecoder.h"
#include "MessageStore.h"

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <tuple>
#include <unordered_set>
#include <thread>
#include <vector>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "comsuppw.lib")
#pragma comment(lib, "mbnapi_uuid.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ws2_32.lib")

class SmsEventSink final : public IMbnSmsEvents
{
public:
    SmsEventSink() : refCount_(1) {}

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override
    {
        if (!ppv) return E_POINTER;
        *ppv = nullptr;

        if (riid == IID_IUnknown || riid == __uuidof(IMbnSmsEvents))
        {
            *ppv = static_cast<IMbnSmsEvents*>(this);
            AddRef();
            return S_OK;
        }

        return E_NOINTERFACE;
    }

    STDMETHODIMP_(ULONG) AddRef() override
    {
        return ++refCount_;
    }

    STDMETHODIMP_(ULONG) Release() override
    {
        ULONG value = --refCount_;
        if (value == 0) delete this;
        return value;
    }

    STDMETHODIMP OnSmsConfigurationChange(IMbnSms*) override
    {
        return S_OK;
    }

    STDMETHODIMP OnSetSmsConfigurationComplete(
        IMbnSms*, ULONG, HRESULT) override
    {
        return S_OK;
    }

    STDMETHODIMP OnSmsStatusChange(IMbnSms* sms) override
    {
        UNREFERENCED_PARAMETER(sms);
        return S_OK;
    }

    STDMETHODIMP OnSmsSendComplete(
        IMbnSms*, ULONG, HRESULT) override
    {
        return S_OK;
    }

    STDMETHODIMP OnSmsReadComplete(
        IMbnSms*,
        MBN_SMS_FORMAT smsFormat,
        SAFEARRAY* readMsgs,
        VARIANT_BOOL moreMsgs,
        ULONG requestID,
        HRESULT status) override
    {
        UNREFERENCED_PARAMETER(requestID);
        std::lock_guard<std::mutex> lock(mutex_);

        if (FAILED(status))
        {
            finalStatus_ = status;
            complete_ = true;
            cv_.notify_all();
            return S_OK;
        }

        if (smsFormat != MBN_SMS_FORMAT_PDU || !readMsgs)
        {
            finalStatus_ = E_UNEXPECTED;
            complete_ = true;
            cv_.notify_all();
            return S_OK;
        }

        LONG lower = 0;
        LONG upper = -1;

        if (SUCCEEDED(SafeArrayGetLBound(readMsgs, 1, &lower)) &&
            SUCCEEDED(SafeArrayGetUBound(readMsgs, 1, &upper)))
        {
            for (LONG i = lower; i <= upper; ++i)
            {
                IUnknown* raw = nullptr;
                if (FAILED(SafeArrayGetElement(readMsgs, &i, &raw)) || !raw)
                {
                    continue;
                }

                CComPtr<IUnknown> holder;
                holder.Attach(raw);

                CComPtr<IMbnSmsReadMsgPdu> message;
                if (FAILED(holder->QueryInterface(
                        __uuidof(IMbnSmsReadMsgPdu),
                        reinterpret_cast<void**>(&message))))
                {
                    continue;
                }

                ULONG index = 0;
                MBN_MSG_STATUS messageStatus{};
                CComBSTR pdu;

                message->get_Index(&index);
                message->get_Status(&messageStatus);
                message->get_PduData(&pdu);

                messages_.push_back({
                    index,
                    static_cast<int>(messageStatus),
                    pdu ? std::wstring(pdu, pdu.Length()) : L""
                });
            }
        }

        if (moreMsgs == VARIANT_FALSE)
        {
            finalStatus_ = S_OK;
            complete_ = true;
            cv_.notify_all();
        }

        return S_OK;
    }

    STDMETHODIMP OnSmsDeleteComplete(
        IMbnSms*, ULONG, HRESULT) override
    {
        return S_OK;
    }

    STDMETHODIMP OnSmsNewClass0Message(
        IMbnSms*, MBN_SMS_FORMAT, SAFEARRAY*) override
    {
        return S_OK;
    }

    struct RawMessage
    {
        ULONG index;
        int status;
        std::wstring pdu;
    };

    bool Wait(DWORD milliseconds)
    {
        std::unique_lock<std::mutex> lock(mutex_);
        return cv_.wait_for(
            lock,
            std::chrono::milliseconds(milliseconds),
            [&] { return complete_; });
    }

    HRESULT FinalStatus() const
    {
        return finalStatus_;
    }

    std::vector<RawMessage> Messages()
    {
        std::lock_guard<std::mutex> lock(mutex_);
        return messages_;
    }

private:
    std::atomic<ULONG> refCount_;
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    bool complete_ = false;
    HRESULT finalStatus_ = E_PENDING;
    std::vector<RawMessage> messages_;
};


class SmsStatusSink final : public IMbnSmsEvents
{
public:
    SmsStatusSink() : refCount_(1) {}

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override
    {
        if (!ppv) return E_POINTER;
        *ppv = nullptr;

        if (riid == IID_IUnknown || riid == __uuidof(IMbnSmsEvents))
        {
            *ppv = static_cast<IMbnSmsEvents*>(this);
            AddRef();
            return S_OK;
        }

        return E_NOINTERFACE;
    }

    STDMETHODIMP_(ULONG) AddRef() override
    {
        return ++refCount_;
    }

    STDMETHODIMP_(ULONG) Release() override
    {
        ULONG value = --refCount_;
        if (value == 0) delete this;
        return value;
    }

    STDMETHODIMP OnSmsConfigurationChange(IMbnSms*) override
    {
        return S_OK;
    }

    STDMETHODIMP OnSetSmsConfigurationComplete(
        IMbnSms*, ULONG, HRESULT) override
    {
        return S_OK;
    }

    STDMETHODIMP OnSmsStatusChange(IMbnSms* sms) override
    {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            changedSms_ = sms;
            changed_ = true;
        }

        cv_.notify_all();
        return S_OK;
    }

    STDMETHODIMP OnSmsSendComplete(
        IMbnSms*, ULONG, HRESULT) override
    {
        return S_OK;
    }

    STDMETHODIMP OnSmsReadComplete(
        IMbnSms*, MBN_SMS_FORMAT, SAFEARRAY*,
        VARIANT_BOOL, ULONG, HRESULT) override
    {
        return S_OK;
    }

    STDMETHODIMP OnSmsDeleteComplete(
        IMbnSms*, ULONG, HRESULT) override
    {
        return S_OK;
    }

    STDMETHODIMP OnSmsNewClass0Message(
        IMbnSms*, MBN_SMS_FORMAT, SAFEARRAY*) override
    {
        return S_OK;
    }

    bool WaitForChange(
        DWORD milliseconds,
        CComPtr<IMbnSms>& changedSms)
    {
        std::unique_lock<std::mutex> lock(mutex_);

        if (!cv_.wait_for(
                lock,
                std::chrono::milliseconds(milliseconds),
                [&] { return changed_; }))
        {
            return false;
        }

        changedSms = changedSms_;
        changedSms_.Release();
        changed_ = false;
        return changedSms != nullptr;
    }

private:
    std::atomic<ULONG> refCount_;
    std::mutex mutex_;
    std::condition_variable cv_;
    bool changed_ = false;
    CComPtr<IMbnSms> changedSms_;
};


static std::wstring HresultText(HRESULT hr)
{
    wchar_t* buffer = nullptr;
    DWORD flags = FORMAT_MESSAGE_ALLOCATE_BUFFER |
                  FORMAT_MESSAGE_FROM_SYSTEM |
                  FORMAT_MESSAGE_IGNORE_INSERTS;

    DWORD len = FormatMessageW(
        flags,
        nullptr,
        hr,
        0,
        reinterpret_cast<wchar_t*>(&buffer),
        0,
        nullptr);

    std::wstring result;
    if (len && buffer)
    {
        result.assign(buffer, len);
        LocalFree(buffer);
    }
    else
    {
        wchar_t fallback[32];
        swprintf_s(fallback, L"0x%08X", static_cast<unsigned>(hr));
        result = fallback;
    }

    return result;
}

#include <filesystem>

static std::wstring DesktopOutputStem()
{
    namespace fs = std::filesystem;

    wchar_t userProfile[MAX_PATH]{};
    DWORD size = MAX_PATH;

    if (!GetEnvironmentVariableW(L"USERPROFILE", userProfile, size))
    {
        return L"Heartland-SMS-Decoded";
    }

    SYSTEMTIME st{};
    GetLocalTime(&st);

    fs::path exportFolder =
        fs::path(userProfile) /
        L"Desktop" /
        L"Heartland Workspace" /
        L"Data" /
        L"Exports";

    std::error_code ec;
    fs::create_directories(exportFolder, ec);

    wchar_t filename[128];
    swprintf_s(
        filename,
        L"Heartland-SMS-Decoded-%04d%02d%02d-%02d%02d%02d",
        st.wYear,
        st.wMonth,
        st.wDay,
        st.wHour,
        st.wMinute,
        st.wSecond);

    return (exportFolder / filename).wstring();
}

static std::string ToUtf8(const std::wstring& value)
{
    if (value.empty()) return {};

    int required = WideCharToMultiByte(
        CP_UTF8,
        0,
        value.data(),
        static_cast<int>(value.size()),
        nullptr,
        0,
        nullptr,
        nullptr);

    if (required <= 0) return {};

    std::string output(static_cast<size_t>(required), '\0');

    WideCharToMultiByte(
        CP_UTF8,
        0,
        value.data(),
        static_cast<int>(value.size()),
        output.data(),
        required,
        nullptr,
        nullptr);

    return output;
}

static std::string CsvField(const std::wstring& value)
{
    std::string utf8 = ToUtf8(value);
    bool quote = utf8.find_first_of(",\"\r\n") != std::string::npos;

    size_t position = 0;
    while ((position = utf8.find('"', position)) != std::string::npos)
    {
        utf8.insert(position, 1, '"');
        position += 2;
    }

    return quote ? "\"" + utf8 + "\"" : utf8;
}

static std::wstring DisplayAddress(const DecodedSms& decoded)
{
    return !decoded.sender.empty() ? decoded.sender : decoded.recipient;
}


static std::string JsonEscape(const std::wstring& value)
{
    std::string utf8 = ToUtf8(value);
    std::ostringstream escaped;

    for (unsigned char ch : utf8)
    {
        switch (ch)
        {
        case '"':  escaped << "\\\""; break;
        case '\\': escaped << "\\\\"; break;
        case '\b': escaped << "\\b"; break;
        case '\f': escaped << "\\f"; break;
        case '\n': escaped << "\\n"; break;
        case '\r': escaped << "\\r"; break;
        case '\t': escaped << "\\t"; break;
        default:
            if (ch < 0x20)
            {
                escaped << "\\u"
                        << std::hex << std::setw(4) << std::setfill('0')
                        << static_cast<int>(ch)
                        << std::dec << std::setfill(' ');
            }
            else
            {
                escaped << static_cast<char>(ch);
            }
        }
    }

    return escaped.str();
}

static std::string BuildMessagesJson(
    const std::vector<SmsEventSink::RawMessage>& messages)
{
    std::ostringstream json;
    json << "{\"messages\":[";

    bool first = true;

    for (const auto& message : messages)
    {
        DecodedSms decoded = PduDecoder::Decode(message.pdu);
        std::wstring address = DisplayAddress(decoded);

        if (!first)
        {
            json << ",";
        }
        first = false;

        json << "{"
             << "\"index\":" << message.index << ","
             << "\"status\":" << message.status << ","
             << "\"type\":\"" << JsonEscape(decoded.messageType) << "\","
             << "\"address\":\"" << JsonEscape(address) << "\","
             << "\"timestamp\":\"" << JsonEscape(decoded.timestamp) << "\","
             << "\"encoding\":\"" << JsonEscape(decoded.encoding) << "\","
             << "\"text\":\"" << JsonEscape(decoded.text) << "\","
             << "\"error\":\"" << JsonEscape(decoded.error) << "\","
             << "\"multipart\":" << (decoded.isMultipart ? "true" : "false") << ","
             << "\"reference\":" << decoded.concatReference << ","
             << "\"part\":" << decoded.concatPart << ","
             << "\"total\":" << decoded.concatTotal
             << "}";
    }

    json << "]}";
    return json.str();
}

static std::wstring MessageKey(const SmsEventSink::RawMessage& message)
{
    return std::to_wstring(message.index) + L"|" + message.pdu;
}

static bool ReadMessagesOnce(
    IMbnSms* sms,
    IConnectionPoint* smsConnectionPoint,
    std::vector<SmsEventSink::RawMessage>& messages,
    HRESULT& finalStatus)
{
    messages.clear();
    finalStatus = E_PENDING;

    SmsEventSink* sink = new SmsEventSink();
    DWORD cookie = 0;

    HRESULT hr = smsConnectionPoint->Advise(
        static_cast<IUnknown*>(sink),
        &cookie);

    if (FAILED(hr))
    {
        sink->Release();
        finalStatus = hr;
        return false;
    }

    MBN_SMS_FILTER filter{};
    filter.flag = MBN_SMS_FLAG_ALL;
    filter.messageIndex = 0;

    ULONG requestId = 0;
    hr = sms->SmsRead(
        &filter,
        MBN_SMS_FORMAT_PDU,
        &requestId);

    if (SUCCEEDED(hr))
    {
        if (!sink->Wait(90000))
        {
            hr = HRESULT_FROM_WIN32(WAIT_TIMEOUT);
        }
        else
        {
            hr = sink->FinalStatus();
            messages = sink->Messages();
        }
    }

    smsConnectionPoint->Unadvise(cookie);
    sink->Release();

    finalStatus = hr;
    return SUCCEEDED(hr);
}


static std::string ReadWholeFileUtf8(const std::wstring& path)
{
    std::ifstream input(ToUtf8(path), std::ios::binary);
    if (!input)
    {
        return {};
    }

    std::ostringstream buffer;
    buffer << input.rdbuf();
    return buffer.str();
}

static bool WaitForLocalServerReady(
    unsigned short port,
    DWORD timeoutMilliseconds)
{
    const DWORD start = GetTickCount();

    while (GetTickCount() - start < timeoutMilliseconds)
    {
        SOCKET probe = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);

        if (probe != INVALID_SOCKET)
        {
            sockaddr_in address{};
            address.sin_family = AF_INET;
            address.sin_port = htons(port);
            inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);

            if (connect(
                    probe,
                    reinterpret_cast<sockaddr*>(&address),
                    sizeof(address)) == 0)
            {
                closesocket(probe);
                return true;
            }

            closesocket(probe);
        }

        Sleep(100);
    }

    return false;
}


static void RunHttpServer(
    const std::wstring& htmlPath,
    std::atomic_bool& stopRequested,
    std::mutex& messagesMutex,
    std::string& messagesJson,
    std::atomic<unsigned long long>& messagesVersion)
{
    WSADATA wsaData{};
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0)
    {
        std::wcerr << L"HTTP server: WSAStartup failed.\n";
        return;
    }

    SOCKET listenSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listenSocket == INVALID_SOCKET)
    {
        std::wcerr << L"HTTP server: socket creation failed.\n";
        WSACleanup();
        return;
    }

    BOOL reuse = TRUE;
    setsockopt(
        listenSocket,
        SOL_SOCKET,
        SO_REUSEADDR,
        reinterpret_cast<const char*>(&reuse),
        sizeof(reuse));

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    address.sin_port = htons(8080);

    if (bind(
            listenSocket,
            reinterpret_cast<sockaddr*>(&address),
            sizeof(address)) == SOCKET_ERROR)
    {
        std::wcerr << L"HTTP server: could not bind to port 8080. Error "
                   << WSAGetLastError() << L"\n";
        closesocket(listenSocket);
        WSACleanup();
        return;
    }

    if (listen(listenSocket, SOMAXCONN) == SOCKET_ERROR)
    {
        std::wcerr << L"HTTP server: listen failed. Error "
                   << WSAGetLastError() << L"\n";
        closesocket(listenSocket);
        WSACleanup();
        return;
    }

    std::wcout << L"\nWeb inbox is available at:\n"
               << L"  http://127.0.0.1:8080/\n"
               << L"  http://localhost:8080/\n"
               << L"From another computer, use this PC's IPv4 address with :8080.\n";

    while (!stopRequested.load())
    {
        fd_set readSet;
        FD_ZERO(&readSet);
        FD_SET(listenSocket, &readSet);

        timeval timeout{};
        timeout.tv_sec = 1;
        timeout.tv_usec = 0;

        int ready = select(0, &readSet, nullptr, nullptr, &timeout);
        if (ready <= 0)
        {
            continue;
        }

        SOCKET client = accept(listenSocket, nullptr, nullptr);
        if (client == INVALID_SOCKET)
        {
            continue;
        }

        char requestBuffer[4096]{};
        int received = recv(
            client,
            requestBuffer,
            static_cast<int>(sizeof(requestBuffer) - 1),
            0);

        std::string request =
            received > 0 ? std::string(requestBuffer, received) : std::string();

        std::string body;
        std::string contentType;

        if (request.rfind("GET /version ", 0) == 0)
        {
            body = std::to_string(messagesVersion.load());
            contentType = "text/plain; charset=utf-8";
        }
        else if (request.rfind("GET /messages ", 0) == 0)
        {
            std::lock_guard<std::mutex> lock(messagesMutex);
            body = messagesJson;
            contentType = "application/json; charset=utf-8";
        }
        else if (request.rfind("GET /health ", 0) == 0)
        {
            body = "Heartland SMS Hub is running.";
            contentType = "text/plain; charset=utf-8";
        }
        else if (request.rfind("GET /styles.css", 0) == 0)
        {
            body = ReadWholeFileUtf8(L"web\\styles.css");
            contentType = "text/css; charset=utf-8";
        }
        else if (request.rfind("GET /app.js", 0) == 0)
        {
            body = ReadWholeFileUtf8(L"web\\app.js");
            contentType = "application/javascript; charset=utf-8";
        }
        else
        {
            body = ReadWholeFileUtf8(htmlPath);
            contentType = "text/html; charset=utf-8";
        }

        if (body.empty())
        {
            body = "<!doctype html><html><body>"
                   "<h1>Heartland SMS Hub</h1>"
                   "<p>The requested resource is not available.</p>"
                   "</body></html>";
            contentType = "text/html; charset=utf-8";
        }

        std::ostringstream response;
        response << "HTTP/1.1 200 OK\r\n"
                 << "Content-Type: " << contentType << "\r\n"
                 << "Content-Length: " << body.size() << "\r\n"
                 << "Cache-Control: no-store\r\n"
                 << "Connection: close\r\n\r\n"
                 << body;

        const std::string responseText = response.str();
        send(
            client,
            responseText.data(),
            static_cast<int>(responseText.size()),
            0);

        shutdown(client, SD_BOTH);
        closesocket(client);
    }

    closesocket(listenSocket);
    WSACleanup();
}


int wmain(int argc, wchar_t* argv[])
{
    bool openBrowser = true;

    for (int i = 1; i < argc; ++i)
    {
        if (_wcsicmp(argv[i], L"--no-browser") == 0)
        {
            openBrowser = false;
        }
    }

    std::wcout << L"Heartland SMS Hub - continuous read-only monitor\n\n";
    std::wcout << L"This program reads stored SMS messages, decodes them,\n"
               << L"monitors for new messages, and serves the inbox on port 8080.\n\n";

    MessageStore messageStore;
    if (messageStore.Open(L"C:\\HeartlandData\\sms.db"))
    {
        std::wcout << L"Database ready: C:\\HeartlandData\\sms.db\n\n";

        // ---- TEMPORARY TEST INSERT (remove once confirmed working) ----
        DecodedSms testMessage;
        testMessage.messageType = L"TEST";
        testMessage.sender = L"TEST-SENDER";
        testMessage.timestamp = L"2026-07-31T00:00:00";
        testMessage.text = L"This is a manual test row, not a real SMS.";
        testMessage.encoding = L"TEST";

        bool testInserted = messageStore.InsertMessage(
            999999,
            0,
            L"TEST-PDU-DO-NOT-USE",
            testMessage);

        std::wcout << L"TEST INSERT result: "
                   << (testInserted ? L"inserted new row" : L"already existed or failed")
                   << L"\n";

        if (!messageStore.LastError().empty())
        {
            std::wcerr << L"TEST INSERT error: " << messageStore.LastError() << L"\n";
        }
        // ---- END TEMPORARY TEST INSERT ----
    }
    else
    {
        std::wcerr << L"WARNING: Could not open database: "
                   << messageStore.LastError() << L"\n"
                   << L"Continuing without database storage.\n\n";
    }

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr))
    {
        std::wcerr << L"COM initialization failed: " << HresultText(hr) << L"\n";
        return 1;
    }

    CComPtr<IMbnInterfaceManager> manager;
    hr = CoCreateInstance(
        CLSID_MbnInterfaceManager,
        nullptr,
        CLSCTX_ALL,
        IID_PPV_ARGS(&manager));

    if (FAILED(hr))
    {
        std::wcerr << L"Could not open Windows Mobile Broadband API: "
                   << HresultText(hr) << L"\n";
        CoUninitialize();
        return 2;
    }

    CComPtr<IConnectionPointContainer> connectionPointContainer;
    hr = manager->QueryInterface(IID_PPV_ARGS(&connectionPointContainer));
    if (FAILED(hr))
    {
        std::wcerr << L"Could not access MBN event connection point: "
                   << HresultText(hr) << L"\n";
        CoUninitialize();
        return 3;
    }

    CComPtr<IConnectionPoint> smsConnectionPoint;
    hr = connectionPointContainer->FindConnectionPoint(
        __uuidof(IMbnSmsEvents),
        &smsConnectionPoint);

    if (FAILED(hr))
    {
        std::wcerr << L"Could not subscribe to SMS events: "
                   << HresultText(hr) << L"\n";
        CoUninitialize();
        return 4;
    }

    SAFEARRAY* interfaces = nullptr;
    hr = manager->GetInterfaces(&interfaces);

    if (FAILED(hr) || !interfaces)
    {
        std::wcerr << L"Could not enumerate mobile broadband interfaces: "
                   << HresultText(hr) << L"\n";
        CoUninitialize();
        return 5;
    }

    LONG lower = 0;
    LONG upper = -1;
    SafeArrayGetLBound(interfaces, 1, &lower);
    SafeArrayGetUBound(interfaces, 1, &upper);

    CComPtr<IMbnSms> sms;

    for (LONG i = lower; i <= upper; ++i)
    {
        IUnknown* raw = nullptr;
        if (FAILED(SafeArrayGetElement(interfaces, &i, &raw)) || !raw)
        {
            continue;
        }

        CComPtr<IUnknown> holder;
        holder.Attach(raw);

        CComPtr<IMbnInterface> mbnInterface;
        if (FAILED(holder->QueryInterface(
                __uuidof(IMbnInterface),
                reinterpret_cast<void**>(&mbnInterface))))
        {
            continue;
        }

        if (SUCCEEDED(mbnInterface->QueryInterface(
                __uuidof(IMbnSms),
                reinterpret_cast<void**>(&sms))) && sms)
        {
            break;
        }
    }

    SafeArrayDestroy(interfaces);

    if (!sms)
    {
        std::wcerr << L"No SMS-capable mobile broadband interface was found.\n";
        CoUninitialize();
        return 6;
    }

    std::vector<SmsEventSink::RawMessage> messages;
    HRESULT readStatus = E_PENDING;

    std::wcout << L"Reading current SMS inbox...\n";

    if (!ReadMessagesOnce(sms, smsConnectionPoint, messages, readStatus))
    {
        std::wcerr << L"Initial SMS read failed: "
                   << HresultText(readStatus) << L"\n";
        CoUninitialize();
        return 7;
    }

    SmsStatusSink* statusSink = new SmsStatusSink();
    DWORD statusCookie = 0;

    hr = smsConnectionPoint->Advise(
        static_cast<IUnknown*>(statusSink),
        &statusCookie);

    if (FAILED(hr))
    {
        statusSink->Release();
        std::wcerr << L"Could not register SMS status monitor: "
                   << HresultText(hr) << L"\n";
        CoUninitialize();
        return 8;
    }

    const std::wstring htmlPath = L"web\\index.html";

    std::mutex messagesMutex;
    std::string messagesJson = BuildMessagesJson(messages);
    std::atomic<unsigned long long> messagesVersion{1};

    std::unordered_set<std::wstring> knownMessages;
    for (const auto& message : messages)
    {
        knownMessages.insert(MessageKey(message));
    }

    std::wcout << L"Messages currently stored: "
               << messages.size() << L"\n";
    std::wcout << L"Waiting for Windows SMS status-change events.\n"
               << L"Press Q in this console to stop.\n";

    std::atomic_bool stopRequested = false;
    std::thread serverThread(
        RunHttpServer,
        std::cref(htmlPath),
        std::ref(stopRequested),
        std::ref(messagesMutex),
        std::ref(messagesJson),
        std::ref(messagesVersion));

    if (openBrowser)
    {
        if (WaitForLocalServerReady(8080, 15000))
        {
            // Use Windows' URL protocol handler so browsers such as Opera
            // receive the complete http:// URL instead of a bare address.
            ShellExecuteW(
                nullptr,
                L"open",
                L"rundll32.exe",
                L"url.dll,FileProtocolHandler http://127.0.0.1:8080/",
                nullptr,
                SW_SHOWNORMAL);
        }
        else
        {
            std::wcerr << L"The web server did not become ready within 15 seconds.\n";
        }
    }

    while (!stopRequested.load())
    {
        if ((GetAsyncKeyState('Q') & 0x8000) != 0)
        {
            stopRequested.store(true);
            break;
        }

        CComPtr<IMbnSms> changedSms;
        if (!statusSink->WaitForChange(500, changedSms))
        {
            continue;
        }

        // Give Windows and the modem a moment to finish storing the message.
        Sleep(1000);

        std::vector<SmsEventSink::RawMessage> latestMessages;
        HRESULT latestStatus = E_PENDING;

        if (!ReadMessagesOnce(
                changedSms,
                smsConnectionPoint,
                latestMessages,
                latestStatus))
        {
            SYSTEMTIME now{};
            GetLocalTime(&now);

            std::wcerr << std::setfill(L'0')
                       << L"\n"
                       << std::setw(2) << now.wHour << L":"
                       << std::setw(2) << now.wMinute << L":"
                       << std::setw(2) << now.wSecond
                       << L"  Event refresh FAILED: "
                       << HresultText(latestStatus)
                       << L" (0x" << std::hex << std::uppercase
                       << static_cast<unsigned long>(latestStatus)
                       << std::dec << L")\n";
            continue;
        }

        size_t newCount = 0;

        for (const auto& message : latestMessages)
        {
            const std::wstring key = MessageKey(message);
            if (knownMessages.find(key) == knownMessages.end())
            {
                knownMessages.insert(key);
                ++newCount;

                DecodedSms decoded = PduDecoder::Decode(message.pdu);
                std::wcout << L"\nNEW MESSAGE\n"
                           << L"From: " << DisplayAddress(decoded) << L"\n"
                           << L"Time: " << decoded.timestamp << L"\n"
                           << L"Text: " << decoded.text << L"\n";

                if (!messageStore.InsertMessage(
                        message.index,
                        message.status,
                        message.pdu,
                        decoded))
                {
                    if (!messageStore.LastError().empty())
                    {
                        std::wcerr << L"Database insert warning: "
                                   << messageStore.LastError() << L"\n";
                    }
                }
            }
        }

        messages = std::move(latestMessages);

        if (newCount > 0)
        {
            {
                std::lock_guard<std::mutex> lock(messagesMutex);
                messagesJson = BuildMessagesJson(messages);
            }

            ++messagesVersion;

            std::wcout << L"Updated web inbox. New messages: "
                       << newCount << L"\n";
        }
    }

    stopRequested.store(true);
    if (serverThread.joinable())
    {
        serverThread.join();
    }

    smsConnectionPoint->Unadvise(statusCookie);
    statusSink->Release();

    CoUninitialize();
    return 0;
}

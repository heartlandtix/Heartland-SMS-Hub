#include "SmsMonitor.h"

#include <windows.h>
#include <iostream>
#include <sstream>

std::wstring CurrentClockText()
{
    SYSTEMTIME st{};
    GetLocalTime(&st);

    wchar_t value[16]{};
    swprintf_s(value, L"%02d:%02d:%02d", st.wHour, st.wMinute, st.wSecond);
    return value;
}

std::wstring MessageKey(const SmsEventSink::RawMessage& message)
{
    return std::to_wstring(message.index) + L"|" + message.pdu;
}

bool ReadSmsSnapshot(
    IMbnSms* sms,
    IConnectionPoint* smsConnectionPoint,
    const MBN_SMS_FILTER& filter,
    std::vector<SmsEventSink::RawMessage>& messages,
    HRESULT& readStatus)
{
    messages.clear();
    readStatus = E_PENDING;

    SmsEventSink* sink = new SmsEventSink();
    DWORD cookie = 0;

    HRESULT hr = smsConnectionPoint->Advise(
        static_cast<IUnknown*>(sink),
        &cookie);

    if (FAILED(hr))
    {
        sink->Release();
        std::wcerr << L"Could not register SMS event listener: "
                   << HresultText(hr) << L"\n";
        return false;
    }

    ULONG requestId = 0;
    hr = sms->SmsRead(
        const_cast<MBN_SMS_FILTER*>(&filter),
        MBN_SMS_FORMAT_PDU,
        &requestId);

    if (FAILED(hr))
    {
        smsConnectionPoint->Unadvise(cookie);
        sink->Release();
        std::wcerr << L"SmsRead failed immediately: "
                   << HresultText(hr) << L"\n";
        return false;
    }

    if (!sink->Wait(90000))
    {
        smsConnectionPoint->Unadvise(cookie);
        sink->Release();
        std::wcerr << L"Timed out waiting for Windows Mobile Broadband.\n";
        return false;
    }

    readStatus = sink->FinalStatus();
    messages = sink->Messages();

    smsConnectionPoint->Unadvise(cookie);
    sink->Release();

    if (FAILED(readStatus))
    {
        std::wcerr << L"SMS read completed with an error: "
                   << HresultText(readStatus) << L"\n";
        return false;
    }

    return true;
}

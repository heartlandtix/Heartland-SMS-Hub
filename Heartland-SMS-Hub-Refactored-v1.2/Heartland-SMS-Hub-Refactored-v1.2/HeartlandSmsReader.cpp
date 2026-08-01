#include <windows.h>
#include <atlbase.h>
#include <atlcom.h>
#pragma warning(disable: 4995)
#include <mbnapi.h>
#include <conio.h>

#include "InboxWriter.h"
#include "PduDecoder.h"
#include "SmsMonitor.h"
#include "SmsReaderCore.h"

#include <iomanip>
#include <iostream>
#include <string>
#include <unordered_set>
#include <vector>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "comsuppw.lib")
#pragma comment(lib, "mbnapi_uuid.lib")

int wmain()
{
    std::wcout << L"Heartland SMS Hub - continuous read-only monitor\n\n";
    std::wcout << L"This program reads stored SMS messages and decodes GSM PDUs.\n";
    std::wcout << L"It does not send or delete messages.\n\n";

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

    std::wcout << L"CoCreateInstance hr = 0x"
               << std::hex << static_cast<unsigned>(hr)
               << std::dec << L"\n";

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
        std::wcerr << L"Could not access SMS events: "
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

    MBN_SMS_FILTER filter{};
    filter.flag = MBN_SMS_FLAG_ALL;
    filter.messageIndex = 0;

    std::vector<SmsEventSink::RawMessage> currentMessages;
    HRESULT readStatus = E_PENDING;

    std::wcout << L"Reading current SMS inbox...\n";
    if (!ReadSmsSnapshot(sms, smsConnectionPoint, filter, currentMessages, readStatus))
    {
        CoUninitialize();
        return 7;
    }

    std::wstring outputStem = WriteOutputsAndLaunch(currentMessages);

    std::unordered_set<std::wstring> knownMessages;
    for (const auto& message : currentMessages)
    {
        knownMessages.insert(MessageKey(message));
    }

    std::wcout << L"\nMonitoring started.\n";
    std::wcout << L"Messages currently stored: " << currentMessages.size() << L"\n";
    std::wcout << L"Inbox file: " << outputStem << L".html\n";
    std::wcout << L"Checking every 5 seconds. Press Q to stop.\n";

    bool running = true;
    while (running)
    {
        // Wait five seconds, but check frequently so Q responds quickly.
        for (int tenth = 0; tenth < 50; ++tenth)
        {
            Sleep(100);
            if (_kbhit())
            {
                int key = _getch();
                if (key == 'q' || key == 'Q')
                {
                    running = false;
                    break;
                }
            }
        }

        if (!running)
        {
            break;
        }

        std::vector<SmsEventSink::RawMessage> latestMessages;
        HRESULT latestStatus = E_PENDING;

        if (!ReadSmsSnapshot(
                sms,
                smsConnectionPoint,
                filter,
                latestMessages,
                latestStatus))
        {
            std::wcerr << CurrentClockText() << L"  Poll FAILED. Retrying in 5 seconds.\n";
            continue;
        }

        size_t newMessageCount = 0;

        std::wcout << CurrentClockText()
                   << L"  Poll OK  Messages="
                   << latestMessages.size()
                   << L"\n";

        for (const auto& message : latestMessages)
        {
            std::wstring key = MessageKey(message);
            if (knownMessages.find(key) != knownMessages.end())
            {
                continue;
            }

            knownMessages.insert(key);
            ++newMessageCount;

            DecodedSms decoded = PduDecoder::Decode(message.pdu);
            std::wstring address = DisplayAddress(decoded);

            std::wcout << L"\n========================================\n";
            std::wcout << L"NEW MESSAGE\n";
            std::wcout << L"From: " << address << L"\n";
            std::wcout << L"Time: " << decoded.timestamp << L"\n";
            std::wcout << L"Text: " << decoded.text << L"\n";
            std::wcout << L"========================================\n";
        }

        if (newMessageCount > 0)
        {
            currentMessages = latestMessages;
            WriteDecodedFiles(currentMessages, outputStem);

            std::wcout << L"Inbox updated with "
                       << newMessageCount
                       << L" new message"
                       << (newMessageCount == 1 ? L"" : L"s")
                       << L". Total stored: "
                       << currentMessages.size()
                       << L"\n";
        }
    }

    CoUninitialize();
    std::wcout << L"\nHeartland SMS Hub stopped.\n";
    return 0;
}

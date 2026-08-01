#include "SmsReaderCore.h"

#include <cstdio>

std::wstring HresultText(HRESULT hr)
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

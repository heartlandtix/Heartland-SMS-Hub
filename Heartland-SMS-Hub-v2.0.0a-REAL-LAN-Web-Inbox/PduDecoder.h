#pragma once
#include <optional>
#include <string>

struct DecodedSms
{
    bool success = false;
    std::wstring error;
    std::wstring messageType;
    std::wstring sender;
    std::wstring recipient;
    std::wstring timestamp;
    std::wstring text;
    std::wstring encoding;
    bool isMultipart = false;
    int concatReference = -1;
    int concatPart = -1;
    int concatTotal = -1;
};

class PduDecoder
{
public:
    static DecodedSms Decode(const std::wstring& hexPdu);
};

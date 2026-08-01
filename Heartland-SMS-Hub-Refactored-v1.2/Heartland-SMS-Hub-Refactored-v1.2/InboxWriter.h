#pragma once

#include "SmsReaderCore.h"
#include "PduDecoder.h"

#include <string>
#include <vector>

std::wstring DesktopOutputStem();
std::string ToUtf8(const std::wstring& value);
std::wstring DisplayAddress(const DecodedSms& decoded);
void WriteDecodedFiles(
    const std::vector<SmsEventSink::RawMessage>& messages,
    const std::wstring& outputStem);
std::wstring WriteOutputsAndLaunch(
    const std::vector<SmsEventSink::RawMessage>& messages);

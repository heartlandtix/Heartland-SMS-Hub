#pragma once

#include "SmsReaderCore.h"

#include <atlbase.h>
#include <mbnapi.h>
#include <string>
#include <vector>

std::wstring CurrentClockText();
std::wstring MessageKey(const SmsEventSink::RawMessage& message);
bool ReadSmsSnapshot(
    IMbnSms* sms,
    IConnectionPoint* smsConnectionPoint,
    const MBN_SMS_FILTER& filter,
    std::vector<SmsEventSink::RawMessage>& messages,
    HRESULT& readStatus);

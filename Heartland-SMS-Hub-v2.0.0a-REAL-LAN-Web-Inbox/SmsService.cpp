#include "SmsService.h"

#include <iostream>
#include <thread>
#include <chrono>

bool SmsService::Start()
{
    if (!Initialize())
        return false;

    if (!Connect())
        return false;

    if (!LoadInbox())
        return false;

    return true;
}

void SmsService::Run()
{
    std::wcout << L"Watching for new SMS..." << std::endl;

    WaitForSms();
}

bool SmsService::Initialize()
{
    std::wcout << L"Initializing..." << std::endl;
    return true;
}

bool SmsService::Connect()
{
    std::wcout << L"Connecting modem..." << std::endl;
    return true;
}

bool SmsService::LoadInbox()
{
    std::wcout << L"Loading inbox..." << std::endl;
    return true;
}

void SmsService::WaitForSms()
{
    while (true)
    {
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }
}
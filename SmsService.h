#pragma once

class SmsService
{
public:

    bool Start();

    void Run();

private:

    bool Initialize();

    bool Connect();

    bool LoadInbox();

    void WaitForSms();
};
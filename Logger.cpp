#include "Logger.h"

#include <iostream>

namespace Logger
{
    void Info(const std::string& message)
    {
        std::cout << message << std::endl;
    }
}
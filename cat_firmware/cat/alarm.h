#pragma once

#include <stdint.h>
#include <time.h>

struct AlarmConfig {
  char configId[48];
  uint32_t revision;
  uint8_t hour;
  uint8_t minute;
  uint8_t daysMask;  // bit 0 = Thu Hai (1) .. bit 6 = Chu Nhat (7)
  bool enabled;
};

enum class ApplyAlarmResult : uint8_t {
  Applied = 0,
  Unchanged = 1,
  Stale = 2,
  Invalid = 3
};

bool alarmInit();
bool validateAlarmConfig(const AlarmConfig &cfg);
bool parseAlarmConfigJson(const char *json, AlarmConfig &out);
ApplyAlarmResult applyAlarmConfig(const AlarmConfig &incoming);
const AlarmConfig &alarmCurrent();
bool alarmDue(const struct tm &localTime, bool clockValid);
const char *applyAlarmResultName(ApplyAlarmResult res);

#pragma once

#include <stdint.h>
#include <time.h>

constexpr uint8_t MAX_ALARM_ENTRIES = 12;

struct AlarmEntry {
  char title[49];
  uint32_t date;
  uint8_t hour;
  uint8_t minute;
  uint8_t daysMask;
};

struct AlarmConfig {
  char configId[48];
  uint32_t revision;
  uint8_t hour;
  uint8_t minute;
  uint8_t daysMask;  // bit 0 = Thu Hai (1) .. bit 6 = Chu Nhat (7)
  bool enabled;
  bool listMode;
  uint8_t count;
  AlarmEntry entries[MAX_ALARM_ENTRIES];
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
const char *alarmFiredTitle();
const char *applyAlarmResultName(ApplyAlarmResult res);

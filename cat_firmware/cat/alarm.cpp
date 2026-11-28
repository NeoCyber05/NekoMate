#include "alarm.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <string.h>

namespace {

constexpr const char *NVS_NAMESPACE = "nekomate";

AlarmConfig g_current = {};
int64_t g_lastFiredMinuteKey = -1;
char g_firedTitle[49] = {};

int64_t makeMinuteKey(const struct tm &t) {
  return (static_cast<int64_t>(t.tm_year + 1900) * 100000000LL) +
         (static_cast<int64_t>(t.tm_yday) * 10000LL) +
         (static_cast<int64_t>(t.tm_hour) * 100LL) +
         static_cast<int64_t>(t.tm_min);
}

bool readSchedule(JsonObjectConst value, uint8_t &hour, uint8_t &minute, uint8_t &daysMask) {
  if (!value["hour"].is<int>() || !value["minute"].is<int>() || !value["days"].is<JsonArrayConst>()) {
    return false;
  }
  const int h = value["hour"];
  const int m = value["minute"];
  if (h < 0 || h > 23 || m < 0 || m > 59) return false;
  hour = static_cast<uint8_t>(h);
  minute = static_cast<uint8_t>(m);
  daysMask = 0;
  for (JsonVariantConst item : value["days"].as<JsonArrayConst>()) {
    const int day = item.as<int>();
    if (!item.is<int>() || day < 1 || day > 7) return false;
    daysMask |= static_cast<uint8_t>(1U << (day - 1));
  }
  return true;
}

void saveLastFiredToNvs(int64_t minuteKey) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) {
    return;
  }
  prefs.putLong64("lastFired", minuteKey);
  prefs.end();
}

}  // namespace

bool alarmInit() {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) {
    return false;
  }

  g_lastFiredMinuteKey = prefs.getLong64("lastFired", -1);
  AlarmConfig stored = {};
  if (prefs.getBytesLength("alarmListV1") == sizeof(stored)
      && prefs.getBytes("alarmListV1", &stored, sizeof(stored)) == sizeof(stored)
      && validateAlarmConfig(stored)) {
    g_current = stored;
  } else if (prefs.getBool("hasCfg", false)) {
    AlarmConfig loaded = {};
    String id = prefs.getString("cfgId", "");
    if (id.length() > 0 && id.length() < sizeof(loaded.configId)) {
      strncpy(loaded.configId, id.c_str(), sizeof(loaded.configId) - 1);
      loaded.configId[sizeof(loaded.configId) - 1] = '\0';
      loaded.revision = prefs.getUInt("rev", 0);
      loaded.hour = prefs.getUChar("hour", 0);
      loaded.minute = prefs.getUChar("min", 0);
      loaded.daysMask = prefs.getUChar("days", 0);
      loaded.enabled = prefs.getBool("enabled", false);
      if (validateAlarmConfig(loaded)) {
        g_current = loaded;
      }
    }
  }
  prefs.end();
  return true;
}

bool validateAlarmConfig(const AlarmConfig &cfg) {
  if (cfg.configId[0] == '\0' || cfg.configId[sizeof(cfg.configId) - 1] != '\0') {
    return false;
  }
  if (cfg.revision == 0) {
    return false;
  }
  if (cfg.listMode) {
    if (cfg.count > MAX_ALARM_ENTRIES) return false;
    for (uint8_t i = 0; i < cfg.count; ++i) {
      const AlarmEntry &entry = cfg.entries[i];
      if (entry.hour > 23 || entry.minute > 59 || entry.title[48] != '\0') return false;
      if (entry.date == 0 ? entry.daysMask == 0 || entry.daysMask > 127
          : entry.date < 20000101 || entry.date > 20991231 || entry.daysMask != 0) return false;
    }
    return true;
  }
  if (cfg.hour > 23 || cfg.minute > 59) {
    return false;
  }
  if ((cfg.daysMask & 0x80U) != 0) {
    return false;
  }
  if (cfg.enabled && cfg.daysMask == 0) {
    return false;
  }
  return true;
}

bool parseAlarmConfigJson(const char *json, AlarmConfig &out) {
  if (json == nullptr) {
    return false;
  }
  JsonDocument doc;
  if (deserializeJson(doc, json) != DeserializationError::Ok) {
    return false;
  }
  if (!doc["configId"].is<const char *>()) {
    return false;
  }
  const char *cfgId = doc["configId"];
  if (cfgId == nullptr || cfgId[0] == '\0' || strlen(cfgId) >= sizeof(out.configId)) {
    return false;
  }
  if (!doc["revision"].is<uint32_t>() || doc["revision"].as<uint32_t>() == 0) {
    return false;
  }

  memset(&out, 0, sizeof(out));
  strncpy(out.configId, cfgId, sizeof(out.configId) - 1);
  out.revision = doc["revision"];
  if (!doc["alarms"].isNull()) {
    const JsonArrayConst alarms = doc["alarms"].as<JsonArrayConst>();
    if (alarms.isNull() || alarms.size() > MAX_ALARM_ENTRIES) return false;
    out.listMode = true;
    for (JsonObjectConst value : alarms) {
      AlarmEntry &entry = out.entries[out.count++];
      if (!readSchedule(value, entry.hour, entry.minute, entry.daysMask)
          || !value["date"].is<uint32_t>() || !value["title"].is<const char *>()) return false;
      entry.date = value["date"];
      const char *title = value["title"];
      if (strlen(title) >= sizeof(entry.title)) return false;
      strcpy(entry.title, title);
    }
  } else {
    if (!doc["enabled"].is<bool>() || !readSchedule(doc.as<JsonObjectConst>(), out.hour, out.minute, out.daysMask)) {
      return false;
    }
    out.enabled = doc["enabled"];
  }

  return validateAlarmConfig(out);
}

ApplyAlarmResult applyAlarmConfig(const AlarmConfig &incoming) {
  if (!validateAlarmConfig(incoming)) {
    return ApplyAlarmResult::Invalid;
  }

  if (g_current.revision > 0) {
    if (incoming.revision < g_current.revision) {
      return ApplyAlarmResult::Stale;
    }
    if (incoming.revision == g_current.revision) {
      if (strcmp(incoming.configId, g_current.configId) == 0) {
        return ApplyAlarmResult::Unchanged;
      }
      return ApplyAlarmResult::Stale;
    }
  }

  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) return ApplyAlarmResult::Invalid;
  const bool saved = prefs.putBytes("alarmListV1", &incoming, sizeof(incoming)) == sizeof(incoming);
  prefs.end();
  if (!saved) return ApplyAlarmResult::Invalid;
  g_current = incoming;
  return ApplyAlarmResult::Applied;
}

const AlarmConfig &alarmCurrent() {
  return g_current;
}

bool alarmDue(const struct tm &localTime, bool clockValid) {
  if (!clockValid || g_current.revision == 0) {
    return false;
  }

  // tm_wday: 0=Chu Nhat .. 6=Thu Bay -> 1=Thu Hai .. 7=Chu Nhat
  const int day1to7 = (localTime.tm_wday == 0) ? 7 : localTime.tm_wday;
  const int64_t minuteKey = makeMinuteKey(localTime);
  if (minuteKey == g_lastFiredMinuteKey) {
    return false;
  }

  const uint8_t dayMask = static_cast<uint8_t>(1U << (day1to7 - 1));
  const char *title = "";
  if (g_current.listMode) {
    const uint32_t date = static_cast<uint32_t>((localTime.tm_year + 1900) * 10000
        + (localTime.tm_mon + 1) * 100 + localTime.tm_mday);
    const AlarmEntry *due = nullptr;
    for (uint8_t i = 0; i < g_current.count; ++i) {
      const AlarmEntry &entry = g_current.entries[i];
      if (entry.hour == localTime.tm_hour && entry.minute == localTime.tm_min
          && (entry.date ? entry.date == date : (entry.daysMask & dayMask) != 0)) {
        due = &entry;
        break;
      }
    }
    if (!due) return false;
    title = due->title;
  } else if (!g_current.enabled || !(g_current.daysMask & dayMask)
      || g_current.hour != localTime.tm_hour || g_current.minute != localTime.tm_min) {
    return false;
  }

  strcpy(g_firedTitle, title);
  g_lastFiredMinuteKey = minuteKey;
  saveLastFiredToNvs(minuteKey);
  return true;
}

const char *alarmFiredTitle() {
  return g_firedTitle;
}

const char *applyAlarmResultName(ApplyAlarmResult res) {
  switch (res) {
    case ApplyAlarmResult::Applied: return "applied";
    case ApplyAlarmResult::Unchanged: return "unchanged";
    case ApplyAlarmResult::Stale: return "stale";
    case ApplyAlarmResult::Invalid: return "invalid";
  }
  return "invalid";
}

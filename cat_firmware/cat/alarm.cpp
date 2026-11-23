#include "alarm.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <string.h>

namespace {

constexpr const char *NVS_NAMESPACE = "nekomate";

AlarmConfig g_current = {"", 0, 7, 0, 0, false};
int64_t g_lastFiredMinuteKey = -1;

int64_t makeMinuteKey(const struct tm &t) {
  return (static_cast<int64_t>(t.tm_year + 1900) * 100000000LL) +
         (static_cast<int64_t>(t.tm_yday) * 10000LL) +
         (static_cast<int64_t>(t.tm_hour) * 100LL) +
         static_cast<int64_t>(t.tm_min);
}

void saveConfigToNvs(const AlarmConfig &cfg) {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, false)) {
    return;
  }
  prefs.putBool("hasCfg", true);
  prefs.putString("cfgId", cfg.configId);
  prefs.putUInt("rev", cfg.revision);
  prefs.putUChar("hour", cfg.hour);
  prefs.putUChar("min", cfg.minute);
  prefs.putUChar("days", cfg.daysMask);
  prefs.putBool("enabled", cfg.enabled);
  prefs.end();
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
  if (prefs.getBool("hasCfg", false)) {
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
  if (cfg.configId[0] == '\0') {
    return false;
  }
  if (cfg.revision == 0) {
    return false;
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
  if (!doc["revision"].is<int64_t>() || !doc["hour"].is<int>() ||
      !doc["minute"].is<int>() || !doc["enabled"].is<bool>() ||
      !doc["days"].is<JsonArrayConst>()) {
    return false;
  }

  const int64_t rev = doc["revision"].as<int64_t>();
  const int hour = doc["hour"].as<int>();
  const int minute = doc["minute"].as<int>();
  const bool enabled = doc["enabled"].as<bool>();
  if (rev < 1 || rev > 0xFFFFFFFFLL || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return false;
  }

  uint8_t mask = 0;
  JsonArrayConst days = doc["days"].as<JsonArrayConst>();
  for (JsonVariantConst item : days) {
    if (!item.is<int>()) {
      return false;
    }
    const int d = item.as<int>();
    if (d < 1 || d > 7) {
      return false;
    }
    mask |= static_cast<uint8_t>(1U << (d - 1));
  }

  memset(&out, 0, sizeof(out));
  strncpy(out.configId, cfgId, sizeof(out.configId) - 1);
  out.revision = static_cast<uint32_t>(rev);
  out.hour = static_cast<uint8_t>(hour);
  out.minute = static_cast<uint8_t>(minute);
  out.daysMask = mask;
  out.enabled = enabled;

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

  g_current = incoming;
  saveConfigToNvs(g_current);
  return ApplyAlarmResult::Applied;
}

const AlarmConfig &alarmCurrent() {
  return g_current;
}

bool alarmDue(const struct tm &localTime, bool clockValid) {
  if (!clockValid || !g_current.enabled || g_current.revision == 0) {
    return false;
  }

  // tm_wday: 0=Chu Nhat .. 6=Thu Bay -> 1=Thu Hai .. 7=Chu Nhat
  const int day1to7 = (localTime.tm_wday == 0) ? 7 : localTime.tm_wday;
  if ((g_current.daysMask & static_cast<uint8_t>(1U << (day1to7 - 1))) == 0) {
    return false;
  }
  if (localTime.tm_hour != g_current.hour || localTime.tm_min != g_current.minute) {
    return false;
  }

  const int64_t minuteKey = makeMinuteKey(localTime);
  if (minuteKey == g_lastFiredMinuteKey) {
    return false;
  }

  g_lastFiredMinuteKey = minuteKey;
  saveLastFiredToNvs(minuteKey);
  return true;
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

/*
  NekoMate · Đồng hồ để bàn thông minh (ESP32-S3)
  Phần cứng: ESP32-S3-DevKitC-1, TFT ST7789 240x240 (SPI), cảm biến chạm TTP223,
             module khuếch đại I2S MAX98357A + loa 8 Ohm / 3 W.
*/
#include <Arduino.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef NEKOMATE_SIM
#include <Adafruit_ILI9341.h>
#else
#include <Adafruit_ST7789.h>
#endif

#include "alarm.h"
#include "audio.h"
#include "device_mqtt.h"

namespace {

constexpr int TFT_CS = 10;
constexpr int TFT_DC = 14;
constexpr int TFT_RST = 21;   // SCK = 12, MOSI = 11 (SPI mặc định ESP32-S3)
constexpr int TOUCH_PIN = 4;  // TTP223: chạm = HIGH

constexpr uint16_t BG = 0x1908;       // navy #1E2140
constexpr uint16_t FUR = 0xFFDF;
constexpr uint16_t EYE = 0xF5C9;      // amber #F0B848
constexpr uint16_t PINK = 0xF476;     // #F08CB4
constexpr uint16_t WHISKER = 0x9D16;  // grey #9AA0B4
constexpr uint16_t EAR = 0x29AC;      // #2E3460
constexpr uint16_t EAR_IN = 0x7A4D;   // #7A4A6A
constexpr uint16_t ACCENT = 0x7E5F;

constexpr uint32_t TOUCH_DEBOUNCE_MS = 40;
constexpr uint32_t TOUCH_COOLDOWN_MS = 600;
constexpr uint32_t HAPPY_DURATION_MS = 4000;
constexpr uint32_t BLINK_INTERVAL_MS = 4000;
constexpr uint32_t BLINK_DURATION_MS = 140;
constexpr uint32_t ALARM_MAX_DURATION_MS = 90000;
constexpr uint32_t REMINDER_MAX_DURATION_MS = 30000;
constexpr int64_t VALID_EPOCH_THRESHOLD = 1700000000LL;
constexpr size_t DEDUP_CAPACITY = 32;

#ifdef NEKOMATE_SIM
Adafruit_ILI9341 tft(TFT_CS, TFT_DC, TFT_RST);
#else
// init() sends its command list at the 32 MHz default before setSPISpeed() can run;
// over jumper wires that intermittently leaves the panel black, so force 10 MHz from the start.
class SlowST7789 : public Adafruit_ST7789 {
 public:
  using Adafruit_ST7789::Adafruit_ST7789;
  void begin(uint32_t) override { Adafruit_ST7789::begin(10000000); }
};
SlowST7789 tft(TFT_CS, TFT_DC, TFT_RST);
#endif

enum class Mood : uint8_t {
  NORMAL = 0,
  HAPPY = 1,
  SLEEPY = 2
};

enum class ScreenPage : uint8_t {
  FACE = 0,
  ALARM_ALERT = 1,
  REMINDER_ALERT = 2
};

enum class DedupState : uint8_t {
  None = 0,
  Shown = 1,
  Dismissed = 2
};

struct DedupEntry {
  char notificationId[64];
  DedupState state;
  int64_t at;
};

DedupEntry dedupTable[DEDUP_CAPACITY] = {};
size_t dedupWriteIdx = 0;

ScreenPage currentPage = ScreenPage::FACE;
bool screenInitialized = false;
Mood mood = Mood::NORMAL;
Mood shownMood = Mood::SLEEPY;
bool blinkActive = false;
bool shownBlink = false;

int shownHour = -2;
int shownMinute = -2;
bool shownClockValid = false;
uint32_t shownAlarmRev = 0xFFFFFFFFUL;
bool shownAlarmEnabled = false;

uint32_t lastTouchActionMs = 0;
uint32_t happyUntilMs = 0;
uint32_t lastBlinkMs = 0;
uint32_t blinkStartedAtMs = 0;

bool touchLastRaw = false;
bool touchStable = false;
uint32_t touchChangedAtMs = 0;

bool alarmPlayingActive = false;
uint32_t alarmStartedRealMs = 0;
uint32_t alarmElapsedSimMs = 0;

bool reminderPlayingActive = false;
char activeReminderId[64] = "";
int64_t activeReminderAt = 0;
uint32_t reminderStartedRealMs = 0;
uint32_t reminderElapsedSimMs = 0;

#ifdef NEKOMATE_SIM
bool simClockValid = false;
int64_t simEpochSec = 0;
bool simUseStepClock = false;
char simLineBuf[512];
size_t simLineLen = 0;

int64_t daysFromCivil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const int era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return static_cast<int64_t>(era) * 146097 + static_cast<int64_t>(doe) - 719468;
}

bool parseTwoDigits(const char *s, int &val) {
  if (s[0] < '0' || s[0] > '9' || s[1] < '0' || s[1] > '9') {
    return false;
  }
  val = (s[0] - '0') * 10 + (s[1] - '0');
  return true;
}

bool parseFourDigits(const char *s, int &val) {
  int hi = 0;
  int lo = 0;
  if (!parseTwoDigits(s, hi) || !parseTwoDigits(s + 2, lo)) {
    return false;
  }
  val = hi * 100 + lo;
  return true;
}

bool parseIsoTimestamp(const char *iso, int64_t &epochOut) {
  if (iso == nullptr || strlen(iso) < 19) {
    return false;
  }
  int year = 0, mon = 0, day = 0, hour = 0, minute = 0, sec = 0;
  if (!parseFourDigits(iso, year) || iso[4] != '-' ||
      !parseTwoDigits(iso + 5, mon) || iso[7] != '-' ||
      !parseTwoDigits(iso + 8, day) || (iso[10] != 'T' && iso[10] != ' ') ||
      !parseTwoDigits(iso + 11, hour) || iso[13] != ':' ||
      !parseTwoDigits(iso + 14, minute) || iso[16] != ':' ||
      !parseTwoDigits(iso + 17, sec)) {
    return false;
  }
  if (mon < 1 || mon > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || sec > 59) {
    return false;
  }

  int32_t offsetSec = 7 * 3600;
  const char *tz = iso + 19;
  if (tz[0] == 'Z' || tz[0] == 'z') {
    offsetSec = 0;
  } else if (tz[0] == '+' || tz[0] == '-') {
    int offH = 0;
    int offM = 0;
    if (strlen(tz) < 6 || !parseTwoDigits(tz + 1, offH) || tz[3] != ':' || !parseTwoDigits(tz + 4, offM)) {
      return false;
    }
    offsetSec = (offH * 3600) + (offM * 60);
    if (tz[0] == '-') {
      offsetSec = -offsetSec;
    }
  } else if (tz[0] != '\0') {
    return false;
  }

  const int64_t days = daysFromCivil(year, static_cast<unsigned>(mon), static_cast<unsigned>(day));
  epochOut = (days * 86400LL) + (static_cast<int64_t>(hour) * 3600LL) +
             (static_cast<int64_t>(minute) * 60LL) + static_cast<int64_t>(sec) - offsetSec;
  return true;
}
#endif

bool readClock(struct tm &localOut, bool &clockValidOut, int64_t &epochOut) {
#ifdef NEKOMATE_SIM
  if (simClockValid && simEpochSec >= VALID_EPOCH_THRESHOLD) {
    time_t t = static_cast<time_t>(simEpochSec);
    localtime_r(&t, &localOut);
    clockValidOut = true;
    epochOut = simEpochSec;
    return true;
  }
  clockValidOut = false;
  epochOut = 0;
  return false;
#else
  const time_t nowSec = time(nullptr);
  if (nowSec >= VALID_EPOCH_THRESHOLD) {
    localtime_r(&nowSec, &localOut);
    clockValidOut = true;
    epochOut = static_cast<int64_t>(nowSec);
    return true;
  }
  clockValidOut = false;
  epochOut = 0;
  return false;
#endif
}

int findDedupIndex(const char *notificationId) {
  for (size_t i = 0; i < DEDUP_CAPACITY; i++) {
    if (dedupTable[i].state != DedupState::None &&
        strcmp(dedupTable[i].notificationId, notificationId) == 0) {
      return static_cast<int>(i);
    }
  }
  return -1;
}

void upsertDedup(const char *notificationId, DedupState state, int64_t atEpoch) {
  const int existing = findDedupIndex(notificationId);
  if (existing >= 0) {
    dedupTable[existing].state = state;
    dedupTable[existing].at = atEpoch;
    return;
  }
  DedupEntry &slot = dedupTable[dedupWriteIdx];
  memset(&slot, 0, sizeof(slot));
  strncpy(slot.notificationId, notificationId, sizeof(slot.notificationId) - 1);
  slot.state = state;
  slot.at = atEpoch;
  dedupWriteIdx = (dedupWriteIdx + 1) % DEDUP_CAPACITY;
}

void emitNotificationEvent(const char *type, const char *notificationId, int64_t atEpoch) {
  JsonDocument doc;
  doc["type"] = type;
  doc["notificationId"] = notificationId;
  doc["at"] = atEpoch;
  char buf[220];
  serializeJson(doc, buf, sizeof(buf));
  mqttEnqueueEvent(buf);
}

void emitAlarmConfigEvent(ApplyAlarmResult res, const AlarmConfig &incoming) {
  if (res == ApplyAlarmResult::Invalid) {
    return;
  }
  JsonDocument doc;
  if (res == ApplyAlarmResult::Stale) {
    doc["type"] = "alarm_config_stale";
    doc["configId"] = incoming.configId;
    doc["revision"] = incoming.revision;
    doc["appliedRevision"] = alarmCurrent().revision;
  } else {
    doc["type"] = "alarm_config_applied";
    doc["configId"] = incoming.configId;
    doc["revision"] = incoming.revision;
  }
  char buf[220];
  serializeJson(doc, buf, sizeof(buf));
  mqttEnqueueEvent(buf);
}

// Pixel-art face: everything is drawn from 10px (eyes) / 6-8px (details) blocks.
constexpr int EYE_BLOCK = 10;
constexpr int EYE_LEFT_X = 45;
constexpr int EYE_RIGHT_X = 145;
constexpr int EYE_TOP_Y = 90;

void drawPixelEar(int cx) {
  for (int i = 0; i < 6; i++) {
    tft.fillRect(cx - 6 - i * 6, 8 + i * 8, 12 + i * 12, 8, EAR);
    if (i >= 2) tft.fillRect(cx - 6 - (i - 2) * 6, 8 + i * 8, 12 + (i - 2) * 12, 8, EAR_IN);
  }
}

void drawFaceStatic() {
  tft.fillScreen(BG);
  drawPixelEar(54);
  drawPixelEar(186);

  // nose: stepped pink triangle
  tft.fillRect(108, 140, 24, 6, PINK);
  tft.fillRect(114, 146, 12, 6, PINK);
  tft.fillRect(118, 152, 4, 4, PINK);

  // mouth: white pixel "w"
  for (int i = 0; i < 5; i++) {
    tft.fillRect(105 + i * 6, (i % 2 == 0) ? 158 : 164, 6, 6, FUR);
  }

  // whiskers: grey dashes
  tft.fillRect(22, 148, 30, 5, WHISKER);
  tft.fillRect(28, 162, 24, 5, WHISKER);
  tft.fillRect(188, 148, 30, 5, WHISKER);
  tft.fillRect(188, 162, 24, 5, WHISKER);
}

// Draws one eye from a list of (col,row) blocks on the EYE_BLOCK grid.
void drawEyeBlocks(int x0, const uint8_t (*cells)[2], int count, uint16_t color) {
  for (int i = 0; i < count; i++) {
    tft.fillRect(x0 + cells[i][0] * EYE_BLOCK, EYE_TOP_Y + cells[i][1] * EYE_BLOCK, EYE_BLOCK, EYE_BLOCK, color);
  }
}

void drawEyeRegion(Mood m, bool blink) {
  tft.fillRect(EYE_LEFT_X - 5, EYE_TOP_Y - 5, 60, 50, BG);
  tft.fillRect(EYE_RIGHT_X - 5, EYE_TOP_Y - 5, 60, 50, BG);
  tft.fillRect(198, 58, 40, 36, BG);  // "z z" area

  static const uint8_t HAPPY_EYE[][2] = {{0, 3}, {1, 2}, {2, 1}, {3, 2}, {4, 3}};           // ^
  static const uint8_t SLEEPY_EYE[][2] = {{0, 2}, {1, 3}, {2, 3}, {3, 3}, {4, 2}};          // u
  static const uint8_t BLINK_EYE[][2] = {{0, 3}, {1, 3}, {2, 3}, {3, 3}, {4, 3}};           // -
  static const uint8_t OPEN_EYE[][2] = {{1, 0}, {2, 0}, {3, 0}, {0, 1}, {1, 1}, {2, 1}, {3, 1}, {4, 1},
                                        {0, 2}, {1, 2}, {2, 2}, {3, 2}, {4, 2}, {1, 3}, {2, 3}, {3, 3}};

  const uint8_t (*cells)[2] = OPEN_EYE;
  int count = sizeof(OPEN_EYE) / sizeof(OPEN_EYE[0]);
  if (m == Mood::SLEEPY) {
    cells = SLEEPY_EYE;
    count = 5;
  } else if (blink) {
    cells = BLINK_EYE;
    count = 5;
  } else if (m == Mood::HAPPY) {
    cells = HAPPY_EYE;
    count = 5;
  }
  drawEyeBlocks(EYE_LEFT_X, cells, count, EYE);
  drawEyeBlocks(EYE_RIGHT_X, cells, count, EYE);

  if (cells == OPEN_EYE) {
    // white sparkle on a solid pixel eye
    tft.fillRect(EYE_LEFT_X + 10, EYE_TOP_Y + 10, 10, 10, FUR);
    tft.fillRect(EYE_RIGHT_X + 10, EYE_TOP_Y + 10, 10, 10, FUR);
  }

  if (m == Mood::SLEEPY) {
    tft.setTextColor(FUR);
    tft.setTextSize(2);
    tft.setCursor(202, 78);
    tft.print(F("z"));
    tft.setTextSize(3);
    tft.setCursor(216, 58);
    tft.print(F("z"));
  }
}

void drawClockRegion(int hour, int minute, bool valid) {
  tft.fillRect(56, 184, 128, 30, BG);
  tft.setTextSize(3);
  tft.setTextColor(valid ? FUR : ACCENT);
  tft.setCursor(75, 188);
  if (valid) {
    char buf[8];
    snprintf(buf, sizeof(buf), "%02d:%02d", hour, minute);
    tft.print(buf);
  } else {
    tft.print(F("--:--"));
  }
}

void drawAlarmBadge() {
  tft.fillRect(40, 218, 160, 18, BG);
  const AlarmConfig &cfg = alarmCurrent();
  tft.setTextSize(1);
  tft.setCursor(62, 222);
  if (cfg.listMode && cfg.count > 0) {
    char buf[24];
    snprintf(buf, sizeof(buf), "BAO THUC: %u MUC", cfg.count);
    tft.setTextColor(EYE);
    tft.print(buf);
  } else if (cfg.revision > 0 && cfg.enabled) {
    char buf[24];
    snprintf(buf, sizeof(buf), "BAO THUC %02u:%02u", cfg.hour, cfg.minute);
    tft.setTextColor(EYE);
    tft.print(buf);
  } else {
    tft.setTextColor(ACCENT);
    tft.print(F("NEKOMATE READY"));
  }
}

void drawWrappedText(const char *text, int startX, int startY, int maxCols, int lineHeight, int maxLines);

void drawAlarmAlertPage(int hour, int minute, bool clockValid) {
  tft.fillScreen(BG);
  tft.drawRoundRect(14, 18, 212, 204, 16, EYE);
  tft.setTextColor(EYE);
  tft.setTextSize(3);
  tft.setCursor(48, 39);
  tft.print(F("BAO THUC"));
  tft.setTextColor(FUR);
  tft.setTextSize(4);
  tft.setCursor(60, 83);
  if (clockValid) {
    char buf[8];
    snprintf(buf, sizeof(buf), "%02d:%02d", hour, minute);
    tft.print(buf);
  } else {
    const AlarmConfig &cfg = alarmCurrent();
    char buf[8];
    snprintf(buf, sizeof(buf), "%02u:%02u", cfg.hour, cfg.minute);
    tft.print(buf);
  }
  tft.setTextColor(FUR);
  tft.setTextSize(1);
  drawWrappedText(alarmFiredTitle(), 42, 133, 22, 13, 3);
  tft.setTextSize(2);
  tft.setTextColor(PINK);
  tft.setCursor(44, 185);
  tft.print(F("Cham de tat"));
}

void drawWrappedText(const char *text, int startX, int startY, int maxCols, int lineHeight, int maxLines) {
  char line[24];
  const size_t total = strlen(text);
  size_t pos = 0;
  int lineIdx = 0;

  while (pos < total && lineIdx < maxLines) {
    while (pos < total && text[pos] == ' ') {
      pos++;
    }
    if (pos >= total) {
      break;
    }

    size_t take = 0;
    size_t lastSpace = 0;
    const size_t limit = static_cast<size_t>(maxCols < 22 ? maxCols : 22);
    while (pos + take < total && take < limit) {
      if (text[pos + take] == ' ') {
        lastSpace = take;
      }
      take++;
    }
    if (pos + take < total && lastSpace > 0) {
      take = lastSpace;
    }
    memcpy(line, text + pos, take);
    line[take] = '\0';
    tft.setCursor(startX, startY + lineIdx * lineHeight);
    tft.print(line);
    pos += take;
    lineIdx++;
  }
}

void drawReminderAlertPage(const char *source, const char *title) {
  tft.fillScreen(BG);
  tft.drawRoundRect(12, 16, 216, 208, 16, ACCENT);
  tft.setTextSize(2);
  tft.setTextColor(ACCENT);
  tft.setCursor(24, 32);
  char srcBuf[20];
  strncpy(srcBuf, source, sizeof(srcBuf) - 1);
  srcBuf[sizeof(srcBuf) - 1] = '\0';
  tft.print(srcBuf);

  tft.drawFastHLine(24, 58, 192, ACCENT);

  tft.setTextSize(2);
  tft.setTextColor(FUR);
  drawWrappedText(title, 24, 74, 16, 24, 4);

  tft.setTextSize(2);
  tft.setTextColor(PINK);
  tft.setCursor(44, 188);
  tft.print(F("Cham de tat"));
}

void enterFacePage(int hour, int minute, bool clockValid) {
  currentPage = ScreenPage::FACE;
  screenInitialized = true;
  drawFaceStatic();
  drawEyeRegion(mood, blinkActive);
  drawClockRegion(hour, minute, clockValid);
  drawAlarmBadge();
  shownMood = mood;
  shownBlink = blinkActive;
  shownHour = hour;
  shownMinute = minute;
  shownClockValid = clockValid;
  shownAlarmRev = alarmCurrent().revision;
  shownAlarmEnabled = alarmCurrent().enabled;
}

void stopAlarmPlayback(int hour, int minute, bool clockValid) {
  if (!alarmPlayingActive) {
    return;
  }
  alarmPlayingActive = false;
  alarmElapsedSimMs = 0;
  audioStop();
  enterFacePage(hour, minute, clockValid);
}

void stopReminderPlayback(bool byTouch, int hour, int minute, bool clockValid, int64_t nowEpoch, bool hasClock) {
  if (!reminderPlayingActive) {
    return;
  }
  reminderPlayingActive = false;
  reminderElapsedSimMs = 0;
  audioStop();
  if (byTouch && activeReminderId[0] != '\0') {
    const int64_t atEpoch = hasClock ? nowEpoch : activeReminderAt;
    upsertDedup(activeReminderId, DedupState::Dismissed, atEpoch);
    emitNotificationEvent("dismissed", activeReminderId, atEpoch);
  }
  activeReminderId[0] = '\0';
  enterFacePage(hour, minute, clockValid);
}

void evaluateAlarmTick(uint32_t nowMs, const struct tm &localTm, bool clockValid) {
  if (alarmDue(localTm, clockValid)) {
    // Bao thuc uu tien cao nhat: chiem loa va man hinh ngay lap tuc
    if (reminderPlayingActive) {
      reminderPlayingActive = false;
      reminderElapsedSimMs = 0;
      activeReminderId[0] = '\0';
    }
    alarmPlayingActive = true;
    alarmStartedRealMs = nowMs;
    alarmElapsedSimMs = 0;
    currentPage = ScreenPage::ALARM_ALERT;
    drawAlarmAlertPage(localTm.tm_hour, localTm.tm_min, clockValid);
    audioStart(SoundKind::Alarm);
  }
}

void handleAlarmConfigPayload(const char *json) {
  AlarmConfig incoming = {};
  if (!parseAlarmConfigJson(json, incoming)) {
    return;
  }
  const ApplyAlarmResult res = applyAlarmConfig(incoming);
  emitAlarmConfigEvent(res, incoming);
}

void handleNotifyPayload(const char *json, uint32_t nowMs) {
  if (json == nullptr) {
    return;
  }
  JsonDocument doc;
  if (deserializeJson(doc, json) != DeserializationError::Ok) {
    return;
  }
  if (!doc["notificationId"].is<const char *>() ||
      !doc["source"].is<const char *>() ||
      !doc["title"].is<const char *>() ||
      !doc["expiresAt"].is<int64_t>()) {
    return;
  }

  const char *notificationId = doc["notificationId"];
  const char *source = doc["source"];
  const char *title = doc["title"];
  const int64_t notifyAt = doc["notifyAt"].is<int64_t>() ? doc["notifyAt"].as<int64_t>() : 0;
  const int64_t expiresAt = doc["expiresAt"].as<int64_t>();

  if (notificationId == nullptr || notificationId[0] == '\0' || strlen(notificationId) >= sizeof(activeReminderId)) {
    return;
  }

  // 1. Kiem tra trung trong RAM truoc: gui lai trang thai gan nhat va giu loa im
  const int dedupIdx = findDedupIndex(notificationId);
  if (dedupIdx >= 0) {
    const char *type = (dedupTable[dedupIdx].state == DedupState::Dismissed) ? "dismissed" : "shown";
    emitNotificationEvent(type, notificationId, dedupTable[dedupIdx].at);
    return;
  }

  // 2. Kiem tra han lenh
  struct tm localTm = {};
  bool clockValid = false;
  int64_t nowEpoch = 0;
  readClock(localTm, clockValid, nowEpoch);
  if (clockValid && nowEpoch >= expiresAt) {
    return;
  }

  // 3. Neu dang ban (bao thuc hoac nhac khac), giu im va KHONG ghi chong trung
  if (alarmPlayingActive || reminderPlayingActive) {
    return;
  }

  // 4. Hien thi va phat tieng
  const int64_t atEpoch = clockValid ? nowEpoch : notifyAt;
  upsertDedup(notificationId, DedupState::Shown, atEpoch);

  reminderPlayingActive = true;
  strncpy(activeReminderId, notificationId, sizeof(activeReminderId) - 1);
  activeReminderId[sizeof(activeReminderId) - 1] = '\0';
  activeReminderAt = atEpoch;
  reminderStartedRealMs = nowMs;
  reminderElapsedSimMs = 0;

  currentPage = ScreenPage::REMINDER_ALERT;
  drawReminderAlertPage(source != nullptr ? source : "NekoMate", title != nullptr ? title : "Loi nhac");
  audioStart(SoundKind::Reminder);
  emitNotificationEvent("shown", notificationId, atEpoch);
}

void handleTouchPress(uint32_t nowMs) {
  struct tm localTm = {};
  bool clockValid = false;
  int64_t epochSec = 0;
  readClock(localTm, clockValid, epochSec);

  if (alarmPlayingActive) {
    stopAlarmPlayback(clockValid ? localTm.tm_hour : -1, clockValid ? localTm.tm_min : -1, clockValid);
    lastTouchActionMs = nowMs;
    return;
  }
  if (reminderPlayingActive) {
    stopReminderPlayback(
      true,
      clockValid ? localTm.tm_hour : -1,
      clockValid ? localTm.tm_min : -1,
      clockValid,
      epochSec,
      clockValid
    );
    lastTouchActionMs = nowMs;
    return;
  }
  if (audioIsPlaying()) {
    audioStop();
    lastTouchActionMs = nowMs;
    return;
  }
  if (nowMs - lastTouchActionMs < TOUCH_COOLDOWN_MS) {
    return;
  }
  lastTouchActionMs = nowMs;
  happyUntilMs = nowMs + HAPPY_DURATION_MS;
  mood = Mood::HAPPY;
  blinkActive = false;
  audioStart(SoundKind::Meow);
}

void pollTouch(uint32_t nowMs) {
  const bool raw = (digitalRead(TOUCH_PIN) == HIGH);
  if (raw != touchLastRaw) {
    touchLastRaw = raw;
    touchChangedAtMs = nowMs;
  }
  if ((nowMs - touchChangedAtMs) >= TOUCH_DEBOUNCE_MS && raw != touchStable) {
    touchStable = raw;
    if (touchStable) {
      handleTouchPress(nowMs);
    }
  }
}

#ifdef NEKOMATE_SIM
void processSimCommand(const char *cmd, uint32_t nowMs) {
  if (strcmp(cmd, "sim:touch") == 0) {
    handleTouchPress(nowMs);
    return;
  }
  if (strcmp(cmd, "sim:audio stop") == 0) {
    struct tm localTm = {};
    bool clockValid = false;
    int64_t epochSec = 0;
    readClock(localTm, clockValid, epochSec);
    if (alarmPlayingActive) {
      stopAlarmPlayback(clockValid ? localTm.tm_hour : -1, clockValid ? localTm.tm_min : -1, clockValid);
    } else if (reminderPlayingActive) {
      stopReminderPlayback(false, clockValid ? localTm.tm_hour : -1, clockValid ? localTm.tm_min : -1, clockValid, epochSec, clockValid);
    } else {
      audioStop();
    }
    return;
  }
  if (strcmp(cmd, "sim:time invalid") == 0) {
    simClockValid = false;
    Serial.println(F("sim:time invalid"));
    return;
  }
  if (strncmp(cmd, "sim:time ", 9) == 0) {
    int64_t parsedEpoch = 0;
    if (parseIsoTimestamp(cmd + 9, parsedEpoch)) {
      simEpochSec = parsedEpoch;
      simClockValid = true;
      simUseStepClock = true;
      Serial.println(F("sim:time ok"));
    } else {
      Serial.println(F("sim:time error"));
    }
    return;
  }
  if (strcmp(cmd, "sim:wifi off") == 0) {
    mqttSetSimulatedWifi(false);
    Serial.println(F("sim:wifi off"));
    return;
  }
  if (strcmp(cmd, "sim:wifi on") == 0) {
    mqttSetSimulatedWifi(true);
    Serial.println(F("sim:wifi on"));
    return;
  }
  if (strncmp(cmd, "sim:alarm ", 10) == 0) {
    AlarmConfig incoming = {};
    if (!parseAlarmConfigJson(cmd + 10, incoming)) {
      Serial.println(F("alarm:invalid"));
      return;
    }
    const ApplyAlarmResult res = applyAlarmConfig(incoming);
    Serial.print(F("alarm:"));
    Serial.println(applyAlarmResultName(res));
    emitAlarmConfigEvent(res, incoming);
    return;
  }
  if (strncmp(cmd, "sim:notify ", 11) == 0) {
    handleNotifyPayload(cmd + 11, nowMs);
    return;
  }
  if (strncmp(cmd, "sim:advance ", 12) == 0) {
    const long seconds = strtol(cmd + 12, nullptr, 10);
    if (seconds <= 0) {
      return;
    }
    simUseStepClock = true;
    for (long s = 0; s < seconds; s++) {
      if (simClockValid) {
        simEpochSec += 1;
      }
      if (alarmPlayingActive) {
        alarmElapsedSimMs += 1000UL;
        if (alarmElapsedSimMs >= ALARM_MAX_DURATION_MS) {
          struct tm localTm = {};
          bool clockValid = false;
          int64_t epochSec = 0;
          readClock(localTm, clockValid, epochSec);
          stopAlarmPlayback(clockValid ? localTm.tm_hour : -1, clockValid ? localTm.tm_min : -1, clockValid);
        }
      }
      if (reminderPlayingActive) {
        reminderElapsedSimMs += 1000UL;
        if (reminderElapsedSimMs >= REMINDER_MAX_DURATION_MS) {
          struct tm localTm = {};
          bool clockValid = false;
          int64_t epochSec = 0;
          readClock(localTm, clockValid, epochSec);
          stopReminderPlayback(false, clockValid ? localTm.tm_hour : -1, clockValid ? localTm.tm_min : -1, clockValid, epochSec, clockValid);
        }
      }
      audioSimAdvanceMs(1000UL);

      struct tm localTm = {};
      bool clockValid = false;
      int64_t epochSec = 0;
      readClock(localTm, clockValid, epochSec);
      evaluateAlarmTick(nowMs, localTm, clockValid);
    }
    return;
  }
}

void pollSerialSim(uint32_t nowMs) {
  while (Serial.available() > 0) {
    const int ch = Serial.read();
    if (ch < 0) {
      break;
    }
    if (ch == '\r') {
      continue;
    }
    if (ch == '\n') {
      simLineBuf[simLineLen] = '\0';
      if (simLineLen > 0) {
        processSimCommand(simLineBuf, nowMs);
      }
      simLineLen = 0;
    } else if (simLineLen + 1 < sizeof(simLineBuf)) {
      simLineBuf[simLineLen++] = static_cast<char>(ch);
    }
  }
}
#endif

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(2000);  // ST7789 needs time after power-up before init, else it ignores commands
  pinMode(TOUCH_PIN, INPUT_PULLDOWN);  // a loose/missing SIG wire reads LOW instead of random touches

  setenv("TZ", "ICT-7", 1);
  tzset();
#ifndef NEKOMATE_SIM
  configTzTime("ICT-7", "pool.ntp.org", "time.nist.gov", "time.google.com");
#endif

#ifdef NEKOMATE_SIM
  tft.begin();
#else
  tft.init(240, 240, SPI_MODE3);  // 240x240 modules without a CS pin only respond in SPI mode 3
#endif
  tft.setRotation(0);

  alarmInit();
  audioBegin();
  mqttStart();

  const uint32_t nowMs = millis();
  lastTouchActionMs = nowMs;
  lastBlinkMs = nowMs;

  struct tm localTm = {};
  bool clockValid = false;
  int64_t epochSec = 0;
  readClock(localTm, clockValid, epochSec);
  enterFacePage(clockValid ? localTm.tm_hour : -1, clockValid ? localTm.tm_min : -1, clockValid);
}

void loop() {
  const uint32_t nowMs = millis();

  pollTouch(nowMs);
#ifdef NEKOMATE_SIM
  pollSerialSim(nowMs);
#endif
  audioTick();

  MqttInboundMsg inbound = {};
  while (mqttPollInbound(inbound)) {
    if (inbound.topic == MqttInboundTopic::AlarmConfig) {
      handleAlarmConfigPayload(inbound.payload);
    } else if (inbound.topic == MqttInboundTopic::Notify) {
      handleNotifyPayload(inbound.payload, nowMs);
    }
  }

  struct tm localTm = {};
  bool clockValid = false;
  int64_t epochSec = 0;
  readClock(localTm, clockValid, epochSec);

  if (alarmPlayingActive) {
#ifdef NEKOMATE_SIM
    if (!simUseStepClock && (nowMs - alarmStartedRealMs) >= ALARM_MAX_DURATION_MS) {
      stopAlarmPlayback(clockValid ? localTm.tm_hour : -1, clockValid ? localTm.tm_min : -1, clockValid);
    }
#else
    if ((nowMs - alarmStartedRealMs) >= ALARM_MAX_DURATION_MS) {
      stopAlarmPlayback(clockValid ? localTm.tm_hour : -1, clockValid ? localTm.tm_min : -1, clockValid);
    }
#endif
  } else {
    evaluateAlarmTick(nowMs, localTm, clockValid);
  }

  if (reminderPlayingActive) {
#ifdef NEKOMATE_SIM
    if (!simUseStepClock && (nowMs - reminderStartedRealMs) >= REMINDER_MAX_DURATION_MS) {
      stopReminderPlayback(false, clockValid ? localTm.tm_hour : -1, clockValid ? localTm.tm_min : -1, clockValid, epochSec, clockValid);
    }
#else
    if ((nowMs - reminderStartedRealMs) >= REMINDER_MAX_DURATION_MS) {
      stopReminderPlayback(false, clockValid ? localTm.tm_hour : -1, clockValid ? localTm.tm_min : -1, clockValid, epochSec, clockValid);
    }
#endif
  }

  if (currentPage == ScreenPage::FACE) {
    if (mood == Mood::HAPPY && static_cast<int32_t>(nowMs - happyUntilMs) >= 0) {
      mood = Mood::NORMAL;
    }
    if (mood != Mood::HAPPY) {
      mood = (nowMs - lastTouchActionMs > 60000UL) ? Mood::SLEEPY : Mood::NORMAL;
    }

    if (mood == Mood::NORMAL) {
      if (!blinkActive && (nowMs - lastBlinkMs) >= BLINK_INTERVAL_MS) {
        lastBlinkMs = nowMs;
        blinkStartedAtMs = nowMs;
        blinkActive = true;
      } else if (blinkActive && (nowMs - blinkStartedAtMs) >= BLINK_DURATION_MS) {
        blinkActive = false;
      }
    } else {
      blinkActive = false;
    }

    if (mood != shownMood || blinkActive != shownBlink) {
      drawEyeRegion(mood, blinkActive);
      shownMood = mood;
      shownBlink = blinkActive;
    }

    const int curHour = clockValid ? localTm.tm_hour : -1;
    const int curMin = clockValid ? localTm.tm_min : -1;
    if (clockValid != shownClockValid || curHour != shownHour || curMin != shownMinute) {
      drawClockRegion(curHour, curMin, clockValid);
      shownClockValid = clockValid;
      shownHour = curHour;
      shownMinute = curMin;
    }

    const AlarmConfig &cfg = alarmCurrent();
    if (cfg.revision != shownAlarmRev || cfg.enabled != shownAlarmEnabled) {
      drawAlarmBadge();
      shownAlarmRev = cfg.revision;
      shownAlarmEnabled = cfg.enabled;
    }
  }
}

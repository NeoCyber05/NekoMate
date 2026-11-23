/*
  NekoMate · Đồng hồ để bàn thông minh (ESP32-S3)
  Phần cứng: ESP32-S3-DevKitC-1, TFT ST7789 240x240 (SPI), cảm biến chạm TTP223,
             module khuếch đại I2S MAX98357A + loa 8 Ohm / 3 W.
*/
#include <Arduino.h>
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

namespace {

constexpr int TFT_CS = 10;
constexpr int TFT_DC = 14;
constexpr int TFT_RST = 21;   // SCK = 12, MOSI = 11 (SPI mặc định ESP32-S3)
constexpr int TOUCH_PIN = 4;  // TTP223: chạm = HIGH

constexpr uint16_t BG = 0x2105;
constexpr uint16_t FUR = 0xFFDF;
constexpr uint16_t EYE = 0xFE60;
constexpr uint16_t PINK = 0xFB56;
constexpr uint16_t ACCENT = 0x7E5F;

constexpr uint32_t TOUCH_DEBOUNCE_MS = 40;
constexpr uint32_t TOUCH_COOLDOWN_MS = 600;
constexpr uint32_t HAPPY_DURATION_MS = 4000;
constexpr uint32_t BLINK_INTERVAL_MS = 4000;
constexpr uint32_t BLINK_DURATION_MS = 140;
constexpr uint32_t ALARM_MAX_DURATION_MS = 90000;
constexpr int64_t VALID_EPOCH_THRESHOLD = 1700000000LL;

#ifdef NEKOMATE_SIM
Adafruit_ILI9341 tft(TFT_CS, TFT_DC, TFT_RST);
#else
Adafruit_ST7789 tft(TFT_CS, TFT_DC, TFT_RST);
#endif

enum class Mood : uint8_t {
  NORMAL = 0,
  HAPPY = 1,
  SLEEPY = 2
};

enum class ScreenPage : uint8_t {
  FACE = 0,
  ALARM_ALERT = 1
};

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

#ifdef NEKOMATE_SIM
bool simClockValid = false;
int64_t simEpochSec = 0;
bool simWifiOn = true;
bool simUseStepClock = false;
char simLineBuf[384];
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
  // Ho tro YYYY-MM-DDTHH:MM:SS[Z|+HH:MM|-HH:MM]
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

  int32_t offsetSec = 7 * 3600;  // Mac dinh ICT-7 neu khong ghi offset
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

void drawFaceStatic() {
  tft.fillScreen(BG);
  // Tai mèo
  tft.fillTriangle(30, 70, 70, 20, 95, 70, FUR);
  tft.fillTriangle(210, 70, 170, 20, 145, 70, FUR);
  tft.fillTriangle(48, 64, 70, 34, 84, 64, PINK);
  tft.fillTriangle(192, 64, 170, 34, 156, 64, PINK);
  // Mũi và miệng
  tft.fillTriangle(110, 150, 130, 150, 120, 160, PINK);
  tft.drawLine(120, 160, 108, 172, FUR);
  tft.drawLine(120, 160, 132, 172, FUR);
  // Ria mép
  for (int i = 0; i < 2; i++) {
    tft.drawLine(20, 150 + i * 12, 85, 156 + i * 6, FUR);
    tft.drawLine(220, 150 + i * 12, 155, 156 + i * 6, FUR);
  }
}

void drawEyeRegion(Mood m, bool blink) {
  tft.fillRect(50, 90, 50, 44, BG);
  tft.fillRect(140, 90, 50, 44, BG);
  tft.fillRect(192, 74, 24, 24, BG);
  tft.fillRect(210, 54, 24, 22, BG);

  if (m == Mood::SLEEPY || blink) {
    tft.fillRect(55, 115, 40, 6, FUR);
    tft.fillRect(145, 115, 40, 6, FUR);
    if (m == Mood::SLEEPY) {
      tft.setTextColor(FUR);
      tft.setTextSize(3);
      tft.setCursor(194, 76);
      tft.print(F("z"));
      tft.setTextSize(2);
      tft.setCursor(212, 58);
      tft.print(F("z"));
    }
  } else if (m == Mood::HAPPY) {
    for (int i = 0; i < 4; i++) {
      tft.drawLine(55, 125 - i, 75, 105 - i, EYE);
      tft.drawLine(75, 105 - i, 95, 125 - i, EYE);
      tft.drawLine(145, 125 - i, 165, 105 - i, EYE);
      tft.drawLine(165, 105 - i, 185, 125 - i, EYE);
    }
  } else {
    tft.fillRoundRect(60, 95, 30, 36, 10, EYE);
    tft.fillRoundRect(150, 95, 30, 36, 10, EYE);
    tft.fillRect(71, 100, 8, 26, BG);
    tft.fillRect(161, 100, 8, 26, BG);
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
  if (cfg.revision > 0 && cfg.enabled) {
    char buf[24];
    snprintf(buf, sizeof(buf), "BAO THUC %02u:%02u", cfg.hour, cfg.minute);
    tft.setTextColor(EYE);
    tft.print(buf);
  } else {
    tft.setTextColor(ACCENT);
    tft.print(F("NEKOMATE READY"));
  }
}

void drawAlarmAlertPage(int hour, int minute, bool clockValid) {
  tft.fillScreen(BG);
  tft.drawRoundRect(14, 18, 212, 204, 16, EYE);
  tft.setTextColor(EYE);
  tft.setTextSize(3);
  tft.setCursor(48, 52);
  tft.print(F("BAO THUC"));
  tft.setTextColor(FUR);
  tft.setTextSize(4);
  tft.setCursor(60, 106);
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
  tft.setTextSize(2);
  tft.setTextColor(PINK);
  tft.setCursor(44, 174);
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

void evaluateAlarmTick(uint32_t nowMs, const struct tm &localTm, bool clockValid) {
  if (alarmDue(localTm, clockValid)) {
    alarmPlayingActive = true;
    alarmStartedRealMs = nowMs;
    alarmElapsedSimMs = 0;
    currentPage = ScreenPage::ALARM_ALERT;
    drawAlarmAlertPage(localTm.tm_hour, localTm.tm_min, clockValid);
    audioStart(SoundKind::Alarm);
  }
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
    simWifiOn = false;
    Serial.println(F("sim:wifi off"));
    return;
  }
  if (strcmp(cmd, "sim:wifi on") == 0) {
    simWifiOn = true;
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
  pinMode(TOUCH_PIN, INPUT);

  setenv("TZ", "ICT-7", 1);
  tzset();
#ifndef NEKOMATE_SIM
  configTzTime("ICT-7", "pool.ntp.org", "time.nist.gov", "time.google.com");
#endif

#ifdef NEKOMATE_SIM
  tft.begin();
#else
  tft.init(240, 240);
#endif
  tft.setRotation(0);

  alarmInit();
  audioBegin();

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

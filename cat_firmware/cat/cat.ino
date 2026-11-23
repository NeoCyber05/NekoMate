/*
  NekoMate · Đồng hồ để bàn thông minh (ESP32-S3)
  Phần cứng: ESP32-S3-DevKitC-1, TFT ST7789 240x240 (SPI), cảm biến chạm TTP223,
             module khuếch đại I2S MAX98357A + loa 8 Ohm / 3 W.
*/
#include <Arduino.h>
#include <SPI.h>
#include <Adafruit_GFX.h>

#ifdef NEKOMATE_SIM
#include <Adafruit_ILI9341.h>
#else
#include <Adafruit_ST7789.h>
#endif

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

constexpr uint32_t TOUCH_DEBOUNCE_MS = 40;
constexpr uint32_t TOUCH_COOLDOWN_MS = 600;
constexpr uint32_t HAPPY_DURATION_MS = 4000;
constexpr uint32_t BLINK_INTERVAL_MS = 4000;
constexpr uint32_t BLINK_DURATION_MS = 140;

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
  ALERT = 1
};

ScreenPage currentPage = ScreenPage::FACE;
bool screenInitialized = false;
Mood mood = Mood::NORMAL;
Mood shownMood = Mood::SLEEPY;
bool blinkActive = false;
bool shownBlink = false;

uint32_t lastTouchActionMs = 0;
uint32_t happyUntilMs = 0;
uint32_t lastBlinkMs = 0;
uint32_t blinkStartedAtMs = 0;

bool touchLastRaw = false;
bool touchStable = false;
uint32_t touchChangedAtMs = 0;

#ifdef NEKOMATE_SIM
char simLineBuf[256];
size_t simLineLen = 0;
#endif

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
  // Chỉ xóa và vẽ lại vùng mắt & ký tự z (không động tới tai, mũi, ria)
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

void ensureFacePage() {
  if (!screenInitialized || currentPage != ScreenPage::FACE) {
    currentPage = ScreenPage::FACE;
    screenInitialized = true;
    drawFaceStatic();
    drawEyeRegion(mood, blinkActive);
    shownMood = mood;
    shownBlink = blinkActive;
  }
}

void handleTouchPress(uint32_t nowMs) {
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
  } else if (strcmp(cmd, "sim:audio stop") == 0) {
    audioStop();
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

#ifdef NEKOMATE_SIM
  tft.begin();
#else
  tft.init(240, 240);
#endif
  tft.setRotation(0);

  audioBegin();

  const uint32_t nowMs = millis();
  lastTouchActionMs = nowMs;
  lastBlinkMs = nowMs;
  ensureFacePage();
}

void loop() {
  const uint32_t nowMs = millis();

  pollTouch(nowMs);
#ifdef NEKOMATE_SIM
  pollSerialSim(nowMs);
#endif
  audioTick();

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

  ensureFacePage();
  if (mood != shownMood || blinkActive != shownBlink) {
    drawEyeRegion(mood, blinkActive);
    shownMood = mood;
    shownBlink = blinkActive;
  }
}

#include "audio.h"

#include <math.h>

#ifndef NEKOMATE_SIM
#include <ESP_I2S.h>
#endif

namespace {

constexpr int I2S_BCLK_PIN = 5;
constexpr int I2S_LRC_PIN = 6;
constexpr int I2S_DIN_PIN = 7;

constexpr uint32_t SAMPLE_RATE = 16000;
constexpr size_t CHUNK_FRAMES = 128;
constexpr int16_t MAX_AMPLITUDE = 6500;  // ~20% full scale: an toan khi thu loa lan dau
constexpr uint32_t MEOW_DURATION_MS = 420;
constexpr float TWO_PI_F = 6.28318530718f;

bool g_initialized = false;
bool g_playing = false;
SoundKind g_kind = SoundKind::Meow;
uint32_t g_elapsedSamples = 0;
float g_phase = 0.0f;

#ifdef NEKOMATE_SIM
uint32_t g_simStartMs = 0;
uint32_t g_simVirtualElapsedMs = 0;
bool g_simUseVirtualClock = false;

const char *soundKindLabel(SoundKind kind) {
  switch (kind) {
    case SoundKind::Meow: return "Meow";
    case SoundKind::Alarm: return "Alarm";
    case SoundKind::Reminder: return "Reminder";
  }
  return "Meow";
}
#else
I2SClass g_i2s;
int16_t g_pcmBuffer[CHUNK_FRAMES * 2];  // stereo interleaved (L = R)

int16_t synthSample(SoundKind kind, uint32_t sampleIdx, float &phase) {
  const uint32_t ms = (sampleIdx * 1000UL) / SAMPLE_RATE;
  float freq = 0.0f;
  float env = 0.0f;

  if (kind == SoundKind::Meow) {
    if (ms >= MEOW_DURATION_MS) {
      return 0;
    }
    if (ms < 160) {
      freq = 860.0f + (440.0f * (static_cast<float>(ms) / 160.0f));
    } else {
      freq = 1300.0f - (560.0f * (static_cast<float>(ms - 160) / 260.0f));
    }
    if (ms < 30) {
      env = static_cast<float>(ms) / 30.0f;
    } else if (ms > 340) {
      env = static_cast<float>(MEOW_DURATION_MS - ms) / 80.0f;
    } else {
      env = 1.0f;
    }
  } else if (kind == SoundKind::Alarm) {
    // Nhip bip doi 1000ms: 0..140ms va 220..360ms keu 1046Hz/1318Hz
    const uint32_t cycle = ms % 1000;
    if (cycle < 140) {
      freq = 1046.5f;
      env = (cycle < 12) ? (static_cast<float>(cycle) / 12.0f) : 1.0f;
    } else if (cycle >= 220 && cycle < 360) {
      freq = 1318.5f;
      const uint32_t p = cycle - 220;
      env = (p < 12) ? (static_cast<float>(p) / 12.0f) : 1.0f;
    } else {
      return 0;
    }
  } else {
    // Reminder: chuong nhe 1400ms (880Hz -> 1175Hz)
    const uint32_t cycle = ms % 1400;
    if (cycle < 160) {
      freq = 880.0f;
      env = 1.0f - (static_cast<float>(cycle) / 220.0f);
    } else if (cycle >= 200 && cycle < 460) {
      freq = 1174.66f;
      env = 1.0f - (static_cast<float>(cycle - 200) / 320.0f);
    } else {
      return 0;
    }
  }

  phase += (TWO_PI_F * freq) / static_cast<float>(SAMPLE_RATE);
  if (phase >= TWO_PI_F) {
    phase -= TWO_PI_F;
  }
  const float sample = sinf(phase) * env * static_cast<float>(MAX_AMPLITUDE);
  return static_cast<int16_t>(sample);
}

void writeSilenceTail() {
  memset(g_pcmBuffer, 0, sizeof(g_pcmBuffer));
  g_i2s.write(reinterpret_cast<const uint8_t *>(g_pcmBuffer), sizeof(g_pcmBuffer));
}
#endif

}  // namespace

bool audioBegin() {
#ifdef NEKOMATE_SIM
  g_initialized = true;
  g_playing = false;
  return true;
#else
  g_i2s.setPins(I2S_BCLK_PIN, I2S_LRC_PIN, I2S_DIN_PIN);
  g_i2s.setTimeout(2);
  if (!g_i2s.begin(I2S_MODE_STD, SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO)) {
    g_initialized = false;
    return false;
  }
  g_initialized = true;
  g_playing = false;
  writeSilenceTail();
  return true;
#endif
}

void audioStart(SoundKind kind) {
  if (!g_initialized) {
    return;
  }
  if (g_playing && g_kind == kind) {
    return;
  }
  if (g_playing) {
    audioStop();
  }
  g_kind = kind;
  g_elapsedSamples = 0;
  g_phase = 0.0f;
  g_playing = true;
#ifdef NEKOMATE_SIM
  g_simStartMs = millis();
  g_simVirtualElapsedMs = 0;
  g_simUseVirtualClock = false;
  Serial.print(F("audio:start "));
  Serial.println(soundKindLabel(kind));
#endif
}

void audioTick() {
  if (!g_initialized || !g_playing) {
    return;
  }
#ifdef NEKOMATE_SIM
  if (g_kind == SoundKind::Meow) {
    const uint32_t elapsed = g_simUseVirtualClock ? g_simVirtualElapsedMs : (millis() - g_simStartMs);
    if (elapsed >= MEOW_DURATION_MS) {
      audioStop();
    }
  }
  return;
#else
  if (g_kind == SoundKind::Meow && ((g_elapsedSamples * 1000UL) / SAMPLE_RATE) >= MEOW_DURATION_MS) {
    audioStop();
    return;
  }

  float localPhase = g_phase;
  uint32_t localSample = g_elapsedSamples;
  for (size_t i = 0; i < CHUNK_FRAMES; i++) {
    const int16_t s = synthSample(g_kind, localSample, localPhase);
    g_pcmBuffer[i * 2] = s;
    g_pcmBuffer[i * 2 + 1] = s;
    localSample++;
  }

  const size_t bytesWritten = g_i2s.write(reinterpret_cast<const uint8_t *>(g_pcmBuffer), sizeof(g_pcmBuffer));
  const size_t framesWritten = bytesWritten / (sizeof(int16_t) * 2);
  if (framesWritten == CHUNK_FRAMES) {
    g_phase = localPhase;
    g_elapsedSamples = localSample;
  } else if (framesWritten > 0) {
    // Chi tien bo dem cho dung so frame DMA da nhan
    for (size_t i = 0; i < framesWritten; i++) {
      synthSample(g_kind, g_elapsedSamples, g_phase);
      g_elapsedSamples++;
    }
  }
#endif
}

void audioStop() {
  if (!g_playing) {
    return;
  }
  g_playing = false;
#ifdef NEKOMATE_SIM
  Serial.println(F("audio:stop"));
#else
  if (g_initialized) {
    writeSilenceTail();
  }
#endif
}

bool audioIsPlaying() {
  return g_playing;
}

SoundKind audioCurrentKind() {
  return g_kind;
}

#ifdef NEKOMATE_SIM
void audioSimAdvanceMs(uint32_t deltaMs) {
  if (!g_playing) {
    return;
  }
  g_simUseVirtualClock = true;
  g_simVirtualElapsedMs += deltaMs;
  audioTick();
}
#endif

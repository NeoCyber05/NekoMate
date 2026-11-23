#pragma once

#include <Arduino.h>
#include <stdint.h>

enum class SoundKind : uint8_t {
  Meow = 0,
  Alarm = 1,
  Reminder = 2
};

bool audioBegin();
void audioStart(SoundKind kind);
void audioTick();
void audioStop();
bool audioIsPlaying();
SoundKind audioCurrentKind();

#ifdef NEKOMATE_SIM
void audioSimAdvanceMs(uint32_t deltaMs);
#endif

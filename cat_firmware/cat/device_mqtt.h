#pragma once

#include <stddef.h>
#include <stdint.h>

enum class MqttInboundTopic : uint8_t {
  Notify = 0,
  AlarmConfig = 1
};

struct MqttInboundMsg {
  MqttInboundTopic topic;
  char payload[2304];
  size_t len;
};

bool mqttStart();
bool mqttPollInbound(MqttInboundMsg &out);
bool mqttEnqueueEvent(const char *json);
bool mqttEnqueueStatus(bool online);
bool mqttIsConnected();
void mqttSetSimulatedWifi(bool on);

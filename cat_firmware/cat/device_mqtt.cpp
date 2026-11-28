#include "device_mqtt.h"

#include <Arduino.h>
#include <WiFi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>
#include <mqtt_client.h>
#include <stdio.h>
#include <string.h>

#if __has_include("secrets.h")
#include "secrets.h"

#include <esp_crt_bundle.h>

#ifndef MQTT_WS_PATH
#define MQTT_WS_PATH ""
#endif
#else
#define WIFI_SSID "Wokwi-GUEST"
#define WIFI_PASS ""
#define MQTT_HOST "127.0.0.1"
#define MQTT_PORT 1883
#define MQTT_USE_TLS 0
#define MQTT_USER "nekomate-01"
#define MQTT_PASS "change-me-device-password"
#define DEVICE_ID "nekomate-01"
#define MQTT_CA_CERT ""
#endif

namespace {

constexpr size_t RX_QUEUE_LEN = 8;
constexpr size_t TX_QUEUE_LEN = 8;

enum class MqttOutboundKind : uint8_t {
  Event = 0,
  Status = 1
};

struct MqttOutboundMsg {
  MqttOutboundKind kind;
  bool retain;
  char payload[256];
  size_t len;
};

QueueHandle_t g_rxQueue = nullptr;
QueueHandle_t g_txQueue = nullptr;
esp_mqtt_client_handle_t g_client = nullptr;
TaskHandle_t g_netTask = nullptr;

char g_topicNotify[96];
char g_topicAlarmConfig[96];
char g_topicEvents[96];
char g_topicStatus[96];

volatile bool g_wifiEnabled = true;
volatile bool g_mqttConnected = false;
volatile bool g_subsReady = false;
volatile int g_subNotifyMsgId = -1;
volatile int g_subAlarmMsgId = -1;
volatile bool g_subNotifyAck = false;
volatile bool g_subAlarmAck = false;

// Bo dem ghep manh MQTT_EVENT_DATA (chay duy nhat trong context mqtt task)
MqttInboundMsg g_rxPartial = {};
int g_rxExpectedLen = 0;
bool g_rxActive = false;
bool g_rxOversized = false;

bool matchTopic(const char *topic, int topicLen, const char *expected) {
  if (topic == nullptr || topicLen <= 0) {
    return false;
  }
  const size_t expLen = strlen(expected);
  return static_cast<size_t>(topicLen) == expLen && strncmp(topic, expected, expLen) == 0;
}

void handleMqttData(esp_mqtt_event_handle_t event) {
  if (event->current_data_offset == 0) {
    g_rxActive = false;
    g_rxOversized = false;
    g_rxExpectedLen = event->total_data_len;

    MqttInboundTopic parsedTopic = MqttInboundTopic::Notify;
    if (matchTopic(event->topic, event->topic_len, g_topicNotify)) {
      parsedTopic = MqttInboundTopic::Notify;
    } else if (matchTopic(event->topic, event->topic_len, g_topicAlarmConfig)) {
      parsedTopic = MqttInboundTopic::AlarmConfig;
    } else {
      g_rxOversized = true;
      return;
    }

    if (event->total_data_len <= 0 ||
        static_cast<size_t>(event->total_data_len) >= sizeof(g_rxPartial.payload)) {
      // Qua gioi han kich thuoc -> bo toan bo ban tin
      g_rxOversized = true;
      return;
    }

    memset(&g_rxPartial, 0, sizeof(g_rxPartial));
    g_rxPartial.topic = parsedTopic;
    g_rxActive = true;
  }

  if (!g_rxActive || g_rxOversized) {
    return;
  }

  if (event->current_data_offset < 0 || event->data_len < 0) {
    g_rxOversized = true;
    g_rxActive = false;
    return;
  }

  const size_t offset = static_cast<size_t>(event->current_data_offset);
  const size_t chunkLen = static_cast<size_t>(event->data_len);
  if (offset + chunkLen >= sizeof(g_rxPartial.payload) ||
      static_cast<int>(offset + chunkLen) > g_rxExpectedLen) {
    g_rxOversized = true;
    g_rxActive = false;
    return;
  }

  if (chunkLen > 0 && event->data != nullptr) {
    memcpy(g_rxPartial.payload + offset, event->data, chunkLen);
  }

  if (static_cast<int>(offset + chunkLen) == g_rxExpectedLen) {
    g_rxPartial.payload[g_rxExpectedLen] = '\0';
    g_rxPartial.len = static_cast<size_t>(g_rxExpectedLen);
    g_rxActive = false;
    if (g_rxQueue != nullptr) {
      xQueueSend(g_rxQueue, &g_rxPartial, 0);
    }
  }
}

void mqttEventHandler(void *handlerArgs, esp_event_base_t base, int32_t eventId, void *eventData) {
  (void)handlerArgs;
  (void)base;
  esp_mqtt_event_handle_t event = static_cast<esp_mqtt_event_handle_t>(eventData);

  switch (static_cast<esp_mqtt_event_id_t>(eventId)) {
    case MQTT_EVENT_CONNECTED:
      Serial.println(F("net:mqtt connected"));
      g_mqttConnected = true;
      g_subsReady = false;
      g_subNotifyAck = false;
      g_subAlarmAck = false;
      g_subNotifyMsgId = esp_mqtt_client_subscribe(g_client, g_topicNotify, 1);
      g_subAlarmMsgId = esp_mqtt_client_subscribe(g_client, g_topicAlarmConfig, 1);
      break;

    case MQTT_EVENT_DISCONNECTED:
      Serial.println(F("net:mqtt disconnected"));
      g_mqttConnected = false;
      g_subsReady = false;
      g_rxActive = false;
      g_rxOversized = false;
      break;

    case MQTT_EVENT_SUBSCRIBED:
      if (event->msg_id == g_subNotifyMsgId) {
        g_subNotifyAck = true;
      }
      if (event->msg_id == g_subAlarmMsgId) {
        g_subAlarmAck = true;
      }
      if (g_subNotifyAck && g_subAlarmAck && !g_subsReady) {
        g_subsReady = true;
        mqttEnqueueStatus(true);
      }
      break;

    case MQTT_EVENT_DATA:
      handleMqttData(event);
      break;

    default:
      break;
  }
}

void networkTask(void *arg) {
  (void)arg;
  bool wifiStarted = false;
  bool mqttClientStarted = false;

  for (;;) {
    if (!g_wifiEnabled) {
      if (mqttClientStarted && g_client != nullptr) {
        esp_mqtt_client_stop(g_client);
        mqttClientStarted = false;
        g_mqttConnected = false;
        g_subsReady = false;
      }
      if (wifiStarted) {
        WiFi.disconnect(true);
        wifiStarted = false;
      }
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    if (!wifiStarted && strlen(WIFI_SSID) > 0) {
      WiFi.mode(WIFI_STA);
      WiFi.setAutoReconnect(true);
      WiFi.begin(WIFI_SSID, WIFI_PASS);
      wifiStarted = true;
    }

    static wl_status_t lastWifi = WL_IDLE_STATUS;
    const wl_status_t wifiNow = WiFi.status();
    if (wifiNow != lastWifi) {
      lastWifi = wifiNow;
      Serial.printf("net:wifi status=%d ip=%s\n", static_cast<int>(wifiNow), WiFi.localIP().toString().c_str());
    }

    if (wifiNow == WL_CONNECTED) {
      if (!mqttClientStarted && g_client != nullptr && strlen(MQTT_HOST) > 0) {
        if (esp_mqtt_client_start(g_client) == ESP_OK) {
          mqttClientStarted = true;
        }
      }

      if (g_mqttConnected && g_subsReady && g_txQueue != nullptr && g_client != nullptr) {
        MqttOutboundMsg outMsg = {};
        while (xQueueReceive(g_txQueue, &outMsg, 0) == pdTRUE) {
          const char *topic = (outMsg.kind == MqttOutboundKind::Status) ? g_topicStatus : g_topicEvents;
          esp_mqtt_client_enqueue(
            g_client,
            topic,
            outMsg.payload,
            static_cast<int>(outMsg.len),
            1,
            outMsg.retain ? 1 : 0,
            true
          );
        }
      }
    }

    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

}  // namespace

bool mqttStart() {
  snprintf(g_topicNotify, sizeof(g_topicNotify), "nekomate/devices/%s/notify", DEVICE_ID);
  snprintf(g_topicAlarmConfig, sizeof(g_topicAlarmConfig), "nekomate/devices/%s/alarms/config", DEVICE_ID);
  snprintf(g_topicEvents, sizeof(g_topicEvents), "nekomate/devices/%s/events", DEVICE_ID);
  snprintf(g_topicStatus, sizeof(g_topicStatus), "nekomate/devices/%s/status", DEVICE_ID);

  g_rxQueue = xQueueCreate(RX_QUEUE_LEN, sizeof(MqttInboundMsg));
  g_txQueue = xQueueCreate(TX_QUEUE_LEN, sizeof(MqttOutboundMsg));
  if (g_rxQueue == nullptr || g_txQueue == nullptr) {
    return false;
  }

  esp_mqtt_client_config_t cfg = {};
  cfg.broker.address.hostname = MQTT_HOST;
  cfg.broker.address.port = MQTT_PORT;
  cfg.broker.address.transport = (MQTT_USE_TLS != 0) ? MQTT_TRANSPORT_OVER_SSL : MQTT_TRANSPORT_OVER_TCP;
#if MQTT_USE_TLS != 0
  if (strlen(MQTT_WS_PATH) > 0) {
    // VPS deploy: wss://MQTT_HOST/mqtt through Caddy on port 443
    cfg.broker.address.transport = MQTT_TRANSPORT_OVER_WSS;
    cfg.broker.address.path = MQTT_WS_PATH;
  }
  if (strlen(MQTT_CA_CERT) > 0) {
    cfg.broker.verification.certificate = MQTT_CA_CERT;
  } else {
    cfg.broker.verification.crt_bundle_attach = esp_crt_bundle_attach;  // public CAs (Let's Encrypt)
  }
#endif
  if (strlen(MQTT_USER) > 0) {
    cfg.credentials.username = MQTT_USER;
  }
  if (strlen(MQTT_PASS) > 0) {
    cfg.credentials.authentication.password = MQTT_PASS;
  }
  cfg.session.protocol_ver = MQTT_PROTOCOL_V_3_1_1;
  cfg.session.last_will.topic = g_topicStatus;
  cfg.session.last_will.msg = "{\"online\":false}";
  cfg.session.last_will.msg_len = 16;
  cfg.session.last_will.qos = 1;
  cfg.session.last_will.retain = 1;
  cfg.buffer.size = 1024;
  cfg.network.reconnect_timeout_ms = 5000;

  g_client = esp_mqtt_client_init(&cfg);
  if (g_client == nullptr) {
    return false;
  }
  esp_mqtt_client_register_event(g_client, MQTT_EVENT_ANY, mqttEventHandler, nullptr);

  xTaskCreate(networkTask, "nekomate_mqtt", 6144, nullptr, 1, &g_netTask);
  return true;
}

bool mqttPollInbound(MqttInboundMsg &out) {
  if (g_rxQueue == nullptr) {
    return false;
  }
  return xQueueReceive(g_rxQueue, &out, 0) == pdTRUE;
}

bool mqttEnqueueEvent(const char *json) {
  if (json == nullptr) {
    return false;
  }
  const size_t len = strlen(json);
  if (len == 0 || len >= sizeof(MqttOutboundMsg::payload)) {
    return false;
  }

#ifdef NEKOMATE_SIM
  Serial.print(F("mqtt:event "));
  Serial.println(json);
#endif

  if (g_txQueue == nullptr) {
    return false;
  }
  MqttOutboundMsg msg = {};
  msg.kind = MqttOutboundKind::Event;
  msg.retain = false;
  memcpy(msg.payload, json, len + 1);
  msg.len = len;
  return xQueueSend(g_txQueue, &msg, 0) == pdTRUE;
}

bool mqttEnqueueStatus(bool online) {
  MqttOutboundMsg msg = {};
  msg.kind = MqttOutboundKind::Status;
  msg.retain = true;
  snprintf(msg.payload, sizeof(msg.payload), "{\"online\":%s}", online ? "true" : "false");
  msg.len = strlen(msg.payload);

#ifdef NEKOMATE_SIM
  Serial.print(F("mqtt:status "));
  Serial.println(msg.payload);
#endif

  if (g_txQueue == nullptr) {
    return false;
  }
  return xQueueSend(g_txQueue, &msg, 0) == pdTRUE;
}

bool mqttIsConnected() {
  return g_mqttConnected && g_subsReady;
}

void mqttSetSimulatedWifi(bool on) {
  g_wifiEnabled = on;
}

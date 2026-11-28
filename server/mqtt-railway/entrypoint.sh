#!/bin/sh
# Builds the password file from Railway variables, so no secret lives in git.
set -e
: "${MQTT_SERVER_PASSWORD:?set MQTT_SERVER_PASSWORD}"
: "${MQTT_DEVICE_PASSWORD:?set MQTT_DEVICE_PASSWORD}"

passwd=/mosquitto/auth/passwd
rm -f "$passwd"
mosquitto_passwd -c -b "$passwd" nekomate-server "$MQTT_SERVER_PASSWORD"
mosquitto_passwd -b "$passwd" nekomate-01 "$MQTT_DEVICE_PASSWORD"

mkdir -p /mosquitto/data
chown -R mosquitto:mosquitto /mosquitto/auth /mosquitto/data
chmod 0600 "$passwd" /mosquitto/auth/acl

exec mosquitto -c /mosquitto/config/mosquitto.conf

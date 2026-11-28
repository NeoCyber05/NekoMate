# Mosquitto broker as a Railway service (Root Directory: server/mqtt-railway).
# Public domain -> port 9001 (WebSocket, Railway terminates TLS) for the ESP32.
# Private network -> port 1883 for the NekoMate server.
FROM eclipse-mosquitto:2
COPY mosquitto.conf /mosquitto/config/mosquitto.conf
COPY acl /mosquitto/auth/acl
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 1883 9001
ENTRYPOINT ["/entrypoint.sh"]

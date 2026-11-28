# Deploy NekoMate lên VPS

Kiến trúc trên VPS (`server/compose.prod.yaml`):

```
ESP32 ──wss://DOMAIN/mqtt──┐
                           ├─ Caddy :443 (HTTPS tự động, Let's Encrypt)
Trình duyệt ─https://DOMAIN┘     ├─ /mqtt → mosquitto:9001 (WebSocket)
                                 └─ /     → app:3000 (server + dashboard)
                                 app ──mqtt://mqtt:1883 (nội bộ Docker)
```

Chỉ mở cổng 80 và 443. Mosquitto không lộ ra internet trực tiếp.

## Cần chuẩn bị

- VPS Ubuntu 22.04/24.04, 1 vCPU, 1 GB RAM là đủ.
- Tên miền (hoặc tên miền con) có bản ghi **A** trỏ về IP VPS.

## 1. Cài Docker trên VPS

```bash
curl -fsSL https://get.docker.com | sh
sudo ufw allow 22,80,443/tcp && sudo ufw --force enable
```

## 2. Đưa code lên VPS

```bash
git clone <repo> nekomate && cd nekomate/server
```

## 3. Cấu hình bí mật (trên VPS, không commit)

```bash
cp .env.example .env
docker run --rm -v "$PWD/src:/app/src" -w /app node:22-slim node src/hash-password.ts "MAT-KHAU-DASHBOARD"
```

Sửa `.env`:

- `DOMAIN=ten-mien-cua-ban.com`
- `OWNER_PASSWORD_HASH='<hash vừa in>'`: giữ dấu nháy đơn.
- `MQTT_PASSWORD=<mật khẩu nekomate-server>`
- `COMPOSIO_API_KEY=...` (nếu dùng nguồn lịch)

Tạo tài khoản MQTT (mật khẩu thiết bị phải khớp `MQTT_PASS` trong `secrets.h` của ESP32):

```bash
docker run --rm -v "$PWD/mosquitto:/work" eclipse-mosquitto:2 sh -c \
  "mosquitto_passwd -c -b /work/passwd nekomate-server 'MAT-KHAU-SERVER' && \
   mosquitto_passwd -b /work/passwd nekomate-01 'MAT-KHAU-THIET-BI' && chmod 0644 /work/passwd"
```

## 4. Chạy

```bash
docker compose -f compose.prod.yaml up -d --build
docker compose -f compose.prod.yaml logs -f caddy   # chờ dòng "certificate obtained successfully"
```

Mở `https://DOMAIN` để vào dashboard.

## 5. Nạp lại ESP32

Trong `cat_firmware/cat/secrets.h`:

```c
#define MQTT_HOST "ten-mien-cua-ban.com"
#define MQTT_PORT 443
#define MQTT_USE_TLS 1
#define MQTT_WS_PATH "/mqtt"
#define MQTT_CA_CERT ""   // để trống: dùng bộ root CA có sẵn trong ESP32
```

Wi-Fi giờ là mạng bất kỳ có internet, không cần cùng mạng với server.

## Cập nhật phiên bản mới

```bash
git pull && docker compose -f compose.prod.yaml up -d --build
```

## Sao lưu

Dữ liệu nằm trong volume `app_data` (SQLite). Sao lưu:

```bash
docker compose -f compose.prod.yaml exec app sh -c 'cat /app/data/nekomate.db' > backup-$(date +%F).db
```

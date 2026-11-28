# Deploy NekoMate lên Railway + HiveMQ Cloud

Không cần VPS, không cần tên miền riêng. Máy tính của bạn tắt cũng được.

```
ESP32 ──mqtts://<cluster>.hivemq.cloud:8883──▶ HiveMQ Cloud (broker)
                                                  ▲
Railway (server + dashboard + SQLite) ──mqtts─────┘
Trình duyệt ──https://<app>.up.railway.app──▶ Railway
```

Caddy, Mosquitto, `compose.prod.yaml` không dùng ở cách này (chúng dành cho [deploy-vps.md](deploy-vps.md)).

## 1. Broker MQTT trên HiveMQ Cloud

1. Đăng ký <https://console.hivemq.cloud>, tạo cluster **Serverless (Free)**.
2. Ghi lại **Cluster URL** (dạng `xxxxxxxx.s1.eu.hivemq.cloud`), cổng TLS **8883**.
3. Mục **Access Management → Credentials**, tạo 2 tài khoản (quyền Publish and Subscribe):
   - `nekomate-server` / mật khẩu server
   - `nekomate-01` / mật khẩu thiết bị

## 2. Tạo mật khẩu dashboard (trên máy bạn)

```bash
cd server
npm run hash-password -- "MAT-KHAU-DASHBOARD"
```

Giữ chuỗi hash in ra cho bước 3.

## 3. Server trên Railway

1. <https://railway.com> → **New Project → Deploy from GitHub repo** → chọn repo NekoMate.
2. Vào service → **Settings**:
   - **Root Directory**: `server` (Railway tự build bằng `server/Dockerfile`).
   - **Networking → Generate Domain**, ghi lại `https://<app>.up.railway.app`.
3. Chuột phải service → **Attach Volume**, Mount path: `/app/data` (giữ SQLite qua mỗi lần deploy).
4. Tab **Variables**, thêm:

   | Biến | Giá trị |
   |---|---|
   | `HOST` | `0.0.0.0` (bắt buộc, mặc định 127.0.0.1 thì Railway không vào được) |
   | `APP_BASE_URL` | `https://<app>.up.railway.app` |
   | `OWNER_PASSWORD_HASH` | hash ở bước 2 (dán nguyên, không cần dấu nháy) |
   | `DB_PATH` | `/app/data/nekomate.db` |
   | `MQTT_URL` | `mqtts://<cluster-url>:8883` |
   | `MQTT_USERNAME` | `nekomate-server` |
   | `MQTT_PASSWORD` | mật khẩu server ở bước 1 |
   | `COMPOSIO_API_KEY` | nếu dùng nguồn lịch |

   `PORT` do Railway tự đặt, không cần thêm. `DEVICE_ID`, `TIMEZONE` có mặc định.
5. Deploy. Xem **Deploy Logs**, mở `https://<app>.up.railway.app` để đăng nhập dashboard.

Mỗi lần `git push` lên nhánh đã chọn, Railway tự deploy lại.

## 4. Nạp lại ESP32

Trong `cat_firmware/cat/secrets.h`:

```c
#define MQTT_HOST "<cluster-url>"      // không có mqtts://
#define MQTT_PORT 8883
#define MQTT_USE_TLS 1
#define MQTT_USER "nekomate-01"
#define MQTT_PASS "<mật khẩu thiết bị>"
#define MQTT_WS_PATH ""                // TCP/TLS thường
#define MQTT_CA_CERT ""                // dùng bộ root CA có sẵn trong ESP32
```

ESP32 chỉ cần Wi-Fi có internet, không cần cùng mạng với server.

## Sao lưu

Railway → service → **Volume → Backups** (tạo bản sao lưu thủ công hoặc theo lịch).

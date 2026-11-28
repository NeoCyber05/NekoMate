# Deploy NekoMate lên Railway

Không cần VPS, không cần tên miền riêng, không cần broker bên ngoài. Máy tính của bạn tắt cũng được.

```
ESP32 ──wss://<mqtt>.up.railway.app:443/mqtt──▶ service "mosquitto" :9001 (WebSocket)
                                                     ▲
service "app" ──mqtt://mosquitto.railway.internal:1883 (mạng nội bộ Railway)
Trình duyệt ──https://<app>.up.railway.app──▶ service "app" (server + dashboard + SQLite)
```

Hai service trong cùng một project Railway, build từ cùng repo GitHub:

| Service | Root Directory | Build từ |
|---|---|---|
| `mosquitto` | `server/mqtt-railway` | `server/mqtt-railway/Dockerfile` |
| `app` | `server` | `server/Dockerfile` |

Caddy và `compose.prod.yaml` không dùng ở cách này (chúng dành cho [deploy-vps.md](deploy-vps.md)).

## 0. Chuẩn bị (trên máy bạn)

Tự nghĩ 3 mật khẩu, lưu ở chỗ an toàn:

- mật khẩu MQTT của server
- mật khẩu MQTT của thiết bị (ESP32)
- mật khẩu đăng nhập dashboard

Tạo hash cho mật khẩu dashboard:

```bash
cd server
npm run hash-password -- "MAT-KHAU-DASHBOARD"
```

## 1. Service `mosquitto`

1. <https://railway.com> → **New Project → Deploy from GitHub repo** → chọn repo NekoMate.
2. Service vừa tạo → **Settings**:
   - **Service Name**: `mosquitto` (tên này tạo ra địa chỉ nội bộ `mosquitto.railway.internal`).
   - **Root Directory**: `server/mqtt-railway`.
   - **Networking → Generate Domain**, ô port nhập **9001**. Ghi lại `<mqtt>.up.railway.app`.
3. **Variables**:

   | Biến | Giá trị |
   |---|---|
   | `MQTT_SERVER_PASSWORD` | mật khẩu MQTT của server |
   | `MQTT_DEVICE_PASSWORD` | mật khẩu MQTT của thiết bị |

4. (Nên làm) Chuột phải service → **Attach Volume**, mount path `/mosquitto/data`: giữ cấu hình báo thức (retained) khi broker khởi động lại.
5. Deploy. Log phải có `mosquitto version ... running`.

## 2. Service `app`

1. Trong cùng project → **Create → GitHub Repo** → lại chọn repo NekoMate.
2. **Settings**:
   - **Service Name**: `app`.
   - **Root Directory**: `server`.
   - **Networking → Generate Domain** (port 3000). Ghi lại `https://<app>.up.railway.app`.
3. Chuột phải service → **Attach Volume**, mount path `/app/data` (giữ SQLite qua mỗi lần deploy).
4. **Variables**:

   | Biến | Giá trị |
   |---|---|
   | `HOST` | `::` (bắt buộc: mặc định 127.0.0.1 thì Railway không vào được) |
   | `PORT` | `3000` |
   | `APP_BASE_URL` | `https://<app>.up.railway.app` |
   | `OWNER_PASSWORD_HASH` | hash ở bước 0 (dán nguyên, không cần dấu nháy) |
   | `DB_PATH` | `/app/data/nekomate.db` |
   | `MQTT_URL` | `mqtt://mosquitto.railway.internal:1883` |
   | `MQTT_USERNAME` | `nekomate-server` |
   | `MQTT_PASSWORD` | `${{mosquitto.MQTT_SERVER_PASSWORD}}` (tham chiếu biến của service kia, khỏi gõ lại) |
   | `COMPOSIO_API_KEY` | nếu dùng nguồn lịch |

5. Deploy. Mở `https://<app>.up.railway.app` để đăng nhập dashboard.

Mỗi lần `git push` lên `main`, Railway tự deploy lại cả hai service.

## 3. Nạp lại ESP32

Trong `cat_firmware/cat/secrets.h`:

```c
#define MQTT_HOST "<mqtt>.up.railway.app"   // domain của service mosquitto, không có https://
#define MQTT_PORT 443
#define MQTT_USE_TLS 1
#define MQTT_WS_PATH "/mqtt"
#define MQTT_USER "nekomate-01"
#define MQTT_PASS "<mật khẩu MQTT của thiết bị>"
#define MQTT_CA_CERT ""                     // dùng bộ root CA có sẵn trong ESP32
```

ESP32 chỉ cần Wi-Fi có internet, không cần cùng mạng với server.

## Đổi mật khẩu MQTT

Sửa biến trên service `mosquitto` rồi redeploy: file mật khẩu được tạo lại mỗi lần khởi động. Nhớ nạp lại ESP32 nếu đổi mật khẩu thiết bị.

## Sao lưu

Railway → service `app` → **Volume → Backups** (sao lưu thủ công hoặc theo lịch).

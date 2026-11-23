# NekoMate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Mục tiêu** — Đồng hồ hiển thị giờ, tự báo thức khi mất Wi-Fi và phát lời nhắc từ lịch hoặc ứng dụng đã kết nối.

**Kiến trúc** — ESP32 giữ một cấu hình báo thức trong NVS và phát âm thanh qua MAX98357. Backend lưu lịch và hàng đợi trong SQLite, dùng Composio để đọc nguồn và Mosquitto để gửi lệnh khi đến hạn. Một web cùng origin để đặt báo thức, chọn nguồn và xem trạng thái.

**Công nghệ** — Arduino-ESP32 3.x và Arduino CLI, Adafruit GFX/ST7789, ESP-MQTT, ArduinoJson, Wokwi, Node.js 22.22+, TypeScript, `node:sqlite`, Express, `mqtt` và `@composio/core`. Khóa toolchain firmware sau khi build thử ESP-MQTT.

**Thiết kế** — [Kiến trúc NekoMate](../specs/2026-11-23-nekomate-iot-design.md).

## Ràng buộc chung

- Một chủ thiết bị, một ESP32-S3, một báo thức có giờ và ngày lặp. `Asia/Ho_Chi_Minh` tương ứng `ICT-7` trên ESP32. Báo thức phát tối đa 90 giây và khi bật phải có ít nhất một ngày. MQTT dùng Unix timestamp theo giây cho bản tin lời nhắc.
- Backend đồng bộ nguồn mỗi 5 phút và quét lời nhắc mỗi 5 giây. Lời nhắc ứng dụng hết hạn sau 5 phút, mỗi lần phát tối đa 30 giây. Google Calendar và Outlook Calendar nhắc trước 10 phút.
- `alarms/config` và `status` dùng QoS 1 và `retain=true`. `notify` và `events` dùng QoS 1 và `retain=false`. Các topic thuộc `nekomate/devices/{deviceId}/`. Chạm đầu mèo tắt âm tại chỗ, kể cả khi đường về MQTT gián đoạn. Payload dùng cấu trúc trong spec.
- Một tiến trình Node.js, một DB SQLite và một broker. Backend xác thực chủ thiết bị, giữ `COMPOSIO_API_KEY` trong môi trường và gọi tool đọc qua SDK. Firmware nhận thời điểm và tiêu đề tối thiểu. Bản đầu dùng đồng bộ định kỳ và đồng bộ thủ công.
- Chốt bản đầu với hai kiểu nguồn `calendar` và `task`, một bảng khai báo adapter phía backend và một giao diện chọn nguồn dùng chung.

## Điểm cần kiểm tra khi review

| Tình huống | Kết quả cần thấy | Task |
| --- | --- | --- |
| Wi-Fi mất lúc đến báo thức | Báo một lần trong phút đã cài. Mất nguồn rồi bật lại thì chờ giờ hợp lệ. | 2 |
| Broker gửi trùng, lệnh đã quá hạn hoặc báo thức đang chiếm loa | Chỉ ghi chống trùng sau khi thực sự hiện lệnh. | 3B |
| SQLite được tạo lại khi thiết bị giữ `revision=12` | Lệnh mới có thể lên revision 13 qua phản hồi thiết bị. ACK cũ giữ nguyên trạng thái chờ. | 3A, 3B |
| Đồng bộ thiếu một trang hoặc có yêu cầu đổi phạm vi cùng lúc | Giữ lịch hợp lệ khi lỗi. Bản đọc cũ không ghi đè phạm vi mới. | 4, 5 |
| Callback OAuth sai phiên, hết hạn hoặc được gọi lại | Từ chối trước khi thay đổi tài khoản nguồn. | 4 |
| App trả ngày dưới dạng timestamp có `00:00` | Với nguồn date-only, hiển thị ngày và giữ `notifyAt=null`. | 5 |
| Amp, loa, màn hình và Wi-Fi cùng hoạt động | Module nhận nguồn ổn định, loa phát sạch và ESP32 không reset. | 6 |

## Phần cứng và cách chạy trước khi có linh kiện

| Tín hiệu | Mốc firmware đề xuất |
| --- | --- |
| TTP223 | GPIO4 |
| ST7789 | SCK GPIO12, MOSI GPIO11, CS GPIO10, DC GPIO14, RES GPIO21 |
| MAX98357 I²S | BCLK GPIO5, LRC/WS GPIO6, DIN GPIO7 |
| Cấp nguồn amp | VIN lấy 5 V ổn định nếu module hỗ trợ. GND chung với ESP32. Kiểm tra nhãn và đường nguồn trên board mở rộng. |
| Loa 8 Ω / 3 W | Nối hai dây vào SPK+ và SPK−. Hai đầu ra là cầu vi sai. |

Giả định linh kiện đã hàn là breakout MAX98357A. Xác nhận pinout, hậu tố A/B và cấu hình SD/GAIN theo board thật trước khi cấp điện. Bản A nhận I²S chuẩn. Bản B cần chế độ left-justified. Mốc khởi đầu là PCM 16 bit, 16 kHz, gửi cùng mẫu vào hai kênh để phù hợp với các thiết lập chọn kênh thông dụng. Ưu tiên tiếng ngắn và kiểm tra ở mức âm lượng thấp trước. [Datasheet MAX98357A/B](https://www.analog.com/media/en/technical-documentation/data-sheets/MAX98357A-MAX98357B.pdf) · [Arduino-ESP32 I²S](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/i2s.html)

Wokwi kiểm tra hành vi bằng bản build `NEKOMATE_SIM` với dấu `audio:start` và `audio:stop` trên Serial. Dùng nút nhấn mô phỏng TTP223 và driver ILI9341 với vùng vẽ 240 × 240 cho mạch mô phỏng. Wokwi công bố ESP32-S3 chưa hỗ trợ mô phỏng I²S. [ESP32 Simulation](https://docs.wokwi.com/guides/esp32#simulation-features) · [ILI9341 trên Wokwi](https://docs.wokwi.com/parts/wokwi-ili9341)

## Nguồn Composio

Các tool dưới đây có trong tài liệu Composio. Khi triển khai, xác nhận schema, phân trang và quyền của connected account bằng một lần đọc thật, rồi lưu payload đã ẩn dữ liệu cá nhân làm fixture. Web lấy danh sách từ registry của backend để tự phản ánh nguồn đã triển khai.

| Nhóm | Nguồn và tool đọc | Quy tắc tại NekoMate |
| --- | --- | --- |
| Sớm | Google Calendar · `GOOGLECALENDAR_EVENTS_LIST` | Lịch chính, mở rộng lần lặp, báo trước 10 phút. [Toolkit](https://docs.composio.dev/toolkits/googlecalendar) |
| Sớm | Todoist · `TODOIST_GET_ALL_TASKS` | Việc đang mở có giờ `due` thì nhắc theo giờ đó. [Toolkit](https://docs.composio.dev/toolkits/todoist) |
| Mở rộng | Outlook Calendar · `OUTLOOK_GET_CALENDAR_VIEW` | Đọc lịch chính trong khoảng thời gian, lấy từng lần xuất hiện và nhắc trước 10 phút. [Toolkit](https://docs.composio.dev/toolkits/outlook) · [Graph Calendar View](https://learn.microsoft.com/en-us/graph/api/user-list-calendarview?view=graph-rest-1.0) |
| Mở rộng | Microsoft To Do · `OUTLOOK_LIST_TO_DO_LISTS`, `OUTLOOK_LIST_TODO_TASKS` | Dùng `reminderDateTime` nếu `isReminderOn=true`. Cùng một kết nối Outlook có thể phục vụ hai nguồn nếu có đủ quyền. [Toolkit](https://docs.composio.dev/toolkits/outlook) · [Graph To Do](https://learn.microsoft.com/en-us/graph/api/resources/todoTask?view=graph-rest-1.0) |
| Mở rộng | TickTick · `TICKTICK_GET_USER_PROJECT`, `TICKTICK_GET_PROJECT_WITH_DATA` | Chọn project. Nhắc việc đang mở có hạn với giờ rõ ràng sau khi xác nhận payload thật. [Toolkit](https://docs.composio.dev/toolkits/ticktick) |
| Mở rộng | Google Tasks · `GOOGLETASKS_LIST_TASK_LISTS`, `GOOGLETASKS_LIST_TASKS` | Hiển thị ngày hạn. API chỉ giữ ngày, kể cả khi trường `due` có dạng timestamp. [Toolkit](https://docs.composio.dev/toolkits/googletasks) · [Google Tasks API](https://developers.google.com/tasks/reference/rest/v1/tasks) |

Danh mục còn có **ClickUp, Asana, Trello và Notion**. Khi dùng thêm, chọn workspace, project, board hoặc database phù hợp rồi xác định trường thời gian có ý nghĩa với người dùng. Với Notion, trường ngày phụ thuộc cơ sở dữ liệu được chọn. [Danh mục Composio](https://docs.composio.dev/toolkits) · [ClickUp](https://docs.composio.dev/toolkits/clickup) · [Asana](https://docs.composio.dev/toolkits/asana) · [Trello](https://docs.composio.dev/toolkits/trello) · [Notion](https://docs.composio.dev/toolkits/notion)

## Bố cục dự kiến

| Vị trí | Trách nhiệm |
| --- | --- |
| `cat_firmware/cat/cat.ino`, `audio.h`, `audio.cpp` | Sketch hiện có, cấu hình bo và phát/dừng tiếng. |
| `cat_firmware/cat/alarm.h`, `alarm.cpp`, `device_mqtt.h`, `device_mqtt.cpp` | Báo thức cục bộ, lưu cấu hình và giao tiếp MQTT. |
| `cat_firmware/sim/diagram.json`, `wokwi.toml`, `cat_firmware/cat/DOC_TRUOC.txt` | Cách chạy mô phỏng và đấu/nạp mạch thật. |
| `server/src/index.ts`, `auth.ts`, `db.ts`, `device.ts` | API web, chủ thiết bị, dữ liệu SQLite, MQTT và tác vụ gửi lệnh đến hạn. |
| `server/src/sources.ts`, `server/src/adapters/*.ts` | Registry, đồng bộ tài khoản Composio và chuyển dữ liệu riêng từng app. |
| `server/public/index.html`, `app.js`, `style.css`, `server/test/*.test.ts` | Dashboard và các bài kiểm thử với SQLite hoặc fixture. |
| `server/compose.yaml`, `server/mosquitto.conf`, `server/.env.example` | Broker thử nghiệm, cấu hình tài khoản và biến môi trường mẫu. |

Các tên file trong một hàng được tính theo thư mục ở đầu hàng. Dashboard mới chạy từ backend. `index.html` ở gốc repo đang phục vụ phần vỏ 3D.

## Task 1 — Firmware và phát âm I²S

**File:** `cat_firmware/cat/cat.ino`, `cat_firmware/cat/audio.h`, `cat_firmware/cat/audio.cpp`, `cat_firmware/cat/DOC_TRUOC.txt`.

**Giao diện:** `audioBegin() -> bool`, `audioStart(kind: SoundKind)`, `audioTick()`, `audioStop()`. `SoundKind` gồm `Meow`, `Alarm`, `Reminder`. Bản mô phỏng giữ cùng giao diện và ghi dấu Serial.

- [ ] Tạo tình huống kiểm tra chạm để phát và dừng từ tín hiệu Serial, với mỗi thao tác chỉ có một dòng trạng thái tương ứng.
- [ ] Kiểm tra sketch mẫu để thấy `tone()`, `delay(140)` và `fillScreen()` khi chớp mắt. Trong Wokwi, giữ nút chạm qua lúc chớp mắt và kiểm tra thao tác vẫn được xử lý.
- [x] Chuẩn bị Arduino CLI, Arduino-ESP32 3.x và các thư viện. Compile/link sketch thăm dò có `<mqtt_client.h>` và tham chiếu `esp_mqtt_client_init`. Khóa core tương thích trước Task 3B. Nếu bản cài không cung cấp component, xác định cách đóng gói ESP-MQTT tương thích rồi chạy lại probe.
- [x] Dùng `ESP_I2S.h` với `I2SClass` cho MAX98357A, phát PCM theo khối nhỏ và xử lý chạm theo cạnh sau debounce. Bỏ `delay(140)` bằng mốc `millis()`. Chỉ vẽ lại vùng mắt, đồng hồ hoặc chữ khi đổi. Dùng `fillScreen()` lúc khởi tạo hoặc chuyển màn. Giữ GPIO đã chốt, dùng SD mặc định của module.
- [x] Chạy `arduino-cli compile --fqbn esp32:esp32:esp32s3 cat_firmware/cat`; kết quả mong đợi là build thành công. Dùng `--build-property "compiler.cpp.extra_flags=-DNEKOMATE_SIM=1"` trong bản build Wokwi.
- [x] Ghi lệnh nạp, thư viện và bảng chân amp/loa trong `DOC_TRUOC.txt`. Lưu mốc thay đổi của task khi thực thi kế hoạch.

## Task 2 — Báo thức cục bộ và lưu cấu hình

**File:** `cat_firmware/cat/alarm.h`, `cat_firmware/cat/alarm.cpp`, `cat_firmware/cat/cat.ino`, `cat_firmware/sim/diagram.json`, `cat_firmware/sim/wokwi.toml`.

**Giao diện:** `AlarmConfig { configId: string; revision: number; hour: number; minute: number; days: number[]; enabled: boolean }`. `hour` là 0–23, `minute` là 0–59, `days` nhận các giá trị 1–7, thứ Hai là 1. `applyAlarmConfig(config)` trả `applied`, `unchanged`, `stale` hoặc `invalid`; chỉ `applied` ghi NVS. `alarmDue(localTime, clockValid) -> bool` báo một lần cho cùng ngày và phút. Chỉ xác lập `clockValid` sau khi có giờ hợp lệ.

- [ ] Thêm lệnh Serial cho bản `NEKOMATE_SIM`: `sim:time 2026-11-23T06:59:55+07:00`, `sim:alarm <AlarmConfig JSON>`, `sim:wifi off|on`, `sim:advance <giây>` và `sim:time invalid`. `advance` tiến cả giờ địa phương giả và bộ đếm thời gian phát báo thức giả. Bản thật dùng `millis()` để giới hạn thời lượng phát. Từ 06:59:55, đặt báo thức 07:00 ngày thứ Hai, tắt mạng và tiến 5 giây. Kỳ vọng đúng một `audio:start Alarm` và một `audio:stop` sau khi chạm. Thử lại bằng cách tiến thêm 90 giây và để tự dừng.
- [ ] Chạy kịch bản trên sketch Task 1 để xác nhận chưa có `audio:start Alarm`.
- [x] Gắn NTP với `ICT-7` và `Preferences`/NVS. Lưu mốc vừa báo để chống báo lại cùng phút sau khi khởi động. Cấu hình qua MQTT và mô phỏng dùng cùng hàm kiểm tra, gồm từ chối `days=[]` khi bật. Giữ phần kiểm tra giờ chạy được trong lúc Wi-Fi kết nối lại.
- [ ] Dùng Wokwi xác nhận cấu hình còn sau khi khởi động lại, thiết bị chưa có giờ giữ im và bản thấp hơn hoặc cùng revision khác ID trả `stale`. Chạy lại build ESP32-S3. Lưu mốc thay đổi của task khi thực thi kế hoạch.

## Task 3A — Backend, xác thực chủ thiết bị và hàng đợi MQTT

**File:** `server/package.json`, `server/tsconfig.json`, `server/src/{index,auth,db,device}.ts`, `server/test/{device,auth}.test.ts`, `server/compose.yaml`, `server/mosquitto.conf`, `server/.env.example`, `.gitignore`.

**Giao diện:** `tickDevice(now: number): Promise<void>`, `queueNotification(input: Notification): void`, `saveAlarm(input: Omit<AlarmConfig, 'revision' | 'configId'>): AlarmConfig`, `toDeviceTitle(title: string): string`. `Notification { notificationId, source, title, notifyAt, expiresAt }`. `GET /api/device` trả `online`, cặp cấu hình đang chờ và cặp đã xác nhận. `PUT /api/alarm` lưu lịch. `POST /api/notifications/test` gửi lệnh thử. `POST /api/auth/login` nhận `{password}` và phát cookie; `POST /api/auth/logout` thu hồi phiên. Mọi payload MQTT theo topic và schema trong spec.

- [x] Viết `device.test.ts` với DB in-memory và MQTT giả. Kiểm tra retry 15 giây, `shown` chặn retry, hết hạn đánh dấu `missed`, SQLite rỗng không tự phát cấu hình và cấu hình mới revision 1 nhận `alarm_config_stale` từ thiết bị revision 12 thì gửi lại ở 13. ACK cùng revision nhưng sai `configId` giữ nguyên trạng thái chờ. Test thêm `Họp nhóm 🐱` → `Hop nhom`, `Đổi giờ` → `Doi gio` và cắt tối đa 48 ký tự.
- [x] Viết `auth.test.ts` cho khách gọi API sửa cấu hình, đăng nhập sai liên tiếp, cookie hợp lệ, phiên hết hạn, đăng xuất và yêu cầu ghi sai origin. Chạy `node --test test/device.test.ts test/auth.test.ts` trong `server` để xác nhận thiếu triển khai.
- [x] Khai báo Node ESM (`type: module`), import tương đối có đuôi `.ts`, `import type` và `erasableSyntaxOnly` trong `tsconfig`. `npm test` chạy `node --test`; `npm run typecheck` chạy `tsc --noEmit`. Tránh cú pháp cần chuyển đổi như `enum` và parameter properties. Node 22 có thể in `ExperimentalWarning` cho `node:sqlite`. [Node.js TypeScript](https://nodejs.org/docs/latest-v22.x/api/typescript.html)
- [x] Khởi tạo `alarm_config`, `sources`, `source_items`, `notification_queue`, `sessions`, `oauth_attempts`. `alarm_config` giữ cặp đang chờ và đã xác nhận. `sources` giữ `connectedAccountId`, phạm vi và trạng thái đồng bộ. `source_items` dùng khóa `(source_id, external_id)`; hàng đợi dùng `notification_id`. Khai báo `APP_BASE_URL` và `OWNER_PASSWORD_HASH` trong `.env.example`; runtime đọc `.env` bên ngoài git.
- [x] Cài xác thực theo spec bằng `scrypt`, token ngẫu nhiên và phiên 24 giờ, giới hạn sai mật khẩu 5 lần/phút theo địa chỉ IP. Cookie `HttpOnly`, `SameSite=Lax`, `Secure` khi HTTPS. So khớp `Origin` với `APP_BASE_URL` cho API ghi, kể cả login. Bind HTTP vào loopback mặc định.
- [x] Cài worker, chuẩn hóa tiêu đề tại biên MQTT và xử lý ACK/stale trong giao dịch. Chỉ nâng phiên bản khi phản hồi khớp cặp đang chờ. Giữ `configId`, dùng `max(revision, appliedRevision) + 1` và lưu trước khi publish. Phát lại cấu hình còn chờ khi kết nối lại hoặc đến vòng retry. Cấu hình Mosquitto 2.x với `listener 1883 0.0.0.0`, `allow_anonymous false`, tài khoản và ACL theo thiết bị. Port publish mặc định `127.0.0.1:1883:1883`.
- [ ] Chạy `npm test`, `npm run typecheck` và `docker compose up -d mqtt`; dùng MQTT client thử phát `shown`, `alarm_config_stale` và ACK theo schema trước khi ghép ESP32.

## Task 3B — ESP32 MQTT và tích hợp hai luồng báo

**File:** `cat_firmware/cat/{cat.ino,device_mqtt.h,device_mqtt.cpp,secrets.h.example,DOC_TRUOC.txt}`, `.gitignore`.

**Giao diện:** `mqttStart()` và hai hàng đợi nội bộ nhận/gửi. `secrets.h` chứa `WIFI_SSID`, `WIFI_PASS`, `MQTT_HOST`, `MQTT_PORT`, `MQTT_USER`, `MQTT_PASS`, `DEVICE_ID` và CA cho TLS. Git ignore file thật. Wokwi dùng broker/tài khoản thử với dữ liệu giả.

- [ ] Thêm bài thử broker gửi `notify` trong lúc báo thức đang reo, gửi lại cùng ID sau khi tắt báo thức, gửi lần thứ ba sau khi hiện và gửi thêm lệnh đã hết hạn. Kỳ vọng lần bận giữ im và chưa có `shown`, lần gửi lại phát đúng một lần, lần trùng chỉ gửi lại trạng thái, lệnh hết hạn giữ im.
- [x] Tích hợp ESP-MQTT với MQTT 3.1.1, QoS 1, TLS khi qua Internet và LWT retained. Gửi online retained sau khi nhận cả hai SUBACK. Callback sao chép gói tin hoàn chỉnh có giới hạn kích thước vào hàng đợi hữu hạn, xử lý theo độ dài/offset nếu sự kiện nhận bị chia. Khi quá giới hạn thì bỏ toàn bộ bản tin. Task mạng đọc hàng đợi gửi và dùng `esp_mqtt_client_enqueue`, giữ MQTT và socket ngoài vòng màn hình/loa/NVS. Khi hàng đợi đầy, giữ báo thức chạy và để retry phục hồi.
- [x] Áp dụng cấu hình và phát ACK/stale từ kết quả NVS. Với lệnh bận chưa từng hiện, giữ trống bộ chống trùng. Với lệnh đã hiện, lưu trạng thái và trả lại trạng thái gần nhất nếu nhận trùng.
- [ ] Build ESP32-S3 và chạy Wokwi với broker thử. Ngắt broker trước mốc báo thức và kiểm tra thời gian báo, chạm, reconnect, telemetry retained cùng ca reset DB của Task 3A.

## Task 4 — Kết nối Composio và hai adapter đầu tiên

**File:** `server/src/sources.ts`, `server/src/adapters/google-calendar.ts`, `server/src/adapters/todoist.ts`, `server/src/{index,db}.ts`, `server/test/sources.test.ts`, `server/test/fixtures/`.

**Giao diện:** `SourceItem { externalId: string; title: string; dateOnly: string | null; notifyAt: number | null }`, trong đó `dateOnly` có dạng `YYYY-MM-DD`. `readSource(connection: SourceConnection, window: SyncWindow): Promise<SourceItem[]>` đọc đủ các trang. `SourceConnection { sourceId: string; connectedAccountId: string; scopeId: string | null }` và `SyncWindow { from: number; to: number }` dùng giây UTC cho cửa sổ đọc. `syncSource(sourceId: string, now: number): Promise<void>` ghi bản cập nhật và hàng đợi trong cùng giao dịch DB. `GET /api/sources` trả danh sách, trạng thái và lần đồng bộ gần nhất. `POST /api/sources/:id/connect` tạo link và `POST /api/sources/:id/sync` chạy đồng bộ thủ công.

- [x] Thêm fixture chuẩn hóa lịch 09:00 thành giờ nhắc 08:50, sự kiện lặp đã dời/hủy, việc Todoist có giờ, việc chỉ có ngày, việc đã hoàn thành và lỗi khi đọc trang cuối. Thêm ca đổi tiêu đề cùng giờ nhắc khi lệnh đang chờ và ấn **Đồng bộ ngay** trong khi timer đang chạy. Kỳ vọng giữ ID nhưng cập nhật tiêu đề và chỉ đọc một lần cho cùng phạm vi. Lỗi trang cuối giữ nguyên dữ liệu cũ.
- [x] Chạy `node --test test/sources.test.ts` trong `server` để xác nhận chưa có adapter và logic thay thế nguồn.
- [ ] Dùng auth từ Task 3A. Tạo callback tuyệt đối từ `APP_BASE_URL`, lưu hash nonce 10 phút cùng phiên chủ, toolkit và ID yêu cầu Composio trong `oauth_attempts`; xác minh tài khoản từ Composio rồi mới đổi nguồn. Test callback hai lần, khác phiên, hết hạn và tài khoản sai chủ. Gọi `session.execute()` với tool cố định. Khi có tài khoản thử, xác nhận schema rồi chốt fixture đã ẩn dữ liệu thật.
- [x] Đồng bộ mỗi 5 phút với `from = now - 15 * 60`, `to = now + 7 * 86400` cho cửa sổ lịch. Chỉ đối soát xóa trên phạm vi và cửa sổ đọc thành công. Dùng khóa tuần tự trên `sourceId` cho đồng bộ, đổi scope và thay kết nối. Gộp timer với yêu cầu thủ công cùng phạm vi. Xử lý dời/hủy/hoàn thành và cập nhật tiêu đề của lệnh chờ cùng ID.
- [ ] Chạy `npm test` và `npm run typecheck`. Qua REST và broker thử nghiệm, đồng bộ một lịch test thành lệnh MQTT rồi chạm xác nhận. Lưu mốc thay đổi của task khi thực thi kế hoạch.

## Task 5 — Thêm nguồn ngoài Google Calendar và Todoist

**File:** `server/src/adapters/{outlook-calendar,microsoft-todo,ticktick,google-tasks}.ts`, `server/src/sources.ts`, `server/test/sources.test.ts`, `server/test/fixtures/`.

**Giao diện:** Bốn adapter dùng `SourceItem`, cách báo lỗi và cơ chế đồng bộ của Task 4. Mỗi nguồn khai báo toolkit, ID hiển thị và loại mục theo ngày hoặc theo giờ. Outlook Calendar và Microsoft To Do dùng chung tài khoản Outlook trong registry. Với nguồn cần chọn danh sách, `GET /api/sources/:id/options` trả `{ id, label }[]` và `PUT /api/sources/:id/scope` lưu `{ scopeId }` thuộc tài khoản vừa liên kết.

- [x] Viết fixture riêng cho sự kiện Outlook lặp, To Do có `reminderDateTime` với múi giờ, TickTick có giờ và dạng cả ngày, Google Tasks trả `due` dạng `2026-11-24T00:00:00.000Z`. Kỳ vọng Google Tasks giữ ngày `2026-11-24` và không tạo lệnh. Mục To Do tắt nhắc giữ `notifyAt=null`.
- [x] Chạy `node --test test/sources.test.ts` để thấy các nguồn mới chưa được đọc.
- [ ] Đối chiếu payload thật hoặc schema đã cấp trong Composio cho từng tool theo bảng nguồn. Với Microsoft, nếu tài khoản Outlook chỉ có `Calendars.Read` và chủ bật To Do, dùng Connect Link xin đủ quyền đọc cho các nguồn đang dùng, gồm `Tasks.Read`. Giữ kết nối cũ đến khi xác minh các tool đọc cần thiết trên kết nối mới. Test luồng hủy cấp quyền giữ Outlook Calendar tiếp tục chạy. Với TickTick, kiểm tra trường ngày/giờ và dấu cả ngày trước khi lập lệnh.
- [x] Đăng ký adapter, dùng lại API chung và trả metadata cho dashboard ở Task 6. Đổi phạm vi dùng khóa Task 4. Test tác vụ đồng bộ phạm vi A bị giữ ở trang cuối, yêu cầu đổi phạm vi B chờ, sau đó B đọc thành công và thay dữ liệu trong một giao dịch. Nguồn thiếu quyền hoặc thiếu dữ liệu giờ trả trạng thái thực tế. Chỉ bật nguồn cho người dùng sau khi qua kiểm tra một lần đọc thật với tài khoản thử.
- [ ] Chạy `npm test` và `npm run typecheck`, rồi thử mỗi nguồn một lần cập nhật hoặc hủy mục. Xác nhận thêm adapter không yêu cầu đổi giao thức hoặc nạp lại firmware. Lưu mốc thay đổi của task khi thực thi kế hoạch.

## Task 6 — Dashboard, demo và nghiệm thu phần cứng

**File:** `server/public/{index.html,app.js,style.css}`, `server/src/index.ts`, `server/test/http.test.ts`, `cat_firmware/cat/DOC_TRUOC.txt`.

**Giao diện:** Web cùng origin gọi API từ Task 3A, Task 4 và Task 5. Poll `GET /api/device` mỗi 3 giây khi tab đang hiển thị, dừng khi tab ẩn và đọc lại ngay khi mở lại. `GET /api/reminders` trả lịch theo giờ địa phương, ngày hạn nguyên văn và trạng thái lời nhắc. Dùng phiên chủ thiết bị từ Task 3A.

- [x] Viết `http.test.ts` kiểm tra cập nhật giờ có trạng thái `Chờ đồng bộ` cho đến khi nhận đúng `configId` và `revision`, khách bị từ chối và API lịch giữ Unicode. Qua dashboard, kiểm tra tiêu đề được render dạng text và trạng thái tự cập nhật qua polling.
- [x] Chạy `node --test test/http.test.ts` trong `server` để thấy các luồng trên chưa sẵn sàng.
- [x] Hoàn thiện web cài một báo thức, chọn/kết nối nguồn và chọn danh sách hoặc project khi nguồn yêu cầu, đồng bộ, xem lần đồng bộ, xem lịch và gửi thông báo thử. Dùng phiên chủ thiết bị, xác minh origin cho thao tác thay đổi và HTTPS khi truy cập ngoài máy. MQTT qua Internet dùng TLS và ACL theo thiết bị.
- [ ] Chạy `npm test`, `npm run typecheck`, build firmware và demo bằng Wokwi với dữ liệu mẫu. Thử ngắt mạng trước giờ, nối lại trong thời hạn rồi thử nối lại sau khi quá hạn. Đối chiếu trạng thái trên web với log thiết bị.
- [ ] Trên mạch thật, xác minh module và chân trước khi đấu theo bảng. Thử chạm tắt, nghe riêng từng mẫu tiếng ở âm lượng thấp, rồi chạy cùng tải Wi-Fi và màn hình. Kiểm tra nguồn, tiếng rè và ESP32 có reset khi loa hoạt động hay không. Đo chỗ gắn loa và amp trong vỏ trước khi cố định. Ghi kết quả mô phỏng, thử tài khoản và thử mạch thật thành ba mục trong hướng dẫn chạy. Lưu mốc thay đổi của task khi thực thi kế hoạch.

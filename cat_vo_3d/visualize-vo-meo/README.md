# Tùy biến vỏ mèo 3D

Mở [index.html](index.html) trong trình duyệt có WebGL và kết nối Internet để xem và xoay vỏ mèo. Mẫu có mười chín tổ hợp gợi ý, hai mươi phối màu, sáu kiểu đuôi, năm kiểu tai, năm kiểu chân, cùng các ô chỉnh màu riêng. Không cần IDE hay chạy server.

## Dùng với agent khác

- **Codex có Visualize** — Dùng [vo-meo-tuy-bien.html](vo-meo-tuy-bien.html), là đoạn HTML nguồn. Sao chép vào thư mục visualization được cấp cho phiên đó nếu cần, rồi trả về bằng tham chiếu Visualize với đường dẫn tuyệt đối của phiên. Thay đường dẫn mẫu trong ví dụ dưới đây bằng đường dẫn thật.
- **Agent dùng trình duyệt** — Mở [index.html](index.html) để xem và thao tác. File này là bản xuất độc lập của cùng một mẫu.

```text
visualize{"path":"<duong-dan-tuyet-doi>/vo-meo-tuy-bien.html"}
```

Đoạn HTML đã nhúng dữ liệu lưới của tám STL gốc và tải Three.js 0.160.0 từ CDN. Tổ hợp gợi ý gồm Carbon, Tàng hình, Racing, Cyber, Xanh điện, Đại dương, Nửa đêm, Hoàng gia, Denim, Thép xanh, Thép súng, Quân đội, Hải quân, Sa mạc, Xanh dầu, Volt, Cảnh báo, Bắc cực và Sương xanh. Các kiểu đuôi, tai và chân mới là mẫu xem thử. Kích thước chốt và độ khớp khi in chưa được kiểm tra. Các STL gốc nằm ở thư mục cha.

Khi chỉnh bản xem 3D, cập nhật `vo-meo-tuy-bien.html` trước và tạo lại `index.html` bằng `render.py` của skill Visualize.

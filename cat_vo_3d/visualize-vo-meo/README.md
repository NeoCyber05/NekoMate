# Tùy biến vỏ mèo 3D

Mở [index.html](index.html) trong trình duyệt có WebGL và kết nối Internet để xem và xoay vỏ mèo. Mẫu có mười chín tổ hợp gợi ý, hai mươi phối màu, sáu kiểu đuôi, năm kiểu tai, năm kiểu chân, cùng các ô chỉnh màu riêng. Không cần IDE hay chạy server.

## Dùng với agent khác

- **Codex có Visualize** — Dùng [vo-meo-tuy-bien.html](vo-meo-tuy-bien.html), là đoạn HTML nguồn. Sao chép vào thư mục visualization được cấp cho phiên đó nếu cần, rồi trả về bằng tham chiếu Visualize với đường dẫn tuyệt đối của phiên. Thay đường dẫn mẫu trong ví dụ dưới đây bằng đường dẫn thật.
- **Agent dùng trình duyệt** — Mở [index.html](index.html) để xem và thao tác. File này là bản xuất độc lập của cùng một mẫu.

```text
visualize{"path":"<duong-dan-tuyet-doi>/vo-meo-tuy-bien.html"}
```

Đoạn HTML đã nhúng dữ liệu lưới của tám STL gốc và tải Three.js 0.160.0 từ CDN. Tổ hợp gợi ý gồm Carbon, Tàng hình, Racing, Cyber, Xanh điện, Đại dương, Nửa đêm, Hoàng gia, Denim, Thép xanh, Thép súng, Quân đội, Hải quân, Sa mạc, Xanh dầu, Volt, Cảnh báo, Bắc cực và Sương xanh. Các kiểu đuôi, tai và chân mới là mẫu xem thử. Kích thước chốt và độ khớp khi in chưa được kiểm tra. Các STL gốc nằm ở thư mục cha.

## Xuất cấu hình và tạo file in

- **Xuất JSON** — lưu kiểu đuôi, tai, chân và màu từng chi tiết đang chọn vào `vo-meo.json`.
- **Đọc JSON → tải 8 file STL** — chọn một file JSON đã xuất. Trang áp cấu hình đó lên mô hình rồi tải về `<tên-json>_stl.zip`. Giải nén ra thư mục `<tên-json>_stl` gồm 8 file STL (đã xoay theo hướng in, đặt sát mặt bàn, đơn vị mm, tên file kèm mã màu) và `mau_in.txt` ghi màu nhựa cho từng file.

Chọn kiểu "gốc" cho cả đuôi, tai, chân thì 8 STL xuất ra trùng với 8 STL gốc ở thư mục cha (sai lệch ≤ 0,05 mm). Các kiểu khác là mẫu xem thử, cần xem lại trong slicer.

## Sửa mẫu

Khi chỉnh bản xem 3D, cập nhật `vo-meo-tuy-bien.html` trước rồi chạy `python build_index.py` để nhúng lại vào `index.html`.

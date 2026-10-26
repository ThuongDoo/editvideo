# Video Batch Editor

Chạy: nhấp đúp **start.bat** (hoặc `npm start`). Trình duyệt tự mở http://localhost:5577

1. Chọn thư mục **Video gốc**, **Thư mục nhạc**, **Thư mục xuất** (nút `…`).
2. Bật/tắt và chỉnh từng bước 1–8, xem khung **Xem trước** để so sánh Gốc / Sau khi edit.
3. Bấm **▶ Bắt đầu xử lý**. Có thể **■ Dừng** bất cứ lúc nào; chạy lại sẽ bỏ qua video đã xong.

Thứ tự xử lý mỗi video: tăng tốc → lật → xoay ngẫu nhiên (min–max độ) → scale (tự zoom thêm để không lộ góc đen) → lọc màu → khung viền → bỏ tiếng gốc → ghép nhạc ngẫu nhiên (lặp nếu ngắn, cắt nếu dài, fade cuối).

- Khung viền: "Viền màu" (màu + độ dày % + độ mờ) hoặc "Ảnh khung PNG" nền trong suốt (tự co giãn theo kích thước video).
- Cấu hình được lưu vào `config.json`.
- Không cần cài ffmpeg, đã có sẵn trong `node_modules`.

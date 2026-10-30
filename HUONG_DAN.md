# Video Batch Editor — Hướng dẫn sử dụng

Tự động edit hàng loạt video: lọc màu, khung viền, tăng tốc, lật, xoay nhẹ, phóng to, xóa tiếng, ghép nhạc ngẫu nhiên, đặt tên file theo mẫu.

## Yêu cầu
- Windows 10/11 bản 64-bit. Không cần cài thêm gì (đã kèm sẵn Node.js và ffmpeg).

## Cài đặt & chạy
1. **Giải nén** file zip ra một thư mục (ví dụ `D:\VideoBatchEditor`). Không chạy trực tiếp bên trong file zip.
2. Nhấp đúp **start.bat**. Một cửa sổ đen hiện ra và trình duyệt tự mở trang `http://localhost:5577`.
3. Giữ cửa sổ đen mở trong lúc dùng. Đóng cửa sổ đó là tắt app.

## Cách dùng
1. Bấm nút `…` để chọn **Video gốc**, **Thư mục nhạc**, **Thư mục xuất** (thư mục xuất phải khác thư mục gốc).
2. Bật/tắt và chỉnh từng bước 1–8. Khung **Xem trước** hiển thị ảnh Gốc / Sau khi edit.
3. **Đặt tên file xuất**: tiền tố, số thứ tự video, tên gốc, số thứ tự nhạc, hậu tố — kéo thả để đổi thứ tự.
4. Bấm **▶ Bắt đầu xử lý**. Có thể **■ Dừng** bất cứ lúc nào; chạy lại sẽ bỏ qua video đã xong.
5. Nếu có file lỗi, bấm **↻ Chạy lại file lỗi** để xử lý lại riêng các file đó.

## Mẹo
- **Hiệu năng**: máy yếu để "Xử lý cùng lúc" 1–2 video. Bật "Chạy ưu tiên thấp" để máy không bị đơ.
  - **Số luồng tối đa**: số luồng CPU app được phép dùng (ví dụ máy 8 luồng để 6 thì app dùng tối đa ~75% CPU, còn 2 luồng cho việc khác). Để 0 là dùng hết.
  - **Công suất mỗi luồng**: các luồng edit chỉ chạy tối đa bấy nhiêu % thay vì 100%, giúp CPU mát hơn và không bị tụt xung vì nóng. Máy nóng thì để 60–80%.
- **Bộ mã hóa**: chọn "Tự động" để dùng card đồ họa (NVIDIA / Intel / AMD) nếu máy có; lỗi thì tự chuyển sang CPU.
- **Nhạc**: nhận mp3, m4a, wav, aac, flac… và cả file mp4 có tiếng. Nhạc ngắn sẽ lặp lại, nhạc dài sẽ bị cắt vừa video.
- **Khung viền**: chọn "Viền màu" hoặc "Ảnh khung PNG" (ảnh nền trong suốt, tự co giãn theo video).
- Cấu hình được lưu tự động vào `config.json` trong thư mục app.

## Lỗi thường gặp
- **Trình duyệt không tự mở**: mở tay địa chỉ `http://localhost:5577`.
- **Báo cổng 5577 đang bị dùng**: app đã chạy ở một cửa sổ khác — dùng cửa sổ đó, hoặc đóng nó rồi chạy lại start.bat.
- **Báo lỗi khi chạy một video**: rê chuột vào cột "Ghi chú" để xem chi tiết. File video bị hỏng (tải dở, sai định dạng) cần tải lại hoặc bỏ ra khỏi thư mục.

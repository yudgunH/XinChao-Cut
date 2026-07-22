# Changelog

Các thay đổi đáng chú ý của XinChao-Cut được ghi tại đây.

## 0.1.1 - 2026-07-22

### Sửa lỗi

- Tự mở wizard thiết lập ngay tại Home khi bản desktop chưa có Core/FFmpeg.
- First-run setup chỉ chọn Core + FFmpeg; WhisperX, FunASR, Demucs và OmniVoice vẫn là tùy chọn cài sau.
- Tự khởi động backend sau khi first-run setup hoàn tất, không cần người dùng tìm Model Manager thủ công.

## 0.1.0 - 2026-07-22

### Nổi bật

- Hoàn thiện editor đa track với workflow split, trim, ripple, snap, group, compound, crop, transition và effect.
- Bổ sung Voice Studio, voice clone và luồng tạo voiceover từ caption bằng OmniVoice.
- Bổ sung caption qua WhisperX, FunASR tiếng Trung, chỉnh timing/style và dịch/correction qua LLM tùy chọn.
- Bổ sung tách vocals/nhạc nền bằng Demucs.
- Nâng cấp export browser, server FFmpeg và hybrid; thêm kiểm tra output, quota, cache chunk và luồng ghi trực tiếp.
- Tối ưu preview, timeline virtualization, audio scheduling, proxy, waveform và xử lý media lớn.
- Thêm Model Manager trong giao diện để cài Core/FFmpeg cùng các model tùy chọn.
- Thêm `setup.bat` cho cài đặt source ban đầu; model AI được cài thêm từ giao diện.
- Viết lại README tiếng Việt với hướng dẫn cài đặt, sử dụng, phím tắt, dữ liệu, xử lý lỗi và đóng gói.

### Phân phối

- Mục tiêu phát hành: Windows 10/11 x64.
- Định dạng: bộ cài NSIS theo tài khoản người dùng.
- Model AI và dữ liệu cá nhân không nằm trong bộ cài.

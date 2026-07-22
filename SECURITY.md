# Chính sách bảo mật

\*[English](SECURITY.en.md) · **Tiếng Việt\***

## Phiên bản được hỗ trợ

Đây là dự án cá nhân/học tập. Các bản vá bảo mật chỉ áp dụng cho mã mới nhất trên nhánh `main`.

| Phiên bản            | Được hỗ trợ |
| -------------------- | ----------- |
| `main` (mới nhất)    | ✅          |
| Bản phát hành cũ hơn | ❌          |

## Báo cáo lỗ hổng

Nếu bạn phát hiện lỗ hổng bảo mật, vui lòng **không mở issue công khai**.

Thay vào đó, hãy báo riêng tư qua một trong các cách sau:

- Dùng tính năng **[Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)** của GitHub (tab _Security_ của repo), hoặc
- Liên hệ trực tiếp với người bảo trì qua GitHub.

Khi báo cáo, vui lòng kèm:

- Mô tả lỗ hổng và mức độ ảnh hưởng.
- Các bước tái hiện hoặc proof-of-concept.
- Phiên bản/commit liên quan và môi trường.

## Quy trình xử lý

- Chúng tôi cố gắng phản hồi trong vòng **7 ngày**.
- Nếu lỗ hổng được xác nhận, chúng tôi sẽ vá và ghi nhận đóng góp của bạn (nếu bạn đồng ý).
- Vui lòng cho chúng tôi khoảng thời gian hợp lý để vá trước khi công bố công khai.

## Lưu ý khi tự vận hành

- **Backend không có xác thực sẵn.** Nó được thiết kế để chạy cục bộ (`127.0.0.1`). Nếu bạn expose backend ra mạng, hãy tự thêm lớp xác thực/proxy và giới hạn truy cập — nếu không, bất kỳ ai cũng có thể gọi các endpoint xử lý media/AI.
- **Không commit secret.** File `.env` / `.env.local` đã nằm trong `.gitignore`; đừng đưa token hay khóa vào repo.
- Dữ liệu media và project được lưu cục bộ trong OPFS/IndexedDB hoặc được tham chiếu trực tiếp từ file đã chọn trên desktop. Backend đóng gói dùng `%LOCALAPPDATA%\XinChao-Cut\work`; `.work/` chỉ là mặc định khi chạy dev thủ công. Không có dữ liệu nào được gửi ra ngoài trừ khi bạn chủ động dùng tính năng/provider cần mạng.

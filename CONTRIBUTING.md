# Đóng góp cho XinChao-Cut

*[English](CONTRIBUTING.en.md) · **Tiếng Việt***

Cảm ơn bạn đã quan tâm đến dự án! Mọi đóng góp — báo lỗi, đề xuất tính năng, cải thiện tài liệu hay gửi code — đều được hoan nghênh.

## Quy tắc ứng xử

Khi tham gia dự án, bạn đồng ý tuân theo [Quy tắc ứng xử](CODE_OF_CONDUCT.md).

## Báo lỗi (issue)

Trước khi mở issue mới, vui lòng tìm xem lỗi đã được báo chưa. Khi báo lỗi, hãy kèm theo:

- Mô tả ngắn gọn vấn đề và hành vi mong đợi.
- Các bước tái hiện (càng cụ thể càng tốt).
- Môi trường: hệ điều hành, trình duyệt (và phiên bản), có bật backend hay không.
- Log hoặc ảnh chụp màn hình nếu có.

> ⚠️ Đừng dán secret, token hay thông tin cá nhân vào issue.

## Đề xuất tính năng

Mở một issue mô tả tính năng, lý do hữu ích và (nếu có) ý tưởng triển khai. Hãy thảo luận trước khi bắt tay vào những thay đổi lớn để tránh công sức bị lãng phí.

## Quy trình gửi Pull Request

1. **Fork** repo và tạo nhánh từ `main`:
   ```bash
   git checkout -b feat/ten-tinh-nang
   ```
2. Cài đặt và chạy dự án theo [README](README.md).
3. Thực hiện thay đổi, giữ phạm vi PR gọn và tập trung vào một mục tiêu.
4. Đảm bảo các kiểm tra dưới đây **đều xanh** trước khi mở PR.
5. Mở Pull Request về nhánh `main`, mô tả rõ thay đổi, lý do và cách đã kiểm thử. Liên kết tới issue liên quan nếu có.

## Kiểm tra trước khi gửi

**Frontend:**

```bash
npm run lint
npm run typecheck
npm run build
npm run test
```

**Backend** (nếu có thay đổi trong `backend/`):

```bash
cd backend
python -m compileall -q app
pytest -q
```

CI sẽ chạy đúng các bước này, nên hãy chạy cục bộ trước để tiết kiệm thời gian.

## Quy ước code

- **TypeScript/React:** tuân theo ESLint + Prettier của dự án (`npm run lint:fix`, `npm run format`). Giữ TypeScript ở chế độ strict, tránh `any`.
- **Python:** giữ phong cách hiện có, type hint khi hợp lý.
- Đặt tên rõ ràng, ưu tiên code dễ đọc. Tham khảo thêm `docs/04-clean-code.md`.
- Không thêm dependency mới nếu không thật sự cần; nếu cần, ghim phiên bản và nêu lý do trong PR.

## Quy ước commit

Khuyến khích dùng [Conventional Commits](https://www.conventionalcommits.org/) để lịch sử dễ đọc:

- `feat:` tính năng mới
- `fix:` sửa lỗi
- `docs:` thay đổi tài liệu
- `refactor:` tái cấu trúc không đổi hành vi
- `test:` thêm/sửa test
- `chore:` việc lặt vặt (build, config…)

## Giấy phép

Khi đóng góp, bạn đồng ý rằng phần đóng góp của mình được phát hành theo giấy phép [MIT](LICENSE) của dự án.

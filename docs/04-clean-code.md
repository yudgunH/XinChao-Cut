# 04 — Quy ước code và review

Mục tiêu của tài liệu này là mô tả tiêu chuẩn đang được repo kiểm tra. Không ghi một quy tắc là “CI enforce” nếu workflow hoặc config chưa thực sự enforce nó.

## 1. TypeScript và React

- TypeScript chạy strict theo `tsconfig.app.json`; không hạ strictness để né một lỗi cục bộ.
- Ưu tiên `unknown` và narrow thay cho `any` ở boundary không tin cậy.
- Dùng named export theo phong cách hiện có; lazy component có thể có nhu cầu riêng.
- React dùng function component và hooks.
- Store selector nên chọn đúng field cần dùng để tránh render lại toàn cây.
- Logic nặng hoặc có thể test độc lập nên ở `engine/`/`lib/`; component giữ phần event và presentation.
- Không tách component chỉ để đạt một giới hạn số dòng giả định. Tách khi ownership, lifecycle, test hoặc khả năng đọc được cải thiện.

## 2. Timeline và state

- Thay đổi nội dung timeline phải đi qua action của `timeline-store` để undo/redo và history budget vẫn đúng.
- Selection, zoom và UI state không được làm project autosave bẩn nếu nội dung không đổi.
- Khi thao tác với compound clip, tính cả reference trong nested timeline; không chỉ quét root clips.
- Các job async phải mang project/asset ownership. Kết quả từ project cũ không được ghi vào project mới sau khi người dùng chuyển màn hình.

## 3. Async và lifecycle

- Listener, timer, worker, media element và network request phải có cleanup/cancel phù hợp.
- Tác vụ dài nên nhận `AbortSignal` hoặc có endpoint cancel khi kiến trúc cho phép.
- Không giữ Blob/ArrayBuffer lớn lâu hơn ownership của operation.
- Khi lưu dữ liệu qua IndexedDB + OPFS, dùng transaction/publish protocol hiện có; không tạo trạng thái DB trỏ tới blob chưa ghi xong.
- Không giả định `spawn()` thành công đồng nghĩa service đã healthy; với backend phải kiểm tra `/health` hoặc capability.

`catch {}` chỉ phù hợp với best-effort cleanup/probe khi failure đã được biểu diễn bằng state khác. Lỗi user-facing phải có thông báo hành động được hoặc được ghi vào log liên quan.

## 4. Backend Python

- Core app phải import được khi chưa cài WhisperX, FunASR, Demucs hoặc OmniVoice; optional dependency được import lazy.
- Backend bind mặc định `127.0.0.1` và không được đổi ra network interface trong bản phát hành nếu chưa có authentication.
- FFmpeg command phải dùng argument list, validate input/output và không ghép shell string từ dữ liệu người dùng.
- Job phải hỗ trợ lifecycle rõ: start, status/progress, cancel, cleanup và quota.
- TTS chạy trong interpreter riêng; không làm rò dependency OmniVoice vào main venv.
- Config ứng dụng dùng prefix `XINCHAO_`; API key provider là secret không commit.

## 5. Tauri và Windows

- Path từ Tauri có thể mang tiền tố `\\?\`; chuẩn hóa trước khi giao cho PowerShell filesystem provider hoặc `cmd.exe`.
- Lệnh nền phải dùng `CREATE_NO_WINDOW`/hidden window khi không cần UI console.
- Runtime người dùng ở `%LOCALAPPDATA%\XinChao-Cut`, không nằm trong install directory và không bị xóa khi nâng cấp app.
- Khi thoát app, dừng cả process tree backend/setup; không chỉ kill shell cha.
- Native file scope chỉ mở rộng theo path người dùng đã chọn.

## 6. Test

Frontend dùng Vitest, test đặt cạnh source. Backend dùng Pytest trong `backend/tests`. Rust unit test nằm trong crate Tauri.

Các lệnh kiểm tra đầy đủ:

```powershell
npm run lint
npm run typecheck
npm test -- --run
npm run build
python -m pytest backend -q
cd src-tauri
cargo fmt --all -- --check
cargo test --lib
```

CI hiện chạy frontend lint/typecheck/build/Vitest và backend core import/compile/Pytest trên mọi PR và push vào `main`. Rust test/build cần chạy cục bộ khi sửa `src-tauri/` vì workflow hiện tại chưa có Rust job.

## 7. Test theo loại thay đổi

| Thay đổi          | Kiểm tra tối thiểu                                                |
| ----------------- | ----------------------------------------------------------------- |
| Timeline/store    | Unit test action, undo/redo, ownership/history                    |
| Media/persistence | Failure/cancel/orphan cleanup và reload durability                |
| Preview/export    | Parity, lifecycle, memory/storage admission                       |
| Backend route/job | Success, invalid input, cancel, restart/persistence khi liên quan |
| Setup/Tauri       | Path đóng gói, version, resource staging và smoke `/health`       |
| Documentation     | Link/path/lệnh khớp source; `git diff --check`                    |

Test performance trong repo là regression signal, không phải SLA tuyệt đối trên mọi máy.

## 8. Format và lint

- ESLint chạy với `--max-warnings=0`.
- Prettier là formatter của frontend; dùng `npm run format` khi cần format hàng loạt.
- Rust dùng `cargo fmt`.
- Python giữ style hiện tại và type hint ở boundary phức tạp; repo chưa tuyên bố một formatter Python bắt buộc trong CI.
- Repo chưa cấu hình Husky/lint-staged, vì vậy không ghi chúng như pre-commit gate.

## 9. Dependency và bundle

- Thêm dependency phải có lý do và cập nhật lockfile.
- Optional AI dependency không được đưa vào Core tier nếu làm Lite install nặng hoặc phá import lazy.
- Không ghi một giới hạn bundle cố định nếu chưa có CI budget. Theo dõi warning Vite và tách lazy các panel/diagnostics nặng khi có lợi thực tế.
- Model weights, venv, cache và build artifact không được commit.

## 10. Security và privacy

- Không commit `.env`, `.env.local`, token hoặc sample chứa dữ liệu riêng tư.
- Không log API key; trước khi chia sẻ log phải xóa path và dữ liệu nhạy cảm.
- Media/project local không tự động upload ra ngoài. Nếu một feature gửi text hoặc file tới provider, UI/docs phải nói rõ.
- Tránh `dangerouslySetInnerHTML`, `eval` và shell interpolation từ input.

## 11. Git và tài liệu

- Khuyến khích Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `perf:`, `chore:`.
- `main` phải ở trạng thái build/test được.
- Không sửa hoặc xóa thay đổi không liên quan đang có trong working tree.
- Khi đổi public behavior, setup, shortcut, path dữ liệu hoặc release flow, cập nhật README/docs trong cùng thay đổi.

## 12. Definition of done

Một thay đổi hoàn tất khi:

1. Hành vi yêu cầu đã chạy được ở đúng môi trường mục tiêu.
2. Test phù hợp được thêm/cập nhật và các gate liên quan đều xanh.
3. Không để process, port, temp file hoặc build artifact ngoài ý muốn.
4. Error path/cancel/cleanup được kiểm tra tương xứng với rủi ro.
5. Tài liệu và version metadata khớp source nếu thay đổi có ảnh hưởng người dùng.

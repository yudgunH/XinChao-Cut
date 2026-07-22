# 02 — Giao diện và tương tác hiện tại

Tài liệu này ghi lại UI đang có trong source, không phải mockup hoặc backlog.

## 1. Các màn hình chính

### Home

- Danh sách project gần đây, tạo/đổi tên/nhân bản/xóa project.
- Mở AI Settings và Model Manager.
- First-run setup tự xuất hiện khi bản desktop chưa có Core + FFmpeg.

### Editor

```text
┌──────────────────────────────────────────────────────────────┐
│ Top bar: logo · panel tabs · project · undo/redo · backend  │
│                                              shortcut · export│
├──────────────┬────────────────────────────┬──────────────────┤
│ Left panel   │ Preview                    │ Properties       │
│ Media/Audio/ │                            │ Video/Audio/     │
│ Text/...     │                            │ Speed/...        │
├──────────────┴────────────────────────────┴──────────────────┤
│ Timeline toolbar, ruler, tracks, clips và playhead           │
└──────────────────────────────────────────────────────────────┘
```

Cửa sổ Tauri mặc định `1440×900`, tối thiểu `1024×640`.

## 2. Kích thước và resize

Giá trị hiện tại trong `ui-store`:

| Vùng        | Mặc định |   Giới hạn |
| ----------- | -------: | ---------: |
| Left panel  |   320 px | 200–520 px |
| Right panel |   360 px | 240–520 px |
| Timeline    |   350 px | 140–580 px |

Timeline trở về chiều cao mặc định khi vào một editor session mới. Các resize handle chỉ thay đổi UI state, không làm thay đổi project data.

## 3. Điều hướng panel

Top bar có các tab đang được khai báo trong source:

- Media
- Audio
- Text
- Stickers
- Effects
- Transitions
- Captions
- Voice
- Filters

Properties có các tab Video, Audio, Speed, Animation và Adjust. Nội dung thay đổi theo clip được chọn.

## 4. Preview

- Hiển thị composition tại playhead và đồng bộ với Web Audio khi playback.
- Có khung mô phỏng Clean, TikTok, Shorts và Reels.
- Transform/crop/rotate, text, caption, filter và transition được phản ánh ở preview theo capability của renderer.
- Preview có fallback khi codec/browser GPU path không khả dụng; export advisor có thể đề xuất engine khác với preview.

## 5. Timeline

Timeline hiện hỗ trợ:

- nhiều track video, audio, text và FX;
- kéo clip giữa thời điểm/track, trim hai mép và split tại playhead;
- snap, link clip liên quan và magnetic main track;
- copy/cut/paste/duplicate, group/ungroup;
- compound clip, mở nested timeline và phá compound;
- crop/rotate, mute, detach audio, scene split, proxy và các action AI theo ngữ cảnh;
- undo/redo có giới hạn theo memory budget;
- virtualization track/thumbnail và active-clip index cho timeline lớn.

Một số mục hiển thị nhưng đang disabled trong menu transform, ví dụ Freeze và Reverse; không mô tả chúng như tính năng hoàn chỉnh.

## 6. Model Manager và backend status

Menu trạng thái backend hiển thị online/offline, FFmpeg/encoder/CUDA capability, proxy mode và lối vào Model Manager. Nút **Khởi động backend** gọi Tauri command trong bản desktop; browser build chỉ hiển thị backend theo URL đã cấu hình.

Model Manager cài hoặc cập nhật Core, WhisperX, FunASR, Demucs và OmniVoice. Bỏ chọn một tier không xóa môi trường/model đã có.

## 7. Export dialog

Export dialog cho phép:

- bật/tắt video, audio và subtitle output;
- chọn resolution, FPS, quality, codec và dynamic range theo capability;
- chọn Browser hoặc Server khi cả hai hợp lệ;
- dùng engine advisor để tránh export sai parity hoặc vượt memory/storage;
- theo dõi progress, cancel và xem chẩn đoán encoder sau server export.

Browser export chỉ giữ SDR; HDR cần server path phù hợp. Một số tính năng hình ảnh buộc browser renderer để khớp preview.

## 8. Shortcut mặc định

Nguồn sự thật là `src/store/shortcut-store.ts`; người dùng có thể đổi shortcut trong app.

| Phím                      | Tác vụ                                     |
| ------------------------- | ------------------------------------------ |
| `Shift+?`                 | Mở/đóng bảng shortcut                      |
| `Space`                   | Play/pause                                 |
| `←` / `→`                 | Lùi/tiến một frame                         |
| `Home` / `End`            | Tới đầu/cuối timeline                      |
| `S`                       | Split clip đã chọn hoặc clip dưới playhead |
| `Q` / `W`                 | Trim mép trái/phải tới playhead            |
| `C`                       | Mở Crop & Rotate                           |
| `Delete`                  | Xóa clip đã chọn                           |
| `Escape`                  | Bỏ chọn/đóng ngữ cảnh hiện tại             |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo/redo                                  |
| `Ctrl+C/X/V/D`            | Copy/cut/paste/duplicate                   |
| `Ctrl+G` / `Ctrl+Shift+G` | Group/ungroup                              |
| `Alt+G` / `Alt+Shift+G`   | Tạo/phá compound clip                      |

Khi focus đang ở input text, textarea hoặc contenteditable, shortcut dựng phim không chạy. Gán một tổ hợp đã dùng sẽ gỡ tổ hợp đó khỏi action cũ.

## 9. Trạng thái và accessibility

- Icon button quan trọng có `title`/`aria-label`; modal và popover hỗ trợ Escape khi phù hợp.
- Màu trạng thái backend không đứng một mình: panel cũng ghi online/offline và capability.
- Các tác vụ dài hiển thị progress/log hoặc Background Tasks.
- Drag/drop native và browser được xử lý riêng để giữ đúng path trên Tauri.

Accessibility chưa được tuyên bố đạt một mức WCAG cụ thể. Khi sửa UI cần kiểm tra keyboard focus, contrast, label và reduced motion thay vì giả định đã đạt chuẩn.

## 10. Design tokens

Theme tối và token màu nằm trong `src/app/globals.css`, `src/styles/tokens.css` và Tailwind config. Không sao chép bảng màu vào tài liệu như nguồn sự thật; component mới nên tái sử dụng class/token hiện có (`bg-bg-*`, `text-text-*`, `border-border`, `text-accent`, trạng thái success/warning/danger).

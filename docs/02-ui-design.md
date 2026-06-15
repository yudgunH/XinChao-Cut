# 02 — Thiết kế giao diện (UI Design)

## 1. Triết lý

- **Dark-first**: editor video luôn dark để mắt không mỏi, màu video không bị lệch nhận thức
- **Mật độ cao nhưng có hơi thở**: panel dày đặc info, nhưng padding nhất quán
- **Tương tác phải dự đoán được**: drag, snap, hotkey giống chuẩn ngành (Premiere/CapCut)
- **Không ẩn chức năng phía sau menu sâu**: top-level ≤ 2 cấp

## 2. Layout chính

```
┌────────────────────────────────────────────────────────────────┐
│  TopBar (48px)  Logo · Project · Save · Undo/Redo · Export    │
├──────────┬───────────────────────────────┬─────────────────────┤
│          │                               │                     │
│  Left    │      Preview Canvas           │   Right Panel       │
│  Panel   │      (16:9 aspect)            │   (Properties)      │
│  (280px) │                               │   (320px)           │
│          │                               │                     │
│  Media   │                               │                     │
│  Text    ├───────────────────────────────┴─────────────────────┤
│  Audio   │   Playback Controls (40px)                          │
│  FX      ├──────────────────────────────────────────────────────┤
│  Trans   │                                                      │
│          │           Timeline (resizable, default 280px)        │
│          │                                                      │
└──────────┴──────────────────────────────────────────────────────┘
```

- Tất cả split bar đều **drag-to-resize**, lưu kích thước vào `uiStore`
- Min/max constraints: Left 240-400px, Right 280-480px, Timeline 200-600px
- Có thể collapse Left/Right bằng icon mũi tên

## 3. Design tokens

### Màu (CSS variables)
```css
:root {
  --bg-0: #0e0e10;        /* viewport background */
  --bg-1: #17171a;        /* panels */
  --bg-2: #1f1f24;        /* surface elevated (cards, clips) */
  --bg-3: #2a2a31;        /* hover */
  --bg-4: #353540;        /* active/selected */

  --border: #2a2a31;
  --border-strong: #3a3a44;

  --text-1: #f4f4f5;      /* primary text */
  --text-2: #a1a1aa;      /* secondary */
  --text-3: #71717a;      /* disabled */

  --accent: #4f9cf9;      /* primary action (Capcut blue) */
  --accent-hover: #6aaffa;
  --danger: #ef4444;
  --success: #22c55e;
  --warning: #f59e0b;

  --track-video: #3b82f6;
  --track-audio: #10b981;
  --track-text:  #f59e0b;
  --track-fx:    #a855f7;
}
```

### Spacing scale (Tailwind defaults)
4 / 8 / 12 / 16 / 24 / 32 / 48px. Không tự ý dùng giá trị ngoài scale.

### Typography
- Font: `Inter`, fallback system-ui
- Sizes: 11 / 12 / 13 / 14 / 16 / 20 / 24
- Line-height: 1.4 cho body, 1.2 cho heading
- Mono (timecode): `JetBrains Mono`, 12px

### Radius
4 / 6 / 8px. Clip trên timeline = 4px. Button = 6px. Card = 8px.

### Shadow
- Elev 1: `0 1px 2px rgba(0,0,0,.3)`
- Elev 2 (popover): `0 8px 24px rgba(0,0,0,.4)`
- Elev 3 (modal): `0 16px 48px rgba(0,0,0,.5)`

## 4. Components

### 4.1 TopBar
- Trái: logo (24px) + tên project (inline-edit on click)
- Giữa: undo / redo (tooltip có shortcut)
- Phải: Save status indicator ("Saved · 2s ago"), Export button (accent, primary)

### 4.2 Left Panel — Media Library
- Tabs đứng (icon + label): Media / Audio / Text / Effects / Transitions / Stickers
- Tab Media:
  - Drop zone (toàn panel khi drag-over, viền accent dashed)
  - Grid thumbnail 2 cột, hover hiện duration + format
  - Click = preview hover trên Preview, drag = thêm vào timeline
  - Sort: by date / name / duration, filter: video/image/audio

### 4.3 Preview
- Canvas trong khung 16:9 (letterbox đen nếu khác aspect)
- Overlay khi hover: safe-zone toggle, aspect ratio selector
- Bottom controls: ⏮ ⏯ ⏭ · timecode `00:00:00:00` (current / total) · volume · fullscreen
- Hotkey: Space = play, J/K/L = reverse/pause/forward, ←/→ = ±1 frame

### 4.4 Timeline
**Đây là phần phức tạp nhất — chi tiết:**

```
┌──────────────────────────────────────────────────────────────┐
│ Toolbar: ⬚ Select │ ✂ Split │ 🔍 Zoom │ 🧲 Snap │   [───●───] │  ← 32px
├────┬─────────────────────────────────────────────────────────┤
│Hdr │ Ruler: 00:00 ─── 00:05 ─── 00:10 ─── 00:15 ─── │       │  ← 24px
├────┼─────────────────────────────────────────────────────────┤
│V2  │     ▓▓▓▓▓▓▓                                              │  ← 48px
├────┼─────────────────────────────────────────────────────────┤
│V1  │ ▓▓▓▓▓▓▓▓▓▓▓▓     ▓▓▓▓▓▓▓▓▓▓                              │  ← 56px (main)
├────┼─────────────────────────────────────────────────────────┤
│A1  │ ╱╲╱╲╱╲╱╲╱╲╱╲     ╱╲╱╲╱╲╱╲╱╲                              │  ← 40px
├────┼─────────────────────────────────────────────────────────┤
│T1  │       [Title Text]                                       │  ← 32px
└────┴─────────────────────────────────────────────────────────┘
```

- **Header track** (60px): icon type + name + mute/solo/lock
- **Ruler**: tick density tự đổi theo zoom (frame / second / 5s / 10s / 1min)
- **Playhead**: line dọc đỏ, có drag-handle hình tam giác trên ruler
- **Clip**:
  - Background = màu track type, opacity 0.9
  - Thumbnail strip cho video clip (lazy load)
  - Waveform cho audio clip
  - Cạnh trái/phải = trim handle (cursor `ew-resize`)
  - Selected: viền 2px accent
  - Snap indicator: line vàng mảnh khi cạnh align với playhead/clip khác
- **Zoom**: Ctrl+wheel, hoặc slider phải toolbar. Range: 1 px = 0.01s → 1 px = 10s
- **Scroll**: wheel ngang, hoặc Shift+wheel; auto-scroll khi drag chạm mép

### 4.5 Right Panel — Properties
Context-sensitive theo selection:

- **Clip video**: Transform (x/y/scale/rotate), Opacity, Blend mode, Speed (slider 0.25-4x), Reverse toggle, Volume
- **Clip audio**: Volume, Fade in/out, Pitch, Denoise toggle
- **Clip text**: Font, size, color, weight, alignment, stroke, shadow, animation in/out
- **Empty selection**: Project settings (resolution, fps, background color)

Mỗi property dùng pattern: `label · control · numeric-input`. Slider luôn có input số bên cạnh để gõ chính xác.

### 4.6 Modal / Dialog
- Export dialog: preset 720p/1080p/4K, fps, bitrate slider, format MP4/MOV, output path, preview ước lượng dung lượng
- Confirm dialog: title + body + 2 button (cancel + primary action)
- Hotkey ESC để đóng, Enter để confirm

## 5. Interaction patterns

### Drag & drop
- File từ OS → drop vào left panel hoặc timeline (timeline tự tạo track mới nếu không khớp)
- Asset trong left panel → drop vào timeline (snap to playhead nếu trong 8px)
- Clip trên timeline: drag = move, drag cạnh = trim, Alt+drag = duplicate

### Snapping
- Magnetic snap toggle (default ON)
- Snap targets: playhead, clip edges, marker, ruler tick chẵn
- Hiện snap line vàng + haptic feel (delay 80ms khi rời snap)

### Hotkey (must-have MVP)
| Phím | Action |
|---|---|
| Space | Play/Pause |
| J / K / L | Reverse / Pause / Forward |
| ← / → | -1 / +1 frame |
| Shift+← / → | -1s / +1s |
| Home / End | Đầu / cuối timeline |
| S | Split clip tại playhead |
| Delete / Backspace | Xóa clip selected |
| Ctrl+Z / Ctrl+Shift+Z | Undo / Redo |
| Ctrl+S | Save |
| Ctrl+E | Export |
| Ctrl+= / Ctrl+- | Zoom timeline |
| Ctrl+0 | Fit timeline |
| M | Add marker |
| Ctrl+D | Duplicate selected |
| Ctrl+G | Group selected |

### Context menu (right-click)
- Trên clip: Cut/Copy/Paste/Delete · Split · Speed · Replace · Properties
- Trên track header: Add track above/below · Rename · Mute · Lock · Delete

## 6. Trạng thái UI (states)

Mọi component tương tác cần định nghĩa 5 state:
`default` · `hover` · `active` · `focus` · `disabled`

Selected (cho clip, asset): viền 2px accent + glow nhẹ.

## 7. Animation

- Transition mặc định: `150ms ease-out` cho hover, `200ms ease-in-out` cho panel resize
- **Không animate** vị trí clip khi drag (phải 1:1 con trỏ)
- **Không animate** scroll/zoom timeline (chỉ làm chậm cảm giác)
- Loading skeleton thay vì spinner cho thumbnail
- Reduce-motion query: tắt mọi animation không thiết yếu

## 8. Accessibility (mục tiêu A-)

- Mọi action có hotkey hoặc focus chain
- Focus ring rõ (outline 2px accent, offset 2px)
- ARIA labels cho icon button
- Contrast text/bg ≥ 4.5:1
- Không phụ thuộc duy nhất vào màu để truyền tải info (clip type cũng có icon)

## 9. Responsive

- Desktop only cho MVP. Min width 1280px.
- < 1280px: hiện cảnh báo "App is optimized for desktop"
- Mobile: roadmap sau

## 10. Empty / loading / error states

- **Empty timeline**: minh họa "Drag a media file here to start"
- **Loading asset**: skeleton card với shimmer
- **Decode error**: thumbnail xám + icon ⚠ + tooltip lý do
- **Export fail**: modal với error code + log copyable

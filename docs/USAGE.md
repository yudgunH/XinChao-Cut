# Hướng dẫn sử dụng XinChao-Cut

## 0. Nhìn nhanh giao diện

- **Home**: tạo, mở, đổi tên và xóa project gần đây.
- **Thanh trên cùng**: chuyển panel Media/Audio/Text/Effects/Captions/Voice, undo/redo, phím tắt, AI Settings, trạng thái backend và Export.
- **Panel trái**: thư viện media và công cụ theo tab đang chọn.
- **Preview giữa**: xem frame hiện tại; kéo/scale/rotate đối tượng trực tiếp khi được hỗ trợ.
- **Properties bên phải**: Video, Audio, Speed, Animation và Adjust của clip đang chọn.
- **Timeline phía dưới**: track video/audio/text/fx, playhead, toolbar snap/link/magnetic và vùng clip.

Biểu tượng backend màu xanh nghĩa là FastAPI đang hoạt động. Backend offline không khóa editor; chỉ các chức năng server/AI tương ứng bị ẩn hoặc chuyển sang browser fallback.

## 1. Tạo dự án và nhập media

1. Từ Home, tạo dự án mới hoặc mở dự án gần đây.
2. Ở panel Media, bấm Import hoặc kéo file video/audio/ảnh vào ứng dụng.
3. Kéo asset xuống timeline. File gốc trên desktop được đọc từ máy; tránh di chuyển/xóa file khi dự án còn dùng nó.

Khi kéo nhiều file, chờ thumbnail/waveform tạo xong ở nền. Video lớn hơn 1080p có thể được tạo proxy tự động ở chế độ Smart; đổi chế độ proxy trong menu trạng thái backend.

Ứng dụng tự lưu thay đổi. Với dự án quan trọng, vẫn nên giữ bản media gốc và export định kỳ.

## 2. Dựng trên timeline

- Kéo clip để đổi vị trí hoặc đổi track.
- Kéo mép clip để trim; đưa playhead tới vị trí cần cắt và dùng lệnh Split.
- Bật Snap để bám vào playhead và mép clip.
- Bật Link để video kéo theo caption/audio liên kết; tắt nếu muốn dịch chuyển độc lập.
- Bật Magnetic main track nếu muốn track video chính tự đóng khoảng trống.
- Chọn clip để chỉnh transform, crop, tốc độ, opacity, âm lượng, màu và hiệu ứng ở Properties.
- Dùng undo/redo ngay khi thao tác chưa đúng; history có giới hạn để tránh chiếm quá nhiều RAM.

Chuột phải clip để mở các thao tác theo ngữ cảnh như crop/rotate, replace, group hoặc compound. Chọn nhiều clip bằng Ctrl/Shift theo hành vi hiển thị trong UI trước khi group.

### Text, hiệu ứng và transition

- Tab **Text** thêm text preset; kéo text clip để đổi thời lượng rồi chỉnh nội dung/style ở Properties.
- Tab **Effects** áp hiệu ứng chuyển động cho clip hình ảnh/video/text đang chọn.
- Tab **Transitions** thêm fade/slide/rise/drop vào đầu hoặc cuối clip.
- Tab **Filters** và mục Adjust chỉnh brightness, contrast, saturation cùng các thông số màu.
- Hover effect tile để preview trước; click để áp dụng, click trạng thái đã áp dụng để gỡ nếu UI cho phép.

## 3. Tạo và sửa phụ đề

Mở tab **Captions**:

- Import `.srt`, `.vtt` hoặc `.ass` nếu đã có subtitle.
- Chọn WhisperX cho đa ngôn ngữ. `Tiny` nhanh/nhẹ, `Small` cân bằng, `Large v3` nặng nhưng thường chính xác hơn.
- Khi backend có FunASR, có thể chọn nó cho tiếng Trung. Nếu chưa cài, ứng dụng dùng WhisperX và hiển thị đường dẫn tới Model Manager.
- Chọn ngôn ngữ đúng để giảm thời gian dò tự động.
- Sau khi tạo, rà lại text và timing; AI transcription luôn có thể nghe nhầm tên riêng, số hoặc đoạn có nhạc nền.

Quy trình khuyên dùng:

1. Đưa toàn bộ clip cần nghe lên timeline và bỏ mute.
2. Chọn engine/provider, model và ngôn ngữ.
3. Chạy tạo caption; có thể chuyển tab trong lúc chạy nhưng không đóng project.
4. Rà timing, sửa nội dung/tên riêng trong caption editor.
5. Nếu cần, mở AI Settings, cấu hình provider rồi dùng correction/translation.
6. Chỉnh style chung và kiểm tra vùng safe-area ở preview.

Có thể chỉnh font, màu, nền, vị trí và animation trong Caption Studio/Properties. Khi export, chọn burn-in nếu muốn subtitle nằm trong hình, hoặc xuất file subtitle riêng.

## 4. Voice Studio

1. Cài gói OmniVoice trong **Quản lý model**.
2. Mở tab **Voice**, bấm **Mở Voice Studio**.
3. Chọn voice dựng sẵn hoặc tạo voice clone từ mẫu thu.
4. Nhập từng câu/đoạn, tạo thử, nghe preview và chỉnh lại text.
5. Tải WAV hoặc đưa audio đã tạo vào thư viện/timeline.

Ngay trong tab Voice có hai luồng nhanh:

- Nhập text để tạo một clip voice tại vị trí playhead.
- Đọc toàn bộ caption thành voiceover, theo timing caption hoặc nối tuần tự tùy chế độ.

Nếu tạo voiceover theo caption, hãy sửa caption xong trước. Nghe lại các đoạn nối và điều chỉnh speed/clip timing trên timeline sau khi tạo.

Mẫu clone nên sạch, ít tiếng vọng, chỉ có một người nói. Chỉ clone giọng khi có quyền và sự đồng ý phù hợp; không dùng để giả mạo hoặc lừa đảo.

## 5. Tách giọng và nhạc

Cài gói Demucs, chọn clip audio/video rồi mở Properties → Audio để chạy tách vocals/music. Job nặng sẽ chạy qua backend. Kết quả là các stem audio riêng để preview, tải xuống hoặc đưa trở lại timeline.

Nên tắt/mute audio gốc khi dùng stem mới để tránh hai lớp âm thanh phát chồng nhau. Noise reduction preview và mastering export là hai bước khác nhau; nghe lại output cuối bằng tai nghe.

## 6. Export

Mở **Export** trên thanh trên cùng:

- Chọn MP4 cho video, MP3/WAV cho audio hoặc SRT cho subtitle.
- **Server/FFmpeg** phù hợp cho project lớn, codec phổ biến và máy desktop đã cài Core.
- **Browser/WebCodecs** dùng khi không có backend hoặc muốn xử lý hoàn toàn trong trình duyệt.
- Kiểm tra resolution, FPS, bitrate, audio và lựa chọn caption trước khi chạy.
- Không đóng ứng dụng hay xóa media gốc cho đến khi export hoàn tất.

Quy trình an toàn:

1. Đưa playhead qua đầu, giữa và cuối project để kiểm tra frame/âm thanh.
2. Mở Export, đặt tên và thư mục output.
3. Chọn Video/Audio/Caption cần xuất; có thể xuất nhiều loại trong một lần.
4. Chọn resolution, FPS, quality, codec và SDR/HDR phù hợp nguồn.
5. Dùng engine được ứng dụng đề xuất; chỉ ép engine khác khi biết codec/tính năng tương thích.
6. Chờ progress hoàn tất rồi mở file output kiểm tra trước khi xóa media/cache.

Nếu export lỗi, thử tên file ngắn không có ký tự lạ, kiểm tra dung lượng ổ, mở lại media bị thiếu và xem log backend.

## 7. Quản lý model và dung lượng

Mở menu trạng thái backend → **Quản lý model** để:

- thêm/cập nhật WhisperX, FunASR, Demucs hoặc OmniVoice;
- đổi model Whisper mặc định;
- tải trước model để dùng offline;
- đổi thư mục lưu model/dữ liệu.

Bỏ chọn một gói không xóa dữ liệu đã tải. Muốn giải phóng dung lượng, đóng backend rồi sao lưu voice cần giữ trước khi xóa cache trong thư mục dữ liệu. Không xóa virtual environment hoặc file marker khi setup đang chạy.

## 8. Dịch phụ đề bằng LLM

Dịch qua Gemini/OpenAI/Anthropic/OpenRouter là tùy chọn và dùng mạng. Cấu hình provider/API key trong phần AI Settings hoặc backend theo [backend/README.md](../backend/README.md). Chỉ nội dung gửi cho tác vụ dịch mới được chuyển tới provider đã chọn; đọc điều khoản của provider trước khi gửi nội dung nhạy cảm.

## 9. Phím tắt

Mở biểu tượng bàn phím hoặc nhấn `Shift+?` để xem/chỉnh danh sách đúng với phiên bản đang chạy. Mặc định:

| Phím | Tác vụ |
|---|---|
| `Space` | Play/pause |
| `←` / `→` | Lùi/tiến một frame |
| `Home` / `End` | Tới đầu/cuối timeline |
| `S` | Split clip đã chọn hoặc clip dưới playhead |
| `Q` / `W` | Trim mép trái/phải tới playhead |
| `C` | Mở Crop & Rotate |
| `Delete` | Xóa clip đã chọn |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo/redo |
| `Ctrl+C/X/V/D` | Copy/cut/paste/duplicate |
| `Ctrl+G` / `Ctrl+Shift+G` | Group/ungroup |
| `Alt+G` / `Alt+Shift+G` | Tạo/phá compound clip |
| `Escape` | Bỏ chọn hoặc đóng ngữ cảnh hiện tại |

Có thể click một shortcut trong bảng rồi nhấn tổ hợp mới. Shortcut trùng sẽ được gỡ khỏi tác vụ cũ. Một số phím tắt bị vô hiệu khi con trỏ đang ở ô nhập text để tránh sửa timeline ngoài ý muốn.

## 10. Khi cần báo lỗi

Ghi lại phiên bản ứng dụng, Windows, CPU/GPU, thao tác tái hiện và engine export. Với lỗi backend, đính kèm đoạn log liên quan từ `%LOCALAPPDATA%\XinChao-Cut\backend.log` sau khi đã xóa API key, đường dẫn hoặc dữ liệu nhạy cảm.

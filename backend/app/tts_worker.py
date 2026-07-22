"""OmniVoice worker — runs in the ISOLATED `.venv-omnivoice` interpreter.

This file must NEVER be imported by the main FastAPI app (whose venv has
WhisperX/Demucs pinned to transformers 4.x / numpy 1.x — incompatible with
OmniVoice's transformers>=5 / numpy 2). The app spawns it as a subprocess.

Two ways to run it:

  One-shot (loads the model, does one job, exits):
    <omnivoice_python> -m app.tts_worker synth        <spec.json>
    <omnivoice_python> -m app.tts_worker create-voice <spec.json>

  Resident server (loads the model ONCE, then processes jobs from stdin so the
  ~3 s model load isn't paid per job):
    <omnivoice_python> -m app.tts_worker serve
  Each stdin line is a JSON command: {"cmd": "synth"|"create-voice",
  "spec_path": "..."}. Results are written to the spec's status files
  (progress.json / create_result.json) exactly like the one-shot path, which the
  app polls. A failing job never kills the server — the model stays resident.
"""
from __future__ import annotations

import json
import os
import re
import sys


def _write_json(path: str, data: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def _load_model():
    import torch
    from omnivoice import OmniVoice

    if torch.cuda.is_available():
        # Ampere+ TF32 — faster GEMMs at negligible quality loss for inference.
        # NOTE: do NOT enable cudnn.benchmark — TTS inputs are variable length,
        # so benchmark mode re-tunes kernels for every new shape (CPU spike).
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        device = "cuda"
    else:
        print("WARNING: CUDA not available — OmniVoice will run on CPU", file=sys.stderr)
        device = "cpu"

    # Pin the WHOLE model to one device. device_map="auto" lets accelerate decide
    # and, when it judges VRAM tight, silently offloads layers to CPU — which runs
    # generation through slow CPU hooks (the "uses CPU / freezes" symptom). An
    # explicit device forces GPU (matches OmniVoice's own CLI) or OOMs loudly.
    return OmniVoice.from_pretrained("k2-fsa/OmniVoice", dtype=torch.float16, device_map=device)


# ── Voice quality: best-of-N + acoustic validation ──
# OmniVoice thỉnh thoảng sinh audio "không ra tiếng / cụt / méo" — nhất là tiếng Việt.
# Sinh nhiều seed, chấm bằng librosa (tỉ lệ frame có giọng + tốc độ WPM) rồi chọn bản
# sạch nhất; bản đầu (anchor) đủ tốt thì dừng sớm nên đa số chỉ tốn 1 lần generate.
SAMPLE_RATE = 24000
GUIDANCE_SCALE = float(os.environ.get("OMNIVOICE_GUIDANCE_SCALE", "2.5"))  # default OmniVoice = 2.0
CANDIDATE_SEEDS = (42, 7, 123, 999, 2025, 31415)
_MIN_WORDS_GUARD = 8                      # text ngắn hơn → bỏ heuristic (dễ báo nhầm)
_WARN_WPM, _STOP_WPM = 380.0, 520.0       # >WARN nghi cụt; >STOP chắc chắn cụt → re-roll seed
_WARN_VOICED, _STOP_VOICED = 0.45, 0.18   # <WARN nghi rè; <STOP chắc chắn không ra tiếng → re-roll

# Tách CÂU trước khi đọc. OmniVoice có ngân sách độ dài hữu hạn: đưa cả ĐOẠN dài
# vào 1 lần → model dồn/đọc nhanh → "nuốt chữ, sai lời" (đo: ~90 từ ra 15s = 360 wpm
# vs tự nhiên ~150). Đọc từng câu (≤ MAX_CHUNK_CHARS) rồi GHÉP lại với khoảng nghỉ.
_MAX_CHUNK_CHARS = 200
_SENT_SPLIT = re.compile(r"(?<=[.!?…])\s+")
_CLAUSE_SPLIT = re.compile(r"(?<=[,;:])\s+")


def _split_for_tts(text: str) -> list[str]:
    """Chia text thành các đoạn cỡ-câu để OmniVoice đọc đủ nhịp (không nuốt chữ)."""
    text = " ".join((text or "").split())
    if not text:
        return []
    chunks: list[str] = []
    for sent in _SENT_SPLIT.split(text):
        sent = sent.strip()
        if not sent:
            continue
        if len(sent) <= _MAX_CHUNK_CHARS:
            chunks.append(sent)
            continue
        # Câu quá dài → tách tiếp ở dấu phẩy/chấm phẩy, gom lại ≤ ngưỡng.
        cur = ""
        for clause in _CLAUSE_SPLIT.split(sent):
            if not cur:
                cur = clause
            elif len(cur) + 1 + len(clause) <= _MAX_CHUNK_CHARS:
                cur += " " + clause
            else:
                chunks.append(cur)
                cur = clause
        if cur:
            chunks.append(cur)
    # Gộp mảnh quá ngắn (<25 ký tự) vào đoạn trước để tránh khúc 1-2 từ cụt lủn.
    merged: list[str] = []
    for c in chunks:
        if merged and len(c) < 25:
            merged[-1] = f"{merged[-1]} {c}"
        else:
            merged.append(c)
    return merged


def _voiced_fraction(wav, sr: int) -> float:
    """Tỉ lệ frame có cao độ giọng người (librosa pyin). Thấp = rè / lảm nhảm / câm."""
    try:
        import librosa
        import numpy as np
        f0, _, _ = librosa.pyin(np.asarray(wav, dtype=np.float64), fmin=70, fmax=400, sr=sr)
        if f0 is None:
            return 0.0
        return float(np.mean(~np.isnan(f0)))
    except Exception:  # noqa: BLE001 — librosa lỗi → coi như không chấm được, đừng chặn
        return 1.0


def _too_fast(text: str, seconds: float, max_wpm: float) -> bool:
    words = len((text or "").split())
    if words < _MIN_WORDS_GUARD or seconds <= 0:
        return False
    return (words / seconds) * 60.0 > max_wpm


def _too_unvoiced(text: str, seconds: float, voiced: float, min_frac: float) -> bool:
    words = len((text or "").split())
    if words < _MIN_WORDS_GUARD or seconds < 1.0:
        return False
    return voiced < min_frac


def _synth_one_chunk(model, text: str, kwargs: dict):
    """Best-of-N cho MỘT đoạn cỡ-câu: sinh theo từng seed, chọn bản ít-cụt/ít-rè nhất;
    dừng sớm khi bản đầu đủ tốt. Trả mảng wav float32. Báo lỗi nếu trả audio rỗng."""
    import numpy as np
    import torch

    # Gom whitespace + loại ký tự điều khiển (\n\t\r…). Text bẩn/đa dòng làm OmniVoice
    # méo hoặc lắp tiếng Việt; .split() bỏ mọi whitespace control.
    text = " ".join((text or "").split())
    if not text:
        raise RuntimeError("Text đưa vào TTS rỗng sau khi chuẩn hoá.")
    min_samples = int(0.05 * SAMPLE_RATE)
    # When a hard `duration` budget is set, the clip is DELIBERATELY faster than
    # natural to fit its slot — so the "too fast = truncated" heuristic would fire
    # on every seed and burn all 6 candidates for nothing. Drop it when forced
    # (keep the empty/unvoiced checks, which still matter).
    duration_forced = kwargs.get("duration") is not None

    def _gen(seed: int, guidance: float):
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
        return np.asarray(model.generate(text=text, guidance_scale=guidance, **kwargs)[0], dtype=np.float32)

    # Badness key (empty, truncated, non_speech, seed_index) — nhỏ hơn = tốt hơn.
    # QUAN TRỌNG: audio RỖNG phải tính là TỆ NHẤT. Nếu không, dur=0 khiến
    # _too_fast/_too_unvoiced trả False → tưởng "đủ tốt" → DỪNG SỚM ở seed rỗng đầu,
    # KHÔNG thử seed khác (bug khiến "trả audio rỗng" dù seed sau có thể ra tiếng).
    best = None  # (empty, truncated, non_speech, seed_index, wav)
    for seed_index, seed in enumerate(CANDIDATE_SEEDS):
        wav = _gen(seed, GUIDANCE_SCALE)
        empty = wav.size < min_samples
        dur = wav.size / SAMPLE_RATE
        voiced = 0.0 if empty else _voiced_fraction(wav, SAMPLE_RATE)
        truncated = False if duration_forced else _too_fast(text, dur, _WARN_WPM)
        non_speech = empty or _too_unvoiced(text, dur, voiced, _WARN_VOICED)
        cand = (empty, truncated, non_speech, seed_index, wav)
        if best is None or cand[:4] < best[:4]:
            best = cand
        # Dừng sớm CHỈ khi bản này thực sự tốt (có tiếng + không cụt/câm rõ rệt).
        too_fast_hard = not duration_forced and _too_fast(text, dur, _STOP_WPM)
        hard_bad = empty or too_fast_hard or _too_unvoiced(text, dur, voiced, _STOP_VOICED)
        if not hard_bad:
            break

    # Cứu: mọi seed vẫn RỖNG (OmniVoice sụp với guidance này cho mẫu/text đó) → thử
    # guidance nhẹ hơn. CFG cao đôi khi làm model collapse với vài giọng/text tiếng Việt.
    if best[0]:
        for g in (2.0, 1.5):
            wav = _gen(CANDIDATE_SEEDS[0], g)
            if wav.size >= min_samples:
                best = (False, False, False, 0, wav)
                break

    wav = best[4]
    if wav.size < min_samples:  # <50ms = rỗng → ffprobe đọc N/A → downstream chết
        raise RuntimeError(
            f"OmniVoice trả audio rỗng cho text {text[:80]!r} sau mọi seed + guidance — "
            "giọng/text này model không đọc được, hãy đổi giọng khác."
        )
    return wav


_INTER_SENTENCE_GAP = 0.18  # ~180ms nghỉ chèn giữa các câu khi ghép
# How hard the synth-time fit may compress a clip toward its slot. OmniVoice's
# `duration=` does NOT drop the tail — it's a duration-conditioned NAR model that
# reads the WHOLE text faster to fit the token budget (verified by A/B: at 1.59×
# every word still survives ASR). So this cap is about SPEECH NATURALNESS, not
# truncation: past ~1.6× the read starts sounding rushed. 1.15× (the old value)
# was far too timid — it left long clips OVERFLOWING their slot, so they overlapped
# the next segment (the "nuốt chữ cuối" the user heard was that collision, not a
# cut clip). A residual over-slot after this fit is mopped up by atempo; anything
# still over then falls through to the T5.4 LLM-shorten pass.
_FIT_MAX_RATIO = 1.6


def _natural_duration_sec(model, text: str, clone_prompt=None) -> float | None:
    """The model's OWN estimate of how long `text` naturally takes to read, in
    seconds. CRUCIAL: pass the SAME voice clone reference (`ref_text` +
    `ref_audio_tokens`) that `generate` uses — the estimate is voice-dependent
    (a slow reference reads slower). Estimating with (None, None) falls back to a
    generic 25-token "Nice to meet you." reference, mis-sizing the fit and
    over-compressing clone voices (the cause of clipped tails). Returns None if
    the private estimator / tokenizer frame-rate isn't available, so the caller
    degrades to natural-length synthesis instead of crashing when a future
    OmniVoice renames these."""
    try:
        ref_text = getattr(clone_prompt, "ref_text", None)
        ref_audio_tokens = getattr(clone_prompt, "ref_audio_tokens", None)
        num_ref = ref_audio_tokens.size(-1) if ref_audio_tokens is not None else None
        est_tokens = model._estimate_target_tokens(text, ref_text, num_ref)
        frame_rate = model.audio_tokenizer.config.frame_rate
    except Exception:  # noqa: BLE001 — private API may drift between versions
        return None
    if not est_tokens or not frame_rate:
        return None
    return float(est_tokens) / float(frame_rate)


def _fit_duration_sec(
    target_sec: float | None, natural_sec: float | None, max_ratio: float = _FIT_MAX_RATIO
) -> float | None:
    """The `duration=` (seconds) to hand OmniVoice so a clip fits its slot. Only
    tighten when the text naturally overruns its slot, and never compress harder
    than natural/max_ratio — NOT because a tighter budget drops the tail (it does
    not: OmniVoice reads the whole text faster to fit — verified), but because past
    ~max_ratio the read sounds rushed; the residual over-slot is left to atempo +
    the T5.4 shorten pass. Returns None (=natural length) when we must not touch it:
    no target, no estimate, or it already fits."""
    if not target_sec or target_sec <= 0 or not natural_sec or natural_sec <= 0:
        return None
    if natural_sec <= target_sec:
        return None  # already fits — breathing room, don't stretch it to fill the slot
    floor = natural_sec / max_ratio
    return max(float(target_sec), floor)


def _synthesize_best(model, text: str, kwargs: dict, target_sec: float | None = None):
    """Đọc text: tách CÂU rồi đọc từng câu (best-of-N) + GHÉP, để text dài không bị
    OmniVoice dồn nhịp gây nuốt chữ. 1 câu → đọc thẳng; nhiều câu → chèn ~180ms nghỉ.

    Khi có `target_sec` (độ dài slot của segment), truyền `duration=` vào
    model.generate để OmniVoice tự siết nhịp cho vừa slot NGAY lúc sinh — nhưng chỉ
    siết tối đa `_FIT_MAX_RATIO` (xem `_fit_duration_sec`): OmniVoice đọc HẾT chữ
    nhanh hơn để vừa ngân sách token (không cụt đuôi — đã kiểm chứng), chỉ là ép quá
    tay thì giọng nghe gấp. Câu ngắn hơn slot để đọc tự nhiên; phần dư của câu dài
    do atempo + T5.4 rút gọn lo tiếp. Text nhiều câu: chia slot cho từng câu theo độ
    dài ký tự rồi fit độc lập.

    Trả (wav, natural_sec): natural_sec = tổng độ dài giọng ĐỌC TỰ NHIÊN của cả text
    (không tính ép `duration=`), gồm cả khoảng nghỉ ghép câu — để route biết mức nén
    thật và chủ động rút gọn câu nói-gấp (T5.4). 0.0 = không ước lượng được (private
    API drift) → route bỏ qua tín hiệu này, hành vi như cũ."""
    import numpy as np

    # The fit estimate must use the SAME voice reference generate uses, else a
    # clone voice's natural length is mis-estimated and the clip over-compresses.
    clone_prompt = kwargs.get("voice_clone_prompt")

    chunks = _split_for_tts(text)
    if not chunks:
        raise RuntimeError("Text đưa vào TTS rỗng sau khi chuẩn hoá.")
    if len(chunks) == 1:
        k = dict(kwargs)
        natural = _natural_duration_sec(model, chunks[0], clone_prompt)
        dur = _fit_duration_sec(target_sec, natural)
        if dur is not None:
            k["duration"] = dur
        return _synth_one_chunk(model, chunks[0], k), (natural or 0.0)

    gap = np.zeros(int(_INTER_SENTENCE_GAP * SAMPLE_RATE), dtype=np.float32)  # nghỉ ngắn giữa câu
    # Chia slot cho từng câu theo số ký tự (sau khi trừ các khoảng nghỉ ghép câu).
    per_chunk_target: list[float] | None = None
    if target_sec and target_sec > 0:
        speak = max(0.1, float(target_sec) - _INTER_SENTENCE_GAP * (len(chunks) - 1))
        weights = [max(1, len(c)) for c in chunks]
        wsum = sum(weights)
        per_chunk_target = [speak * w / wsum for w in weights]
    pieces: list = []
    naturals: list[float | None] = []
    for i, ch in enumerate(chunks):
        if i:
            pieces.append(gap)
        k = dict(kwargs)
        nat = _natural_duration_sec(model, ch, clone_prompt)
        naturals.append(nat)
        if per_chunk_target is not None:
            dur = _fit_duration_sec(per_chunk_target[i], nat)
            if dur is not None:
                k["duration"] = dur
        pieces.append(_synth_one_chunk(model, ch, k))
    # Natural length of the WHOLE utterance = per-sentence naturals + the joining
    # gaps. Unknown (0.0) if any sentence couldn't be estimated.
    natural_total = (
        sum(naturals) + _INTER_SENTENCE_GAP * (len(chunks) - 1)
        if all(n is not None for n in naturals)
        else 0.0
    )
    return np.concatenate(pieces), natural_total


def cmd_synth(spec: dict, model=None) -> None:
    import soundfile as sf
    import torch

    out_dir: str = spec["out_dir"]
    texts: list[str] = spec["texts"]
    instruct = spec.get("instruct") or None
    clone_prompt_path = spec.get("clone_prompt_path") or None
    speed = spec.get("speed") or None
    # Optional per-text target slot lengths (seconds). When present, OmniVoice is
    # asked to fit each utterance to its slot at synthesis time (`duration=`) — the
    # primary overflow defense. Absent/0 → natural length (caption TTS, previews).
    durations: list = spec.get("durations") or []
    # Optional target language (OmniVoice is 600+ lang) — callers may set
    # this for non-English narration. The editor's caption TTS omits it (auto).
    language = spec.get("language") or None
    progress = os.path.join(out_dir, "progress.json")
    cancel_flag = os.path.join(out_dir, "cancel")

    total = len(texts)
    if model is None:
        _write_json(progress, {"status": "loading", "done": 0, "total": total, "error": None})
        model = _load_model()

    clone_prompt = torch.load(clone_prompt_path, weights_only=False) if clone_prompt_path else None

    _write_json(progress, {"status": "running", "done": 0, "total": total, "error": None})
    # index → natural read length (seconds). Surfaced to the route (via natural.json)
    # so it can proactively LLM-shorten sentences the voice must RUSH to fit — not
    # only ones that still overflow after atempo. 0.0 = couldn't estimate.
    natural_map: dict[str, float] = {}
    # inference_mode: skip autograd bookkeeping → less VRAM + slightly faster.
    with torch.inference_mode():
        for i, text in enumerate(texts):
            # Cooperative cancel: the app drops a `cancel` file between polls so a
            # running job can stop WITHOUT killing the resident model.
            if os.path.exists(cancel_flag):
                _write_json(progress, {"status": "cancelled", "done": i, "total": total, "error": None})
                return
            kwargs: dict = {}
            if clone_prompt is not None:
                kwargs["voice_clone_prompt"] = clone_prompt
            elif instruct:
                kwargs["instruct"] = instruct
            if speed:
                kwargs["speed"] = speed
            if language:
                kwargs["language"] = language
            target_sec = durations[i] if i < len(durations) else None
            wav, natural_sec = _synthesize_best(model, text, kwargs, target_sec=target_sec)
            sf.write(os.path.join(out_dir, f"{i}.wav"), wav, SAMPLE_RATE)
            natural_map[str(i)] = round(float(natural_sec), 3)
            _write_json(progress, {"status": "running", "done": i + 1, "total": total, "error": None})

    # Natural durations land NEXT TO the wavs (index→seconds); separate from the
    # progress.json poll so the live-progress contract is untouched.
    _write_json(os.path.join(out_dir, "natural.json"), natural_map)
    _write_json(progress, {"status": "done", "done": total, "total": total, "error": None})


# Câu mẫu cố định để dựng file "nghe thử" ngay lúc tạo giọng (model đã nạp sẵn
# trong tiến trình này → rẻ). Sau này bấm nghe thử chỉ mở file, không synth lại.
PREVIEW_SAMPLE_TEXT = "Xin chào, đây là giọng đọc thử của tôi."


def cmd_create_voice(spec: dict, model=None) -> None:
    import torch

    ref_wav: str = spec["ref_wav"]
    ref_text = spec.get("ref_text") or None
    prompt_path: str = spec["prompt_path"]
    preview_path = spec.get("preview_path") or None
    result = os.path.join(os.path.dirname(prompt_path), "create_result.json")

    if model is None:
        _write_json(result, {"status": "loading", "error": None})
        model = _load_model()
    # ref_text is supplied ONLY when the user typed the exact sample transcript.
    # Otherwise transcribe with OmniVoice's OWN ASR (its transcript aligns with how
    # it tokenizes — an external recognizer like WhisperX mis-aligns → méo/lắp giọng).
    #
    # CRITICAL trên card 8GB: nếu để create_voice_clone_prompt(ref_text=None) TỰ gọi
    # ASR, thì ASR (whisper 1.6GB) còn nằm VRAM CÙNG LÚC với OmniVoice (2GB) ngay tại
    # bước audio-tokenizer encode → tổng + phân mảnh phình ~7GB → tràn 8GB → thrash
    # 10 phút. Nên TÁCH BƯỚC: phiên âm → NHẢ ASR → mới dựng prompt (chỉ còn OmniVoice).
    if not ref_text:
        import gc
        model.load_asr_model()
        ref_text = (model.transcribe(ref_wav) or "").strip() or None
        model._asr_pipe = None  # nhả tham chiếu whisper ASR
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()  # trả 1.6GB về trước khi dựng prompt
    prompt = model.create_voice_clone_prompt(ref_wav, ref_text=ref_text)
    torch.save(prompt, prompt_path)

    # Dựng sẵn file "nghe thử" bằng chính prompt vừa tạo (model còn nạp → rẻ). Lỗi
    # ở bước này KHÔNG được làm hỏng việc tạo giọng — preview là tiện ích phụ.
    if preview_path:
        try:
            import soundfile as sf
            with torch.inference_mode():
                wav, _ = _synthesize_best(model, PREVIEW_SAMPLE_TEXT, {"voice_clone_prompt": prompt})
            sf.write(preview_path, wav, SAMPLE_RATE)
        except Exception as e:  # noqa: BLE001 — preview phụ, không chặn tạo giọng
            print(f"preview synth failed (ignored): {e}", file=sys.stderr, flush=True)

    _write_json(result, {"status": "done", "error": None})


def _job_status_file(spec: dict) -> str | None:
    """Where a job reports completion — so a failure can be surfaced to the app."""
    if spec.get("out_dir"):
        return os.path.join(spec["out_dir"], "progress.json")
    if spec.get("prompt_path"):
        return os.path.join(os.path.dirname(spec["prompt_path"]), "create_result.json")
    return None


def cmd_serve() -> None:
    """Load the model once, then run jobs read line-by-line from stdin. Each job
    failure is written to its own status file; the server keeps running."""
    model = _load_model()
    # Readiness marker (stderr → the app's worker.log; stdout stays clean).
    print("OmniVoice worker ready", file=sys.stderr, flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        spec: dict = {}
        try:
            req = json.loads(line)
            cmd = req.get("cmd")
            with open(req["spec_path"], encoding="utf-8") as f:
                spec = json.load(f)
            if cmd == "synth":
                cmd_synth(spec, model=model)
            elif cmd == "create-voice":
                cmd_create_voice(spec, model=model)
            else:
                raise ValueError(f"Unknown command: {cmd}")
        except Exception as e:  # noqa: BLE001 — one bad job must not drop the model
            status_file = _job_status_file(spec)
            if status_file:
                try:
                    _write_json(status_file, {"status": "error", "error": str(e)[:1500]})
                except Exception:  # noqa: BLE001
                    pass
            print(f"job failed: {e}", file=sys.stderr, flush=True)


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "serve":
        cmd_serve()
        return 0

    spec_path = sys.argv[2] if len(sys.argv) > 2 else ""
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)
    try:
        if cmd == "synth":
            cmd_synth(spec)
        elif cmd == "create-voice":
            cmd_create_voice(spec)
        else:
            raise SystemExit(f"Unknown command: {cmd}")
    except Exception as e:  # noqa: BLE001
        # Surface the failure through whichever status file the app polls.
        out_dir = spec.get("out_dir") or os.path.dirname(spec.get("prompt_path", ""))
        for name in ("progress.json", "create_result.json"):
            try:
                _write_json(os.path.join(out_dir, name), {"status": "error", "error": str(e)[:1500]})
            except Exception:  # noqa: BLE001
                pass
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

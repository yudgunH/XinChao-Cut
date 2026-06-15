"""Generate an ASS subtitle file from the timeline's text clips.

ASS gives fast native burning with styling that's *close* to the canvas captions
(font, size, colour, outline, opaque box, position, fade). Per-word reveal
animation is approximated as a static line + fade — a deliberate fidelity
trade-off for speed.
"""
from __future__ import annotations

import re
import unicodedata

MIN_REPEAT_TOKENS = 3
REPEAT_GRACE_SEC = 0.6
REPEAT_WINDOW_SEC = 8.0
_WORD_EDGE_RE = re.compile(r"^\W+|\W+$", re.UNICODE)


def _ass_color(hex_color: str, alpha: int = 0) -> str:
    """#RRGGBB -> &HAABBGGRR (ASS is BGR + alpha; alpha 00 = opaque)."""
    h = (hex_color or "#ffffff").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        h = "ffffff"
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def _ts(sec: float) -> str:
    sec = max(0.0, sec)
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    cs = int(round((sec - int(sec)) * 100))
    if cs == 100:
        cs = 99
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def _escape_text(text: str) -> str:
    return (text or "").replace("\\", "\\\\").replace("\n", "\\N").replace("{", "(").replace("}", ")")


# Map app font-family stacks to a usable font name for libass.
def _font_name(family: str) -> str:
    first = (family or "Inter").split(",")[0].strip().strip('"').strip("'")
    return first or "Inter"


def _normalize_token(text: str) -> str:
    return _WORD_EDGE_RE.sub("", unicodedata.normalize("NFKC", text).lower())


def _tokens(text: str) -> list[str]:
    return [t for t in (_normalize_token(raw) for raw in (text or "").split()) if t]


def _norm_text(text: str) -> str:
    return " ".join(_tokens(text))


def _clip_text(clip: dict) -> str:
    return str((clip.get("textData") or {}).get("content") or "")


def _clip_range(clip: dict) -> tuple[float, float]:
    start = float(clip.get("startSec", 0) or 0)
    end = start + float(clip.get("durationSec", 0) or 0)
    return start, end


def _overlaps_or_touches(a: dict, b: dict) -> bool:
    a_start, a_end = _clip_range(a)
    b_start, b_end = _clip_range(b)
    return a_start <= b_end + REPEAT_GRACE_SEC and b_start <= a_end + REPEAT_GRACE_SEC


def _overlap_ratio(a: dict, b: dict) -> float:
    a_start, a_end = _clip_range(a)
    b_start, b_end = _clip_range(b)
    overlap = min(a_end, b_end) - max(a_start, b_start)
    if overlap <= 0:
        return 0.0
    shorter = min(a_end - a_start, b_end - b_start)
    return overlap / shorter if shorter > 0 else 0.0


def _matching_prefix_len(tokens: list[str], previous: list[str], previous_index: int) -> int:
    length = 0
    while (
        length < len(tokens)
        and previous_index + length < len(previous)
        and tokens[length] == previous[previous_index + length]
    ):
        length += 1
    return length


def _repeated_prefix_len(clip: dict, tokens: list[str], accepted: list[dict]) -> int:
    start, _ = _clip_range(clip)
    best = 0
    for prev in reversed(accepted):
        _, prev_end = _clip_range(prev)
        if start - prev_end > REPEAT_WINDOW_SEC:
            break
        if not _overlaps_or_touches(prev, clip):
            continue
        prev_tokens = _tokens(_clip_text(prev))
        for i in range(len(prev_tokens)):
            length = _matching_prefix_len(tokens, prev_tokens, i)
            if length >= MIN_REPEAT_TOKENS:
                best = max(best, length)
    return best


def _is_duplicate(clip: dict, tokens: list[str], accepted: dict) -> bool:
    if not _overlaps_or_touches(clip, accepted):
        return False
    text = " ".join(tokens)
    accepted_text = _norm_text(_clip_text(accepted))
    if not text or not accepted_text:
        return False
    if text == accepted_text:
        return True
    return (
        len(tokens) <= len(_tokens(_clip_text(accepted)))
        and text in accepted_text
        and _overlap_ratio(clip, accepted) >= 0.45
    )


def _dedupe_text_clips(text_clips: list[dict]) -> list[dict]:
    accepted: list[tuple[int, dict]] = []
    ordered = sorted(
        enumerate(text_clips),
        key=lambda item: (_clip_range(item[1])[0], -_clip_range(item[1])[1], item[0]),
    )

    for original_index, original in ordered:
        content = _clip_text(original).strip()
        if not content:
            continue

        clip = original
        tokens = _tokens(content)
        repeated = _repeated_prefix_len(clip, tokens, [item[1] for item in accepted])
        if repeated >= MIN_REPEAT_TOKENS:
            kept = content.split()[repeated:]
            if not kept:
                continue
            text_data = dict(clip.get("textData") or {})
            text_data["content"] = " ".join(kept)
            clip = {**clip, "textData": text_data}
            tokens = _tokens(text_data["content"])

        if any(_is_duplicate(clip, tokens, accepted_clip) for _, accepted_clip in accepted):
            continue
        accepted.append((original_index, clip))

    return [clip for _, clip in sorted(accepted, key=lambda item: item[0])]


def build_ass(width: int, height: int, text_clips: list[dict]) -> str:
    """text_clips: [{ startSec, durationSec, textData }]"""
    header = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, "
        "ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, "
        "MarginL, MarginR, MarginV, Encoding",
    ]

    events = ["", "[Events]",
              "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]

    styles: list[str] = []
    # Auto-captions produce hundreds of cues that almost all share the same
    # look. Emitting a distinct Style per cue (S0..Sn) made libass allocate a
    # font/render context per style — on Windows (directwrite/GDI) that balloons
    # memory and can OOM the filtergraph on a long video. Share one style per
    # *distinct* appearance instead: 400 cues collapse to a handful of styles.
    style_name_by_body: dict[str, str] = {}
    dialogues: list[str] = []
    margin = int(width * 0.04)

    for clip in _dedupe_text_clips(text_clips):
        td = clip.get("textData") or {}
        start = float(clip.get("startSec", 0))
        end = start + float(clip.get("durationSec", 0))
        if end <= start:
            continue

        font = _font_name(td.get("fontFamily", "Inter"))
        # fontSize is px @1080p -> scale to the export height.
        fontsize = max(8, round(float(td.get("fontSize", 48)) / 1080.0 * height))
        primary = _ass_color(td.get("color", "#ffffff"))
        bold = -1 if td.get("fontWeight") == "bold" else 0

        stroke = td.get("stroke") or {}
        outline_w = float(stroke.get("width", 0) or 0) / 1080.0 * height
        outline_col = _ass_color(stroke.get("color", "#000000")) if outline_w > 0 else _ass_color("#000000")

        has_box = bool(td.get("hasBackground"))
        if has_box:
            border_style = 3  # opaque box
            back_col = _ass_color(td.get("backgroundColor", "#000000"))
            outline = max(outline_w, 4.0)
        else:
            border_style = 1  # outline + shadow
            back_col = _ass_color("#000000", alpha=0x60)
            outline = outline_w if outline_w > 0 else 2.0

        body = (
            f"{font},{fontsize},{primary},{primary},"
            f"{outline_col},{back_col},{bold},0,0,0,100,100,0,0,{border_style},"
            f"{outline:.1f},2,5,{margin},{margin},0,1"
        )
        style_name = style_name_by_body.get(body)
        if style_name is None:
            style_name = f"S{len(style_name_by_body)}"
            style_name_by_body[body] = style_name
            styles.append(f"Style: {style_name},{body}")

        # \an5 = centre anchor, position at the clip's relative x/y.
        px = round(float(td.get("x", 0.5)) * width)
        py = round(float(td.get("y", 0.86)) * height)
        # Short fade in/out for a softer pop (approximates the reveal animation).
        fade = "\\fad(120,120)"
        override = f"{{\\an5\\pos({px},{py}){fade}}}"
        text = override + _escape_text(td.get("content", ""))
        dialogues.append(
            f"Dialogue: 0,{_ts(start)},{_ts(end)},{style_name},,0,0,0,,{text}"
        )

    return "\n".join(header + styles + events + dialogues) + "\n"

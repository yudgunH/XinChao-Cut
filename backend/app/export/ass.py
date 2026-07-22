"""Generate an ASS subtitle file from the timeline's text clips.

ASS gives fast native burning with styling that's *close* to the canvas captions
(font, size, colour, outline, opaque box, position, fade). Word/group reveal
captions (TikTok-style "N words at a time") are expanded into one timed event per
group so the burn matches the preview's reveal instead of showing the whole line.
"""
from __future__ import annotations

import math
import unicodedata


def _caption_tokens(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    tokens = text.split()
    if len(tokens) == 1 and any(
        "CJK" in unicodedata.name(char, "")
        or "HIRAGANA" in unicodedata.name(char, "")
        or "KATAKANA" in unicodedata.name(char, "")
        or "HANGUL" in unicodedata.name(char, "")
        for char in text
    ):
        return [char for char in text if not char.isspace()]
    return tokens


def _comparable_token(token: str) -> str:
    return "".join(
        char.casefold()
        for char in unicodedata.normalize("NFKC", token)
        if char.isalnum()
    )


def _normalized_word_timestamps(td: dict, clip_dur: float) -> list[dict]:
    """Defensive equivalent of the frontend caption-timing repair.

    Export specs normally arrive normalized, but old projects and direct API
    clients can still contain one sentence-sized timestamp. Expanding it here
    prevents Server export from regressing independently of Browser preview.
    """
    raw = td.get("wordTimestamps") or []
    if not raw:
        return []
    expanded: list[dict] = []
    duration = max(0.0, float(clip_dur))
    for entry in raw:
        tokens = _caption_tokens(str(entry.get("word", "") or ""))
        try:
            start = max(0.0, min(duration, float(entry.get("startSec", 0) or 0)))
            end = max(start, min(duration, float(entry.get("endSec", start) or start)))
        except (TypeError, ValueError, OverflowError):
            continue
        if not tokens or end <= start:
            continue
        span = end - start
        for index, token in enumerate(tokens):
            expanded.append(
                {
                    "word": token,
                    "startSec": start + index / len(tokens) * span,
                    "endSec": start + (index + 1) / len(tokens) * span,
                }
            )

    content_tokens = _caption_tokens(str(td.get("content", "") or ""))
    if not content_tokens:
        return []
    if len(content_tokens) == len(expanded) and all(
        _comparable_token(left) == _comparable_token(right.get("word", ""))
        for left, right in zip(content_tokens, expanded)
    ):
        return [
            {**timing, "word": content_tokens[index]}
            for index, timing in enumerate(expanded)
        ]

    start = expanded[0]["startSec"] if expanded else 0.0
    end = expanded[-1]["endSec"] if expanded else duration
    span = max(0.001, end - start)
    return [
        {
            "word": token,
            "startSec": start + index / len(content_tokens) * span,
            "endSec": start + (index + 1) / len(content_tokens) * span,
        }
        for index, token in enumerate(content_tokens)
    ]


def _reveal_segments(
    td: dict, clip_start: float, clip_dur: float
) -> list[tuple[float, float, str]] | None:
    """Expand a reveal caption into (start, end, text) groups, mirroring the
    preview's getCurrentRevealUnit. Returns None for non-reveal captions (caller
    burns the whole line) and [] when there's nothing to show.

    Only the active group is on screen at a time. Timestamp-based when the clip
    carries per-word timings (accurate speech sync), else an even split across
    the clip duration. Times are absolute timeline seconds.
    """
    anim = td.get("anim") or {}
    kind = anim.get("kind")
    if kind not in ("word", "group"):
        return None
    unit = max(1, int(anim.get("groupSize", 1))) if kind == "group" else 1

    ts = _normalized_word_timestamps(td, clip_dur)
    out: list[tuple[float, float, str]] = []
    if ts:
        n = len(ts)
        for i in range(0, n, unit):
            grp = ts[i:i + unit]
            text = " ".join(str(w.get("word", "")) for w in grp).strip()
            # Respect leading silence: the first group begins at the first real
            # word timestamp, matching the canvas preview and karaoke path.
            start_rel = max(0.0, float(grp[0].get("startSec", 0) or 0))
            # The group stays until the next group begins (last one to clip end).
            end_rel = float(ts[i + unit].get("startSec", 0) or 0) if i + unit < n else clip_dur
            end_rel = min(clip_dur, max(start_rel, end_rel))
            if text and end_rel > start_rel:
                out.append((clip_start + start_rel, clip_start + end_rel, text))
        return out

    words = [w for w in str(td.get("content") or "").split() if w]
    if not words:
        return []
    total_units = max(1, math.ceil(len(words) / unit))
    for u in range(total_units):
        text = " ".join(words[u * unit:(u + 1) * unit])
        start_rel = (u / total_units) * clip_dur
        end_rel = ((u + 1) / total_units) * clip_dur
        if text:
            out.append((clip_start + start_rel, clip_start + end_rel, text))
    return out


def _ass_color(hex_color: str, alpha: int = 0) -> str:
    """#RRGGBB -> &HAABBGGRR (ASS is BGR + alpha; alpha 00 = opaque)."""
    h = (hex_color or "#ffffff").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        h = "ffffff"
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def _ass_inline_color(hex_color: str) -> str:
    """#RRGGBB -> &HBBGGRR& for an inline \\c override tag (no alpha byte)."""
    h = (hex_color or "#ffffff").lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        h = "ffffff"
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{b}{g}{r}&".upper()


def _karaoke_events(td: dict, clip_dur: float) -> list[tuple[float, float, int, int, int]] | None:
    """For anim.kind == 'karaoke': (start_rel, end_rel, visible start/end, active).

    groupSize lets templates show a CapCut-like N-word window while the active
    word inside that window is recoloured.
    Returns None for non-karaoke captions.
    """
    anim = td.get("anim") or {}
    if anim.get("kind") != "karaoke":
        return None

    unit = max(1, int(anim.get("groupSize", 1) or 1))
    ts = _normalized_word_timestamps(td, clip_dur)
    if ts:
        n = len(ts)
        out: list[tuple[float, float, int, int, int]] = []
        previous_end = 0.0
        for i in range(n):
            start = max(0.0, float(ts[i].get("startSec", 0) or 0))
            end = float(ts[i].get("endSec", start) or start)
            end = min(clip_dur, max(start, end))
            visible_start = (i // unit) * unit if unit > 1 else 0
            visible_end = min(n, visible_start + unit) if unit > 1 else n
            # Keep the base caption/window visible through a real pause, but do
            # not mark any word active. Browser uses the same state.
            if i > 0 and start > previous_end:
                previous_visible_start = ((i - 1) // unit) * unit if unit > 1 else 0
                previous_visible_end = min(n, previous_visible_start + unit) if unit > 1 else n
                out.append(
                    (previous_end, start, previous_visible_start, previous_visible_end, -1)
                )
            if end > start:
                out.append((start, end, visible_start, visible_end, i))
            previous_end = max(previous_end, end)
        if previous_end < clip_dur:
            last_visible_start = ((n - 1) // unit) * unit if unit > 1 else 0
            last_visible_end = min(n, last_visible_start + unit) if unit > 1 else n
            out.append((previous_end, clip_dur, last_visible_start, last_visible_end, -1))
        return out

    words = [w for w in str(td.get("content") or "").split() if w]
    n = len(words)
    if n == 0:
        return []
    return [
        (
            i / n * clip_dur,
            min(clip_dur, (i + 1) / n * clip_dur),
            (i // unit) * unit if unit > 1 else 0,
            min(n, (i // unit) * unit + unit) if unit > 1 else n,
            i,
        )
        for i in range(n)
    ]


def _karaoke_markup(
    words: list[str],
    visible_start: int,
    visible_end: int,
    active_idx: int,
    highlight_hex: str,
    base_hex: str,
    separator: str = " ",
) -> str:
    """Visible word group with the active word wrapped in an inline colour override —
    same effect as the canvas re-drawing one word in a different colour."""
    highlight = _ass_inline_color(highlight_hex)
    base = _ass_inline_color(base_hex)
    parts = []
    for i in range(max(0, visible_start), min(len(words), visible_end)):
        w = words[i]
        esc = _escape_text(w)
        if i == active_idx:
            parts.append(f"{{\\c{highlight}}}{esc}{{\\c{base}}}")
        else:
            parts.append(esc)
    return separator.join(parts)


def _word_separator(td: dict, height: int) -> str:
    """Approximate Canvas wordSpacing with regular + Unicode thin spaces.

    ASS only exposes character spacing. Adding thin separators keeps letters
    untouched while giving outlined karaoke words the same breathing room as
    the editor. The field is px at the 1080 reference resolution.
    """
    try:
        spacing_px = max(0.0, float(td.get("wordSpacing", 0) or 0) / 1080.0 * height)
        em_px = max(1.0, float(td.get("fontSize", 48) or 48) / 1080.0 * height)
    except (TypeError, ValueError, OverflowError):
        return " "
    thin_space_count = max(0, min(3, round(spacing_px / (em_px * 0.2))))
    return " " + "\u2009" * thin_space_count


def _escape_caption_text(text: str, separator: str) -> str:
    return separator.join(_escape_text(text).split(" "))


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


def build_ass(
    width: int, height: int, text_clips: list[dict], font_map: dict | None = None
) -> str:
    """text_clips: [{ startSec, durationSec, textData }].

    font_map (from the spec's captionFonts): css family → {assFamily, sizeScale}.
    - assFamily: the font's REAL internal family name — what libass matches;
      the CSS alias in the app's catalog often differs and silently falls back.
    - sizeScale: (usWinAscent+usWinDescent)/unitsPerEm. libass (VSFilter compat)
      scales a face so its win-cell height equals Fontsize, while canvas px are
      em units — multiplying Fontsize by this ratio makes the burned text the
      same visual size as the preview.
    """
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

    # Render every timeline caption 1:1, exactly like the canvas preview/export.
    # Captions are already deduped when inserted on the timeline, so a second
    # server-side dedup here would only make the burn diverge from the preview.
    for clip in sorted(text_clips, key=lambda c: float(c.get("startSec", 0) or 0)):
        td = clip.get("textData") or {}
        start = float(clip.get("startSec", 0))
        end = start + float(clip.get("durationSec", 0))
        if end <= start:
            continue
        if not str(td.get("content") or "").strip():
            continue

        css_font = _font_name(td.get("fontFamily", "Inter"))
        meta = (font_map or {}).get(css_font) or {}
        font = str(meta.get("assFamily") or "") or css_font
        size_scale = float(meta.get("sizeScale") or 1.0)
        # fontSize is px @1080p -> scale to the export height, then compensate
        # libass's cell-height sizing so the em size matches the canvas.
        fontsize = max(8, round(float(td.get("fontSize", 48)) / 1080.0 * height * size_scale))
        primary = _ass_color(td.get("color", "#ffffff"))
        bold = -1 if td.get("fontWeight") == "bold" else 0

        stroke = td.get("stroke") or {}
        outline_w = float(stroke.get("width", 0) or 0) / 1080.0 * height
        outline_col = _ass_color(stroke.get("color", "#000000")) if outline_w > 0 else _ass_color("#000000")

        has_box = bool(td.get("hasBackground"))
        if has_box:
            # Opaque box. libass paints the BorderStyle=3 box with the OUTLINE
            # colour (BackColour is only the box's shadow) — verified against
            # ffmpeg/libass by burning distinct colours. Putting backgroundColor
            # into BackColour rendered every coloured box template BLACK. The
            # glyph stroke can't coexist with the box in one event, so the box
            # colour wins (matches the canvas, which draws box then text).
            border_style = 3
            box_col = _ass_color(td.get("backgroundColor", "#000000"))
            outline_col = box_col
            back_col = box_col
            outline = max(outline_w, 4.0)  # box padding
            shadow = 0.0
        else:
            border_style = 1
            back_col = _ass_color("#000000", alpha=0x60)
            # Mirror the canvas: stroked text gets NO shadow (clean outline only);
            # unstroked text gets no outline, just the soft drop shadow. The old
            # unconditional Outline=2/Shadow=2 put a visible border+shadow on
            # captions the preview rendered without either.
            if outline_w > 0:
                outline = outline_w
                shadow = 0.0
            else:
                outline = 0.0
                shadow = 2.0

        spacing = float(td.get("letterSpacing", 0) or 0) / 1080.0 * height
        word_separator = _word_separator(td, height)

        body = (
            f"{font},{fontsize},{primary},{primary},"
            f"{outline_col},{back_col},{bold},0,0,0,100,100,{spacing:.1f},0,{border_style},"
            f"{outline:.1f},{shadow:.1f},5,{margin},{margin},0,1"
        )
        style_name = style_name_by_body.get(body)
        if style_name is None:
            style_name = f"S{len(style_name_by_body)}"
            style_name_by_body[body] = style_name
            styles.append(f"Style: {style_name},{body}")

        # \an5 = centre anchor, position at the clip's relative x/y.
        px = round(float(td.get("x", 0.5)) * width)
        py = round(float(td.get("y", 0.86)) * height)
        # Fade: honour the clip's fade-in/out effects (else a soft 120ms pop that
        # approximates the reveal animation). Durations clamp to half the clip.
        clip_dur = float(clip.get("durationSec", 0) or 0)
        animation_offset = max(0.0, float(clip.get("_animationOffsetSec", 0) or 0))
        animation_duration = max(
            clip_dur,
            float(clip.get("_animationDurationSec", clip_dur) or clip_dur),
        )
        # A continued chunk must not replay the caption's entrance animation;
        # likewise an intermediate chunk must not fade it out at its artificial
        # boundary. The exact original beginning/end chunks still keep fades.
        fade_in_ms = 120 if animation_offset <= 1e-6 else 0
        reaches_original_end = animation_offset + clip_dur >= animation_duration - 1e-6
        fade_out_ms = 120 if reaches_original_end else 0
        for eff in clip.get("effects") or []:
            d = float((eff.get("params") or {}).get("duration", 0.6) or 0.6)
            d = max(0.0, min(d, animation_duration / 2)) if animation_duration > 0 else d
            if eff.get("type") == "fade-in":
                fade_in_ms = int(round(d * 1000)) if animation_offset <= 1e-6 else 0
            elif eff.get("type") == "fade-out":
                fade_out_ms = int(round(d * 1000)) if reaches_original_end else 0
        # Static clip opacity → \alpha (ASS alpha: 00 opaque … FF transparent).
        opacity = max(0.0, min(1.0, float(clip.get("opacity", 1) or 1)))
        alpha = f"\\alpha&H{round((1 - opacity) * 255):02X}&" if opacity < 0.999 else ""

        # Reveal/karaoke captions burn one Dialogue event per active word/group.
        # \fad is relative to EACH event's own Start/End — applying the same
        # ~120ms in/out fade to every one of those short (~200-400ms at normal
        # speech pace) events ate 60-95% of every word's visible window,
        # fading the caption toward black and back on every word transition
        # (confirmed by sampling burned-frame brightness: it cycled 0→full→0 in
        # lockstep with each word). Only the FIRST event of the sequence should
        # fade in and only the LAST should fade out; interior transitions cut
        # instantly, matching the canvas preview's instant colour/box swap.
        def override_for(is_first: bool, is_last: bool) -> str:
            fin = fade_in_ms if is_first else 0
            fout = fade_out_ms if is_last else 0
            return f"{{\\an5\\pos({px},{py}){alpha}\\fad({fin},{fout})}}"

        # Reveal captions: one event per word-group (only the active group shows),
        # matching the preview. Karaoke: full line always on, active word wrapped
        # in a colour override. Plain captions: a single event with the full line.
        segments = _reveal_segments(td, start, end - start)
        if segments is None:
            karaoke = _karaoke_events(td, end - start)
            if karaoke is not None:
                words = [str(w.get("word", "")) for w in _normalized_word_timestamps(td, end - start)] or \
                    [w for w in str(td.get("content") or "").split() if w]
                highlight_hex = td.get("highlightColor", "#ffd400")
                base_hex = td.get("color", "#ffffff")
                valid_karaoke = [(s, e, a, b, i) for s, e, a, b, i in karaoke if e > s]
                last_idx = len(valid_karaoke) - 1
                for pos, (seg_start, seg_end, visible_start, visible_end, active_idx) in enumerate(valid_karaoke):
                    dialogues.append(
                        f"Dialogue: 0,{_ts(start + seg_start)},{_ts(start + seg_end)},{style_name},,0,0,0,,"
                        f"{override_for(pos == 0, pos == last_idx)}"
                        f"{_karaoke_markup(words, visible_start, visible_end, active_idx, highlight_hex, base_hex, word_separator)}"
                    )
                continue
            # Plain caption. When the frontend pre-wrapped it with the browser's
            # own metrics, burn those exact lines — ONE Dialogue event PER LINE,
            # each \pos-ed at the canvas line grid (1.25 × em, centred block).
            # A single \N event would let libass space the lines by the font's
            # own metrics, which (esp. for tall-cell fonts like Oswald/Bangers)
            # is up to ~35% wider than the canvas's fixed 1.25em line height.
            # \q2 disables libass's own re-wrapping of each line.
            wrapped = td.get("wrappedLines")
            if isinstance(wrapped, list):
                lines_txt = [str(line) for line in wrapped if str(line).strip()]
                if lines_txt:
                    em_px = round(float(td.get("fontSize", 48)) / 1080.0 * height)
                    line_h = 1.25 * em_px  # canvas LINE_HEIGHT_RATIO
                    n = len(lines_txt)
                    for i, line in enumerate(lines_txt):
                        ly = round(py + (i - (n - 1) / 2) * line_h)
                        dialogues.append(
                            f"Dialogue: 0,{_ts(start)},{_ts(end)},{style_name},,0,0,0,,"
                            f"{{\\an5\\pos({px},{ly}){alpha}\\fad({fade_in_ms},{fade_out_ms})\\q2}}"
                            f"{_escape_caption_text(line, word_separator)}"
                        )
                    continue
            segments = [(start, end, str(td.get("content", "")))]
        valid_segments = [(s, e, t) for s, e, t in segments if e > s and t.strip()]
        last_seg_idx = len(valid_segments) - 1
        for pos, (seg_start, seg_end, seg_text) in enumerate(valid_segments):
            dialogues.append(
                f"Dialogue: 0,{_ts(seg_start)},{_ts(seg_end)},{style_name},,0,0,0,,"
                f"{override_for(pos == 0, pos == last_seg_idx)}{_escape_caption_text(seg_text, word_separator)}"
            )

    return "\n".join(header + styles + events + dialogues) + "\n"

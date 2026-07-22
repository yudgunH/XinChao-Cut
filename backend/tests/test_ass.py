"""Tests for ASS caption generation — focus on style sharing (the per-cue style
explosion that OOM'd libass on long captioned exports)."""
from __future__ import annotations

import re

from app.export.ass import build_ass


def _cue(i: float, **td):
    base = {"content": f"line {int(i)}", "fontSize": 54, "color": "#ffffff"}
    base.update(td)
    return {"startSec": i, "durationSec": 1.0, "textData": base}


def _count(ass: str, prefix: str) -> int:
    return sum(1 for line in ass.splitlines() if line.startswith(prefix))


def test_identical_cues_share_one_style():
    # 200 cues that look the same → ONE style, but all 200 events kept.
    cues = [_cue(i * 1.5) for i in range(200)]
    ass = build_ass(1920, 1080, cues)
    assert _count(ass, "Style:") == 1
    assert _count(ass, "Dialogue:") == 200


def test_distinct_looks_get_distinct_styles():
    cues = [
        _cue(0, color="#ffffff"),
        _cue(2, color="#ff0000"),               # different colour
        _cue(4, hasBackground=True),            # opaque box
        _cue(6, color="#ffffff"),               # same as the first → shared
    ]
    ass = build_ass(1920, 1080, cues)
    assert _count(ass, "Style:") == 3
    assert _count(ass, "Dialogue:") == 4


def _dialogue_texts(ass: str) -> list[str]:
    out = []
    for line in ass.splitlines():
        if line.startswith("Dialogue:"):
            out.append(line.split(",,", 1)[1])  # everything after the empty Name field
    return out


def test_group_reveal_expands_to_one_event_per_group():
    # 6 words, group of 3 → 2 events showing 3 words each, timed by timestamps.
    words = [{"word": w, "startSec": i, "endSec": i + 1} for i, w in enumerate(
        ["a", "b", "c", "d", "e", "f"])]
    cue = {
        "startSec": 10.0, "durationSec": 6.0,
        "textData": {"content": "a b c d e f", "fontSize": 54, "color": "#fff",
                     "anim": {"kind": "group", "groupSize": 3}, "wordTimestamps": words},
    }
    ass = build_ass(1080, 1920, [cue])
    texts = _dialogue_texts(ass)
    assert _count(ass, "Dialogue:") == 2
    assert any(t.endswith("a b c") for t in texts)
    assert any(t.endswith("d e f") for t in texts)
    # Second group starts at clip_start + ts[3].startSec = 10 + 3 = 13s.
    assert any("0:00:13.00" in line for line in ass.splitlines() if line.startswith("Dialogue:"))


def test_reveal_only_fades_first_and_last_event():
    # 6 words, group of 3 → 2 events. Only the first should fade IN and only
    # the last should fade OUT — interior word/group transitions must cut
    # instantly (no \fad), or the caption flickers to black on every swap.
    words = [{"word": w, "startSec": i, "endSec": i + 1} for i, w in enumerate(
        ["a", "b", "c", "d", "e", "f"])]
    cue = {
        "startSec": 10.0, "durationSec": 6.0,
        "textData": {"content": "a b c d e f", "fontSize": 54, "color": "#fff",
                     "anim": {"kind": "group", "groupSize": 3}, "wordTimestamps": words},
    }
    ass = build_ass(1080, 1920, [cue])
    dialogue_lines = [line for line in ass.splitlines() if line.startswith("Dialogue:")]
    assert len(dialogue_lines) == 2
    assert "\\fad(120,0)" in dialogue_lines[0]   # first event: fade in only
    assert "\\fad(0,120)" in dialogue_lines[1]   # last event: fade out only


def test_karaoke_only_fades_first_and_last_event():
    words = [{"word": w, "startSec": float(i), "endSec": float(i) + 1} for i, w in enumerate(
        ["a", "b", "c"])]
    cue = {
        "startSec": 0.0, "durationSec": 3.0,
        "textData": {"content": "a b c", "fontSize": 54, "color": "#fff",
                     "anim": {"kind": "karaoke"}, "highlightColor": "#ffd400",
                     "wordTimestamps": words},
    }
    ass = build_ass(1080, 1920, [cue])
    dialogue_lines = [line for line in ass.splitlines() if line.startswith("Dialogue:")]
    assert len(dialogue_lines) == 3
    assert "\\fad(120,0)" in dialogue_lines[0]
    assert "\\fad(0,0)" in dialogue_lines[1]      # interior word: no fade at all
    assert "\\fad(0,120)" in dialogue_lines[2]


def test_static_opacity_sets_alpha_override():
    cue = {"startSec": 0, "durationSec": 2, "opacity": 0.5,
           "textData": {"content": "hi", "fontSize": 54, "color": "#fff"}}
    ass = build_ass(1280, 720, [cue])
    assert "\\alpha&H80&" in ass            # 0.5 opacity → 0x80 alpha
    full = build_ass(1280, 720, [{**cue, "opacity": 1}])
    assert "\\alpha" not in full            # opaque → no alpha override


def test_fade_effects_drive_fad_durations():
    cue = {"startSec": 0, "durationSec": 4, "opacity": 1,
           "effects": [{"type": "fade-in", "params": {"duration": 0.5}},
                       {"type": "fade-out", "params": {"duration": 1.0}}],
           "textData": {"content": "hi", "fontSize": 54, "color": "#fff"}}
    ass = build_ass(1280, 720, [cue])
    assert "\\fad(500,1000)" in ass         # fade-in 0.5s, fade-out 1.0s


def test_plain_caption_stays_single_event():
    cue = {"startSec": 0.0, "durationSec": 2.0,
           "textData": {"content": "hello world", "fontSize": 54, "color": "#fff"}}
    ass = build_ass(1280, 720, [cue])
    assert _count(ass, "Dialogue:") == 1
    assert _dialogue_texts(ass)[0].endswith("hello world")


def test_word_reveal_without_timestamps_splits_evenly():
    cue = {"startSec": 0.0, "durationSec": 4.0,
           "textData": {"content": "one two three four", "fontSize": 54, "color": "#fff",
                        "anim": {"kind": "word", "groupSize": 1}}}
    ass = build_ass(1280, 720, [cue])
    assert _count(ass, "Dialogue:") == 4   # one event per word, even split


def test_karaoke_wraps_active_word_in_colour_override():
    words = [{"word": w, "startSec": float(i), "endSec": float(i + 1)} for i, w in enumerate(["a", "b", "c"])]
    cue = {
        "startSec": 5.0, "durationSec": 3.0,
        "textData": {"content": "a b c", "fontSize": 54, "color": "#ffffff",
                     "anim": {"kind": "karaoke"}, "highlightColor": "#ffd400",
                     "wordTimestamps": words},
    }
    ass = build_ass(1080, 1920, [cue])
    texts = _dialogue_texts(ass)
    assert _count(ass, "Dialogue:") == 3
    assert any("{\\c&H00D4FF&}a{\\c&HFFFFFF&} b c" in t for t in texts)
    assert any("a {\\c&H00D4FF&}b{\\c&HFFFFFF&} c" in t for t in texts)
    assert any("a b {\\c&H00D4FF&}c{\\c&HFFFFFF&}" in t for t in texts)
    # word 0's window starts at the clip start (5.0s), not its own startSec (0).
    assert any("0:00:05.00" in line for line in ass.splitlines() if line.startswith("Dialogue:"))


def test_karaoke_without_timestamps_splits_evenly():
    cue = {"startSec": 0.0, "durationSec": 3.0,
           "textData": {"content": "one two three", "fontSize": 54, "color": "#fff",
                        "anim": {"kind": "karaoke"}, "highlightColor": "#ffd400"}}
    ass = build_ass(1280, 720, [cue])
    assert _count(ass, "Dialogue:") == 3


def test_karaoke_group_size_shows_three_word_window():
    words = [
        {"word": w, "startSec": float(i), "endSec": float(i + 1)}
        for i, w in enumerate(["down", "i", "go", "and", "i", "go"])
    ]
    cue = {
        "startSec": 0.0, "durationSec": 6.0,
        "textData": {"content": "down i go and i go", "fontSize": 54, "color": "#ffffff",
                     "anim": {"kind": "karaoke", "groupSize": 3}, "highlightColor": "#ffd400",
                     "wordTimestamps": words},
    }
    texts = _dialogue_texts(build_ass(1080, 1920, [cue]))
    assert any("{\\c&H00D4FF&}down{\\c&HFFFFFF&} i go" in t for t in texts)
    assert any("down {\\c&H00D4FF&}i{\\c&HFFFFFF&} go" in t for t in texts)
    assert any("and {\\c&H00D4FF&}i{\\c&HFFFFFF&} go" in t for t in texts)
    assert not any("down i go and" in t for t in texts)


def test_reveal_first_group_waits_for_first_word():
    # Speech starts 2s into the clip — leading silence remains clear in both
    # the server burn and canvas preview.
    words = [{"word": w, "startSec": 2.0 + i, "endSec": 3.0 + i} for i, w in enumerate(["a", "b"])]
    cue = {"startSec": 10.0, "durationSec": 6.0,
           "textData": {"content": "a b", "fontSize": 54, "color": "#fff",
                        "anim": {"kind": "word", "groupSize": 1}, "wordTimestamps": words}}
    ass = build_ass(1080, 1920, [cue])
    dialogue_lines = [line for line in ass.splitlines() if line.startswith("Dialogue:")]
    assert dialogue_lines[0].split(",")[1] == "0:00:12.00"


def test_karaoke_first_word_waits_for_its_timestamp():
    words = [
        {"word": "hello", "startSec": 1.5, "endSec": 2.0},
        {"word": "world", "startSec": 2.0, "endSec": 2.5},
    ]
    cue = {
        "startSec": 5.0, "durationSec": 3.0,
        "textData": {"content": "hello world", "fontSize": 54, "color": "#ffffff",
                     "anim": {"kind": "karaoke"}, "highlightColor": "#ffd400",
                     "wordTimestamps": words},
    }
    dialogue_lines = [
        line for line in build_ass(1080, 1920, [cue]).splitlines()
        if line.startswith("Dialogue:")
    ]
    assert dialogue_lines[0].split(",")[1] == "0:00:06.50"


def test_karaoke_pause_keeps_base_text_but_stops_highlight():
    words = [
        {"word": "hello", "startSec": 0.0, "endSec": 0.5},
        {"word": "world", "startSec": 1.5, "endSec": 2.0},
    ]
    cue = {
        "startSec": 0.0, "durationSec": 2.0,
        "textData": {"content": "hello world", "fontSize": 54, "color": "#ffffff",
                     "anim": {"kind": "karaoke"}, "highlightColor": "#ffd400",
                     "wordTimestamps": words},
    }
    dialogues = [
        line for line in build_ass(1080, 1920, [cue]).splitlines()
        if line.startswith("Dialogue:")
    ]
    assert len(dialogues) == 3
    pause = dialogues[1]
    assert pause.split(",")[1:3] == ["0:00:00.50", "0:00:01.50"]
    assert "{\\c&H00D4FF&}" not in pause
    assert pause.endswith("hello world")


def test_server_repairs_sentence_sized_word_timestamp():
    cue = {
        "startSec": 0.0, "durationSec": 2.0,
        "textData": {"content": "one two three", "fontSize": 54, "color": "#ffffff",
                     "anim": {"kind": "karaoke"}, "highlightColor": "#ffd400",
                     "wordTimestamps": [
                         {"word": "one two three", "startSec": 0.0, "endSec": 1.5}
                     ]},
    }
    dialogues = [
        line for line in build_ass(1080, 1920, [cue]).splitlines()
        if line.startswith("Dialogue:")
    ]
    # Three active words plus a base-only tail to the clip end.
    assert len(dialogues) == 4
    assert any("{\\c&H00D4FF&}two{\\c&HFFFFFF&}" in line for line in dialogues)


def test_stroke_and_shadow_mirror_canvas():
    # Canvas: no stroke → soft shadow only (no outline); stroke → outline, no shadow.
    plain = build_ass(1920, 1080, [_cue(0)])
    assert re.search(r"Style: S0,[^\n]*,1,0\.0,2\.0,5,", plain)
    stroked = build_ass(1920, 1080, [_cue(0, stroke={"color": "#000000", "width": 6})])
    assert re.search(r"Style: S0,[^\n]*,1,6\.0,0\.0,5,", stroked)
    boxed = build_ass(1920, 1080, [_cue(0, hasBackground=True)])
    assert re.search(r"Style: S0,[^\n]*,3,4\.0,0\.0,5,", boxed)  # box pad, no shadow


def test_box_colour_goes_to_outline_field():
    # libass paints the BorderStyle=3 box with the OUTLINE colour — putting the
    # background colour only in BackColour rendered every coloured box BLACK
    # (caught by the burn-parity harness).
    cue = _cue(0, hasBackground=True, backgroundColor="#ffd400")
    ass = build_ass(1920, 1080, [cue])
    style = next(line for line in ass.splitlines() if line.startswith("Style:"))
    fields = style.split(",")
    assert fields[5] == "&H0000D4FF"   # OutlineColour = box paint
    assert fields[6] == "&H0000D4FF"   # BackColour (box shadow) matches


def test_font_map_rewrites_family_and_scales_size():
    # 54px @1080 → canvas px 54; Oswald cell/em = 1.702 → ASS Fontsize 92, and
    # the Style must carry the font's REAL internal name, not the CSS alias.
    cue = {"startSec": 0, "durationSec": 2,
           "textData": {"content": "hi", "fontSize": 54, "color": "#fff",
                        "fontFamily": '"Rounded Mplus 1c Heavy", sans-serif'}}
    font_map = {"Rounded Mplus 1c Heavy": {"assFamily": "Rounded-X M+ 1c heavy", "sizeScale": 1.395}}
    ass = build_ass(1920, 1080, [cue], font_map)
    assert "Style: S0,Rounded-X M+ 1c heavy,75," in ass  # round(54*1.395)=75
    plain = build_ass(1920, 1080, [cue])                 # no map → unchanged
    assert "Style: S0,Rounded Mplus 1c Heavy,54," in plain


def test_wrapped_lines_burn_one_event_per_line_on_canvas_grid():
    # Pre-wrapped captions burn one \pos-ed event per line so line spacing is
    # the canvas's fixed 1.25em, not libass's font-metric line height.
    cue = {"startSec": 0, "durationSec": 2,
           "textData": {"content": "On the floor clutching the phone, she argues.",
                        "fontSize": 54, "color": "#fff", "y": 0.5,
                        "wrappedLines": ["On the floor clutching", "the phone, she argues."]}}
    ass = build_ass(1080, 1920, [cue])
    texts = _dialogue_texts(ass)
    assert _count(ass, "Dialogue:") == 2
    assert all("\\q2" in t for t in texts)
    assert texts[0].endswith("On the floor clutching")
    assert texts[1].endswith("the phone, she argues.")
    # em = round(54/1080*1920) = 96 → lineH = 120; centred pair at y=960 → 900/1020.
    assert "\\pos(540,900)" in texts[0]
    assert "\\pos(540,1020)" in texts[1]


def test_reveal_ignores_wrapped_lines():
    # wrappedLines only applies to plain captions — reveals burn word windows.
    cue = {"startSec": 0.0, "durationSec": 4.0,
           "textData": {"content": "one two three four", "fontSize": 54, "color": "#fff",
                        "anim": {"kind": "word", "groupSize": 1},
                        "wrappedLines": ["one two", "three four"]}}
    ass = build_ass(1280, 720, [cue])
    assert _count(ass, "Dialogue:") == 4
    assert "\\q2" not in ass


def test_letter_spacing_sets_style_spacing_field():
    cue = {"startSec": 0, "durationSec": 2,
           "textData": {"content": "hi", "fontSize": 54, "color": "#fff", "letterSpacing": 4}}
    ass = build_ass(1080, 1080, [cue])
    assert re.search(r"Style: S0,.*,100,100,4\.0,0,", ass)


def test_word_spacing_adds_thin_separator_without_spreading_letters():
    cue = {
        "startSec": 0,
        "durationSec": 2,
        "textData": {
            "content": "spare tire forever",
            "fontSize": 48,
            "color": "#fff",
            "wordSpacing": 10,
            "anim": {"kind": "karaoke", "groupSize": 3},
        },
    }
    ass = build_ass(1080, 1080, [cue])
    assert "spare \u2009tire \u2009" in ass
    assert ass.count(" \u2009") >= 2
    assert re.search(r"Style: S0,.*,100,100,0\.0,0,", ass)


def test_every_event_references_a_defined_style():
    cues = [_cue(0, color="#ffffff"), _cue(2, color="#00ff00", hasBackground=True)]
    ass = build_ass(1280, 720, cues)
    defined = set(re.findall(r"^Style: ([^,]+),", ass, re.MULTILINE))
    used = set(re.findall(r"^Dialogue: \d+,[^,]+,[^,]+,([^,]+),", ass, re.MULTILINE))
    assert used and used <= defined

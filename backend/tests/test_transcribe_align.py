"""Tests for _reconcile_segment_words — patches over whisperX forced-alignment
silently dropping individual words from a segment (a real cause of caption
gaps: the words vanish with no exception raised, so nothing downstream saw it)."""
from __future__ import annotations

from app.routers.transcribe import (
    _fallback_segment_words,
    _group_into_cues,
    _reconcile_segment_words,
)


def _phrase_stream(phrases):
    """Build a flat word stream: [(phrase_text, gap_after_sec), ...] at ~0.35s/word."""
    words = []
    t = 0.0
    for text, gap in phrases:
        for w in text.split():
            words.append({"word": w, "start": round(t, 2), "end": round(t + 0.3, 2)})
            t += 0.35
        t += gap
    return words


def test_repeated_commands_are_kept_not_deduped():
    # Bodycam/arrest footage repeats commands constantly; these are real speech,
    # not ASR hallucinations, and must each become their own caption.
    words = _phrase_stream([
        ("put your hands behind your back", 0.5),
        ("put your hands behind your back", 0.5),
        ("stop resisting", 0.4),
        ("stop resisting", 0.4),
        ("stop resisting", 0.4),
    ])
    cues = _group_into_cues(words)
    # 5 distinct utterances → 5 cues, and every word survives (no gaps).
    assert len(cues) == 5
    assert sum(len(c["words"]) for c in cues) == len(words)
    assert [c["content"] for c in cues].count("stop resisting") == 3


def test_overlapping_hallucination_is_still_removed():
    # Same words re-emitted at OVERLAPPING timestamps = a hallucination → collapse.
    words = [
        {"word": "thank", "start": 0.0, "end": 0.4},
        {"word": "you", "start": 0.4, "end": 0.8},
        {"word": "so", "start": 0.8, "end": 1.2},
        {"word": "thank", "start": 0.1, "end": 0.5},   # overlaps the first run
        {"word": "you", "start": 0.5, "end": 0.9},
        {"word": "so", "start": 0.9, "end": 1.3},
    ]
    cues = _group_into_cues(words)
    assert len(cues) == 1
    assert cues[0]["content"] == "thank you so"


def _w(word: str, start: float, end: float) -> dict:
    return {"word": word, "start": start, "end": end}


def test_cue_flushes_on_sentence_end():
    # Two sentences with no long pause between them still split into two cues at
    # the sentence-ending period, so a sentence isn't carried into the next cue.
    words = [
        _w("I", 0.0, 0.2), _w("see", 0.25, 0.5), _w("it.", 0.55, 0.8),
        _w("How", 0.85, 1.1), _w("are", 1.15, 1.4), _w("you", 1.45, 1.7),
    ]
    cues = _group_into_cues(words)
    assert len(cues) == 2
    assert cues[0]["content"] == "I see it."
    assert cues[1]["content"] == "How are you"


def test_short_sentence_end_does_not_over_split():
    # A period after fewer than MIN_SENTENCE_WORDS words (e.g. an abbreviation)
    # does not flush, so "Mr. Smith speaking" stays one cue.
    words = [_w("Mr.", 0.0, 0.2), _w("Smith", 0.25, 0.5), _w("speaking", 0.55, 0.9)]
    cues = _group_into_cues(words)
    assert len(cues) == 1
    assert cues[0]["content"] == "Mr. Smith speaking"


def test_cjk_cues_join_without_spaces_and_chunk_by_chars():
    # WhisperX emits Chinese char-by-char; cues must join WITHOUT spaces (not
    # '我 是 你') and chunk by ~28 chars, not shred every 7 glyphs.
    chars = list("我是你全身唯一无可替代的生命法门主人你好朋友们大家一起来看吧")  # 29 chars
    words, t = [], 0.0
    for ch in chars:
        words.append({"word": ch, "start": round(t, 2), "end": round(t + 0.2, 2)})
        t += 0.22  # < PAUSE_THRESHOLD_SEC so no pause-driven flush
    cues = _group_into_cues(words)
    assert all(" " not in c["content"] for c in cues)  # no inter-char spaces
    assert 1 <= len(cues) <= 2  # ~28-char chunks, not 7-char shreds
    assert "".join(c["content"] for c in cues) == "".join(chars)  # nothing lost


def test_full_alignment_passes_through_unchanged():
    raw = [{"text": "hello there friend"}]
    aligned = [{"start": 0.0, "end": 1.5, "words": [
        _w("hello", 0.0, 0.5), _w("there", 0.5, 1.0), _w("friend", 1.0, 1.5),
    ]}]
    out = _reconcile_segment_words(raw, aligned)
    assert [w["word"] for w in out] == ["hello", "there", "friend"]
    assert out[1]["start"] == 0.5


def test_dropped_words_get_even_split_fallback():
    # ASR heard 6 words but alignment only kept 2 of them (4 silently vanished).
    raw = [{"text": "the quick brown fox jumps over"}]
    aligned = [{"start": 10.0, "end": 13.0, "words": [
        _w("quick", 10.5, 11.0), _w("fox", 12.0, 12.4),
    ]}]
    out = _reconcile_segment_words(raw, aligned)
    # All 6 raw words survive, evenly spread across the segment's [10, 13] window.
    assert [w["word"] for w in out] == ["the", "quick", "brown", "fox", "jumps", "over"]
    assert out[0]["start"] == 10.0
    assert out[-1]["end"] == 13.0
    for a, b in zip(out, out[1:]):
        assert a["end"] == b["start"]


def test_minor_word_count_mismatch_is_not_treated_as_a_drop():
    # 5 raw words, 4 aligned (80% coverage) — above the 70% threshold, so the
    # aligned (real, non-uniform) timing is kept rather than being discarded.
    raw = [{"text": "one two three four five"}]
    aligned = [{"start": 0.0, "end": 2.0, "words": [
        _w("one", 0.0, 0.3), _w("two", 0.3, 0.6), _w("three", 0.6, 0.9), _w("four", 0.9, 1.2),
    ]}]
    out = _reconcile_segment_words(raw, aligned)
    assert [w["word"] for w in out] == ["one", "two", "three", "four"]


def test_missing_segment_timing_falls_back_to_aligned_words_as_is():
    raw = [{"text": "a b c d e f g h"}]
    aligned = [{"start": None, "end": None, "words": [_w("a", 0.0, 0.1)]}]
    out = _reconcile_segment_words(raw, aligned)
    assert [w["word"] for w in out] == ["a"]  # can't fall back without segment timing


def test_segment_count_mismatch_skips_reconciliation():
    # Two raw segments but only one aligned segment — a whole segment was
    # dropped, not just individual words. Don't guess at pairing; keep the
    # words that DID come back rather than risk matching the wrong raw text.
    raw = [{"text": "first segment here"}, {"text": "second segment here"}]
    aligned = [{"start": 0.0, "end": 1.0, "words": [_w("only", 0.0, 0.5)]}]
    out = _reconcile_segment_words(raw, aligned)
    assert [w["word"] for w in out] == ["only"]


def test_empty_raw_text_is_left_alone():
    raw = [{"text": ""}]
    aligned = [{"start": 0.0, "end": 1.0, "words": [_w("um", 0.0, 0.3)]}]
    out = _reconcile_segment_words(raw, aligned)
    assert [w["word"] for w in out] == ["um"]


def test_alignment_exception_fallback_keeps_word_level_contract():
    words = _fallback_segment_words(
        [{"text": "one two three four five six seven eight", "start": 10.0, "end": 14.0}]
    )
    assert [word["word"] for word in words] == [
        "one", "two", "three", "four", "five", "six", "seven", "eight"
    ]
    assert words[0]["start"] == 10.0
    assert words[-1]["end"] == 14.0
    cues = _group_into_cues(words)
    assert max(len(cue["words"]) for cue in cues) <= 7

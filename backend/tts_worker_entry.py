"""Top-level entry shim for the OmniVoice TTS worker.

Run as a module:  <omnivoice_python> -m tts_worker_entry serve|synth|create-voice ...

Kept as plain SOURCE (never compiled) on purpose: when the backend ships
obfuscated, `app/` becomes a single Nuitka `app.pyd`, and a compiled module can't
be launched with `python -m` (its loader has no get_code). This tiny shim stays
runnable and just forwards into the (possibly compiled) app.tts_worker.main().
Works identically against a source `app/` in dev.
"""
import sys

from app.tts_worker import main

if __name__ == "__main__":
    sys.exit(main())

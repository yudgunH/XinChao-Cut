"""Top-level entry shim for the optional FunASR transcription worker."""
import sys

from app.asr.funasr_worker import main

if __name__ == "__main__":
    sys.exit(main())

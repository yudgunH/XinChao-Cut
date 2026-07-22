"""Shared ASR provider abstraction.

The transcription endpoint selects a provider through this interface, so
Chinese ASR (FunASR) can be routed by language without changing WhisperX.
"""

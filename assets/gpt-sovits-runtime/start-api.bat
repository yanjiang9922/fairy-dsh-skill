@echo off
title GPT-SoVITS API - Fairy
cd /d D:\GPT-SoVITS
set DSH_TTS_VOICES=D:/GPT-SoVITS/voices
"%~dp0venv\Scripts\python.exe" api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml > "%~dp0api.log" 2>&1
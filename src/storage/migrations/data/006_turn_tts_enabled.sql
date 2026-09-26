-- Existing Turns did not record their TTS choice. New Turns write the frozen choice explicitly.
ALTER TABLE turns ADD COLUMN tts_enabled INTEGER NOT NULL DEFAULT 0 CHECK(tts_enabled IN (0, 1));

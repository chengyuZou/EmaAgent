import { SpeechOutputsRepo, type Database, type SpeechOutputRow } from '@ema-agent/storage';
import type { AudioRecord, AudioSummary, CompletedAudioFile, SpeechAudioIdentity } from '../types.js';

export class AudioOutputStore {
  private readonly audioStorage: SpeechOutputsRepo;

  constructor(database: Database) {
    this.audioStorage = new SpeechOutputsRepo(database.sqlite);
  }

  createAudioRecord(identity: SpeechAudioIdentity, storagePath: string): void {
    this.audioStorage.insertAudio({
      ...identity,
      storagePath,
      mimeType: 'audio/wav',
      audioStatus: 'generating',
      failureMessage: null,
      byteSize: null,
      durationMs: null,
      createdAt: Date.now(),
    });
  }

  completeAudioFile(audioFile: CompletedAudioFile): void {
    this.audioStorage.completeAudio(audioFile.audioId, audioFile.fileSizeBytes, audioFile.durationMs);
  }

  findByAudioId(audioId: string): AudioRecord | null {
    const audioRow = this.audioStorage.findByAudioId(audioId);
    return audioRow ? this.toAudioRecord(audioRow) : null;
  }

  findLatestReadyAudio(turnId: string, characterName: string): AudioRecord | null {
    const audioRow = this.audioStorage.findLatestReadyForCharacter(turnId, characterName);
    return audioRow ? this.toAudioRecord(audioRow) : null;
  }

  listAudioSummaries(turnId: string, characterName?: string): AudioSummary[] {
    return this.audioStorage.listAudioSummaries(turnId, characterName).map(audioRow => ({
      audioId: audioRow.audio_id,
      characterName: audioRow.character_name,
      audioStatus: audioRow.audio_status,
      createdAtMs: audioRow.created_at,
      durationMs: audioRow.duration_ms,
      fileSizeBytes: audioRow.byte_size,
      failureMessage: audioRow.failure_message,
    }));
  }

  updateAudioStatus(audioId: string, audioStatus: AudioRecord['audioStatus'], failureMessage: string | null): boolean {
    return this.audioStorage.updateAudioStatus(audioId, audioStatus, failureMessage);
  }

  deleteAudioRecord(audioId: string): void {
    this.audioStorage.deleteAudio(audioId);
  }

  markInterruptedAudioRecordsFailed(): AudioRecord[] {
    return this.audioStorage.markInterruptedAudioRecordsFailed().map(audioRow => this.toAudioRecord(audioRow));
  }

  private toAudioRecord(audioRow: SpeechOutputRow): AudioRecord {
    return {
      audioId: audioRow.audio_id,
      sessionId: audioRow.session_id,
      turnId: audioRow.turn_id,
      characterName: audioRow.character_name,
      storagePath: audioRow.storage_path,
      mimeType: audioRow.mime_type,
      audioStatus: audioRow.audio_status,
      fileSizeBytes: audioRow.byte_size,
      durationMs: audioRow.duration_ms,
      createdAtMs: audioRow.created_at,
      failureMessage: audioRow.failure_message,
    };
  }
}

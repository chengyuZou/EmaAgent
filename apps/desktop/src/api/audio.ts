import { rpcClient, readRpcJson, readRpcVoid, serverClient, type RpcClient, type RpcJson } from './client.js';

export type AudioPlayback = RpcJson<RpcClient['api']['audio'][':audioId']['playback']['$get']>;

export const audioApi = {

  loadAudioRecord(audioId: string) {
    return readRpcJson(rpcClient.api.audio[':audioId'].$get({ param: { audioId } }));
  },

  loadAudioPlayback(audioId: string): Promise<AudioPlayback> {
    return readRpcJson(rpcClient.api.audio[':audioId'].playback.$get({ param: { audioId } }));
  },

  cancelGeneration(audioId: string): Promise<void> {
    return readRpcVoid(rpcClient.api.audio[':audioId'].cancel.$post({ param: { audioId } }));
  },

  deleteAudio(audioId: string): Promise<void> {
    return readRpcVoid(rpcClient.api.audio[':audioId'].$delete({ param: { audioId } }));
  },
  
  audioUrl(audioId: string): Promise<string> {
    return serverClient.audioUrl('/api/audio/' + encodeURIComponent(audioId) + '/file');
  },
};

import { defineEntry, type JsonObject } from "@earendil-works/pi-durable";

export interface VoiceTranscriptData {
  callId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

export const VoiceTranscriptEntry = defineEntry<VoiceTranscriptData & JsonObject>("moco.voice.transcript");

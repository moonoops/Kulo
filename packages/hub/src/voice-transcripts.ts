import { defineEntry, type JsonObject } from "@earendil-works/pi-durable";

export interface VoiceTranscriptData {
  callId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  itemId?: string;
  incomplete?: boolean;
}

export const VoiceTranscriptEntry = defineEntry<VoiceTranscriptData & JsonObject>("kulo.voice.transcript");

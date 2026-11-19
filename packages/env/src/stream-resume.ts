import {
  DEVICE_UNACKED_MAX_BYTES,
  STREAM_UNACKED_MAX_BYTES,
} from "@moco/protocol";

const ACK_FRAME_THRESHOLD = 16;
const ACK_BYTE_THRESHOLD = 64 * 1024;

export interface SequencedFrame {
  seq: number;
  payload: Buffer;
}

/**
 * Normal-operation cumulative-ACK ring buffer for one direction-paired stream.
 * Retains outgoing frames until acknowledged by peer `rxSeq`, and tracks
 * contiguous incoming `rxSeq` to deduplicate replayed frames seamlessly.
 */
export class StreamResumeBuffer {
  txSeq = 0;
  rxSeq = 0;
  unackedBytes = 0;
  readonly #unacked: SequencedFrame[] = [];
  #rxFramesSinceAck = 0;
  #rxBytesSinceAck = 0;
  #lastAckedRxSeq = 0;

  enqueueOutgoing(
    chunk: Buffer,
    deviceUnackedBytes: number,
    maxStreamBytes = STREAM_UNACKED_MAX_BYTES,
    maxDeviceBytes = DEVICE_UNACKED_MAX_BYTES,
  ): { ok: true; seq: number; payload: Buffer } | { ok: false; reason: "stream_limit" | "device_limit" } {
    const payload = Buffer.from(chunk);
    if (this.unackedBytes + payload.byteLength > maxStreamBytes) {
      return { ok: false, reason: "stream_limit" };
    }
    if (deviceUnackedBytes + payload.byteLength > maxDeviceBytes) {
      return { ok: false, reason: "device_limit" };
    }
    const seq = ++this.txSeq;
    this.#unacked.push({ seq, payload });
    this.unackedBytes += payload.byteLength;
    return { ok: true, seq, payload };
  }

  ackOutgoing(peerRxSeq: number): number {
    if (!Number.isSafeInteger(peerRxSeq) || peerRxSeq <= 0) return 0;
    let freed = 0;
    while (this.#unacked.length > 0 && this.#unacked[0]!.seq <= peerRxSeq) {
      const removed = this.#unacked.shift()!;
      freed += removed.payload.byteLength;
    }
    this.unackedBytes = Math.max(0, this.unackedBytes - freed);
    return freed;
  }

  replayFrom(peerRxSeq: number): { freedBytes: number; frames: SequencedFrame[] } {
    const freedBytes = this.ackOutgoing(peerRxSeq);
    return {
      freedBytes,
      frames: this.#unacked.map((entry) => ({ seq: entry.seq, payload: entry.payload })),
    };
  }

  acceptIncoming(
    seq: number,
    payload: Buffer,
  ):
    | { status: "deliver"; payload: Buffer; shouldAckNow: boolean }
    | { status: "duplicate" }
    | { status: "gap" } {
    if (!Number.isSafeInteger(seq) || seq < 1) return { status: "gap" };
    if (seq <= this.rxSeq) return { status: "duplicate" };
    if (seq !== this.rxSeq + 1) return { status: "gap" };
    this.rxSeq = seq;
    this.#rxFramesSinceAck += 1;
    this.#rxBytesSinceAck += payload.byteLength;
    const shouldAckNow =
      this.#rxFramesSinceAck >= ACK_FRAME_THRESHOLD ||
      this.#rxBytesSinceAck >= ACK_BYTE_THRESHOLD;
    return { status: "deliver", payload, shouldAckNow };
  }

  needsAck(): boolean {
    return this.rxSeq > this.#lastAckedRxSeq;
  }

  markAckSent(): void {
    this.#lastAckedRxSeq = this.rxSeq;
    this.#rxFramesSinceAck = 0;
    this.#rxBytesSinceAck = 0;
  }

  clear(): number {
    const freed = this.unackedBytes;
    this.#unacked.length = 0;
    this.unackedBytes = 0;
    return freed;
  }
}

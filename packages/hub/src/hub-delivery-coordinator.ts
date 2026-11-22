import type { Context } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import {
  DeliveryReceiptDoc,
  assertDeliveryIntent,
  legacyDeliveryConflict,
  writeDeliveryReceipt,
  type DeliveryAck,
  type DeliveryIntent,
  type DeliveryReceipt,
} from "./delivery-receipts.js";
import { KuloStateDoc } from "./state.js";

/**
 * Per-key FIFO serial execution queue with failure isolation and identity cleanup.
 */
export class KeyedSerialQueue {
  readonly #chains = new Map<string, Promise<unknown>>();

  enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.#chains.set(key, current);
    void current.then(
      () => {
        if (this.#chains.get(key) === current) this.#chains.delete(key);
      },
      () => {
        if (this.#chains.get(key) === current) this.#chains.delete(key);
      },
    );
    return current;
  }

  async drain(): Promise<void> {
    // Loop until chains that spawn follow-up work (e.g. parent -> child ticket stops) settle.
    while (this.#chains.size > 0) {
      const pending = [...this.#chains.values()];
      await Promise.allSettled(pending);
    }
  }
}

/**
 * Coordinates the three independent admission queues (delivery -> chat / ticket)
 * and durable receipt lookup/promotion without polluting pure delivery-receipts.ts.
 */
export class HubDeliveryCoordinator {
  readonly #harness: Harness;
  readonly #deliveryQueue = new KeyedSerialQueue();
  readonly #chatQueue = new KeyedSerialQueue();
  readonly #ticketQueue = new KeyedSerialQueue();
  #closing = false;

  constructor(harness: Harness) {
    this.#harness = harness;
  }

  queueChat<T>(topicId: string, operation: () => Promise<T>): Promise<T> {
    return this.#chatQueue.enqueue(topicId, operation);
  }

  queueTicket<T>(ticketId: string, operation: () => Promise<T>): Promise<T> {
    return this.#ticketQueue.enqueue(ticketId, operation);
  }

  async deliveryReceipt(
    intent: DeliveryIntent,
    context: Context,
  ): Promise<Readonly<DeliveryReceipt> | undefined> {
    const receipt = await this.#harness.snapshot(
      DeliveryReceiptDoc,
      intent.key,
      context,
    );
    assertDeliveryIntent(receipt, intent);
    if (receipt) return receipt;
    const legacy = await this.#harness.snapshot(
      DeliveryReceiptDoc,
      intent.legacyKey,
      context,
    );
    if (!legacy) return undefined;
    assertDeliveryIntent(legacy, {
      ...intent,
      fingerprint: intent.legacyFingerprint,
    });
    if (legacy.phase === "empty") return undefined;
    const phase = legacy.phase;
    await this.#harness.commit(
      (tx) =>
        writeDeliveryReceipt(
          tx,
          intent,
          legacy.ack as DeliveryAck,
          phase,
          legacy.continuation,
        ),
      context,
    );
    return { ...legacy, fingerprint: intent.fingerprint };
  }

  async withDelivery<T>(
    intent: DeliveryIntent | undefined,
    context: Context,
    operation: (receipt?: Readonly<DeliveryReceipt>) => Promise<T>,
    replay: (receipt: Readonly<DeliveryReceipt>) => Promise<T>,
  ): Promise<T> {
    if (!intent) return operation();
    if (this.#closing) {
      throw new Error("KuloHub is closing and cannot admit new deliveries.");
    }
    return this.#deliveryQueue.enqueue(intent.key, async () => {
      const receipt = await this.deliveryReceipt(intent, context);
      // Preserve in-place mutation of intent.replayed for deliverClientMessage().
      if (receipt && receipt.phase !== "empty") intent.replayed = true;
      if (receipt?.phase === "complete") {
        return replay(receipt);
      }
      if (!receipt || receipt.phase === "empty") {
        const state = await this.#harness.snapshot(KuloStateDoc, context);
        if (state?.processedCommands?.[intent.id] || state?.commandIndex[intent.id]) {
          legacyDeliveryConflict();
        }
        for (const [key, command] of Object.entries(state?.processedCommands ?? {})) {
          if (
            command.action === "chat.send" &&
            key === `req:${command.ticketId}:${intent.id}` &&
            (intent.action !== "chat.send" || intent.topicId !== command.ticketId)
          ) {
            legacyDeliveryConflict();
          }
        }
      }
      return operation(receipt);
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    await this.#deliveryQueue.drain();
    await this.#chatQueue.drain();
    await this.#ticketQueue.drain();
  }
}

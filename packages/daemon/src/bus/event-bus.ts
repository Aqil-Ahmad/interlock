import { ulid } from '@interlock/shared';
import type {
  EventId,
  EventOf,
  EventRecord,
  InterlockEvent,
  InterlockEventType,
  Logger,
} from '@interlock/shared';

/**
 * The internal event bus.
 *
 * Components talk through this and nothing else, which buys two things: the
 * daemon can be re-driven from a recorded log, and a component can be tested by
 * publishing events and asserting on what it publishes back — no git, Docker or
 * filesystem required.
 *
 * Delivery is asynchronous and isolated: a throwing subscriber never stops the
 * others and never fails the publisher.
 */

export interface Subscription {
  unsubscribe(): void;
}

export interface EventBusOptions {
  readonly logger: Logger;
  /** Called for every event, before subscribers. This is the persistence hook. */
  readonly onRecord?: (record: EventRecord) => void;
}

type AnyHandler = (event: InterlockEvent) => void | Promise<void>;

export class EventBus {
  readonly #handlers = new Map<InterlockEventType | '*', Set<AnyHandler>>();
  readonly #logger: Logger;
  readonly #onRecord: ((record: EventRecord) => void) | undefined;
  /** Event currently being dispatched, so causality is captured automatically. */
  #currentCause: EventId | null = null;

  constructor(options: EventBusOptions) {
    this.#logger = options.logger.child('bus');
    this.#onRecord = options.onRecord;
  }

  /** Subscribe to one event type. */
  on<T extends InterlockEventType>(
    type: T,
    handler: (event: EventOf<T>) => void | Promise<void>,
  ): Subscription {
    return this.#add(type, handler as AnyHandler);
  }

  /** Subscribe to every event. Used by the store, the WebSocket bridge and tests. */
  onAny(handler: (event: InterlockEvent) => void | Promise<void>): Subscription {
    return this.#add('*', handler as AnyHandler);
  }

  /**
   * Publish an event.
   *
   * Resolves once every subscriber has settled, so tests can await a publish
   * instead of sleeping. Rejections are logged, never propagated.
   */
  async publish(event: InterlockEvent): Promise<EventId> {
    const id = ulid<EventId>();
    const record: EventRecord = {
      id,
      repoId: event.repoId,
      type: event.type,
      payload: event,
      at: event.at,
      causedBy: this.#currentCause,
    };

    this.#onRecord?.(record);

    const handlers = [
      ...(this.#handlers.get(event.type) ?? []),
      ...(this.#handlers.get('*') ?? []),
    ];

    const previousCause = this.#currentCause;
    this.#currentCause = id;
    try {
      await Promise.all(
        handlers.map(async (handler) => {
          try {
            await handler(event);
          } catch (error) {
            this.#logger.error('subscriber failed', {
              eventType: event.type,
              eventId: id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    } finally {
      this.#currentCause = previousCause;
    }

    return id;
  }

  /** Number of registered handlers. Used by shutdown assertions and tests. */
  get handlerCount(): number {
    let total = 0;
    for (const set of this.#handlers.values()) total += set.size;
    return total;
  }

  #add(key: InterlockEventType | '*', handler: AnyHandler): Subscription {
    const set = this.#handlers.get(key) ?? new Set<AnyHandler>();
    set.add(handler);
    this.#handlers.set(key, set);
    return {
      unsubscribe: () => {
        set.delete(handler);
      },
    };
  }
}

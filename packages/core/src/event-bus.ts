type Unsubscribe = () => void;
type EventTypeOf<E> = E extends { type: infer T } ? T : never;
type EventByType<E, T> = E extends { type: T } ? E : never;

export interface EventBus<E extends { type: string }> {
  publish(event: E): void;
  on<T extends EventTypeOf<E>>(
    type: T,
    handler: (event: EventByType<E, T>) => void,
  ): Unsubscribe;
  onAny(handler: (event: E) => void): Unsubscribe;
}

type AnyHandler<E> = (event: E) => void;

export class InMemoryEventBus<E extends { type: string }>
  implements EventBus<E>
{
  private byType = new Map<string, Set<AnyHandler<E>>>();
  private anyHandlers = new Set<AnyHandler<E>>();

  publish(event: E): void {
    const typed = this.byType.get(event.type);
    if (typed) {
      for (const handler of [...typed]) {
        try {
          handler(event);
        } catch (err) {
          console.error(`[event-bus] handler for ${event.type} threw:`, err);
        }
      }
    }
    for (const handler of [...this.anyHandlers]) {
      try {
        handler(event);
      } catch (err) {
        console.error("[event-bus] onAny handler threw:", err);
      }
    }
  }

  on<T extends EventTypeOf<E>>(
    type: T,
    handler: (event: EventByType<E, T>) => void,
  ): Unsubscribe {
    let set = this.byType.get(type as string);
    if (!set) {
      set = new Set();
      this.byType.set(type as string, set);
    }
    const wrapped: AnyHandler<E> = (e) => {
      handler(e as EventByType<E, T>);
    };
    set.add(wrapped);
    return () => {
      set?.delete(wrapped);
    };
  }

  onAny(handler: AnyHandler<E>): Unsubscribe {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }
}

/**
 * Publish helper that adds a `layer` discriminator to events before
 * publishing. Centralizes layer-tagging so emission sites don't have to
 * remember to set the field — runtimes pass their layer once per
 * helper call.
 *
 * If the event already carries a `layer` field (defensively), the existing
 * value is preserved. This lets nested helpers (e.g. streamModelInference)
 * re-publish events without double-tagging.
 */
export function publishWithLayer<E extends { type: string; layer?: string }>(
  bus: EventBus<E>,
  layer: E extends { layer: infer L } ? L : never,
  event: Omit<E, "layer"> | E,
): void {
  if ("layer" in event && event.layer !== undefined) {
    bus.publish(event as E);
    return;
  }
  bus.publish({ ...event, layer } as E);
}

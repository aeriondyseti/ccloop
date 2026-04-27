/**
 * In-memory event bus per §11.2. Subscribers receive every emit
 * synchronously; failing subscribers don't break emit. The TUI is one
 * subscriber; the events.jsonl writer is another.
 */
export type Listener<T> = (event: T) => void;

export class EventBus<T = unknown> {
  private listeners: Listener<T>[] = [];

  subscribe(fn: Listener<T>): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  emit(event: T): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // Subscribers must not break emit.
      }
    }
  }
}

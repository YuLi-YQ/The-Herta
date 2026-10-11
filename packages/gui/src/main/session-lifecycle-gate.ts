/** Serialize short activation/close/navigation transactions, never whole turns. */
export function createSessionLifecycleGate() {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    busy: () => pending > 0,
    run<T>(operation: () => Promise<T> | T): Promise<T> {
      pending += 1;
      const result = tail.then(operation);
      tail = result.then(
        () => {
          pending -= 1;
        },
        () => {
          pending -= 1;
        },
      );
      return result;
    },
  };
}

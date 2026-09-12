export class KeyedMutationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    return result.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
  }

  wait(key: string): Promise<void> {
    return this.tails.get(key) ?? Promise.resolve();
  }

  async waitAll(prefix?: string): Promise<void> {
    const pending = Array.from(this.tails.entries())
      .filter(([key]) => prefix === undefined || key.startsWith(prefix))
      .map(([, tail]) => tail);
    await Promise.all(pending);
  }
}

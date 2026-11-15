import { EventEmitter } from "node:events";

/**
 * In-process wake channel: ingress signals the worker to skip idle sleep.
 */
export class WakeBus extends EventEmitter {
  signal(): void {
    this.emit("wake");
  }

  wait(timeoutMs: number, abort?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (abort?.aborted) {
        resolve();
        return;
      }
      const onWake = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.off("wake", onWake);
        abort?.removeEventListener("abort", onAbort);
      };

      this.on("wake", onWake);
      abort?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

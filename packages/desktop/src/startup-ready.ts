export class DesktopStartupReady {
  #pending?: { ownerId: number; origin: string; resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout };

  wait(ownerId: number, origin: string, timeoutMs = 30_000): Promise<void> {
    this.cancel(new Error("启动已由新的请求替代。"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancel(new Error("Moco 界面启动超时。")), timeoutMs);
      this.#pending = { ownerId, origin, resolve, reject, timer };
    });
  }

  acknowledge(ownerId: number, origin: string): boolean {
    const pending = this.#pending;
    if (!pending || pending.ownerId !== ownerId || pending.origin !== origin) return false;
    clearTimeout(pending.timer);
    this.#pending = undefined;
    pending.resolve();
    return true;
  }

  cancel(error = new Error("Moco 界面启动已取消。")): void {
    const pending = this.#pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending = undefined;
    pending.reject(error);
  }
}

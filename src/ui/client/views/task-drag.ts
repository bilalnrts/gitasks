import type { WorkflowStatus } from "../models.js";

export interface TaskDragCallbacks {
  labelFor(status: WorkflowStatus | null): string;
  announce(message: string): void;
  openMoveMenu(issueNumber: number, trigger: HTMLElement): void;
  drop(issueNumber: number, source: WorkflowStatus | null, target: WorkflowStatus): void;
  remains(issueNumber: number, status: WorkflowStatus | null): void;
  canStart(issueNumber: number): boolean;
}

interface DragSession {
  pointerId: number;
  issueNumber: number;
  source: WorkflowStatus | null;
  handle: HTMLElement;
  card: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  touch: boolean;
  active: boolean;
  moved: boolean;
  longPress?: number;
  ghost?: HTMLElement;
  placeholder?: HTMLElement;
  target?: HTMLElement;
  targetStatus?: WorkflowStatus;
}

export class TaskDragController {
  private readonly board: HTMLElement;
  private readonly overlayRoot: HTMLElement;
  private readonly callbacks: TaskDragCallbacks;
  private session: DragSession | undefined;
  private scrollFrame: number | undefined;
  private readonly onBlur = (): void => this.cancel();
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.session?.active) {
      event.preventDefault();
      this.cancel();
    }
  };

  constructor(board: HTMLElement, overlayRoot: HTMLElement, callbacks: TaskDragCallbacks) {
    this.board = board;
    this.overlayRoot = overlayRoot;
    this.callbacks = callbacks;
    board.addEventListener("pointerdown", this.onPointerDown);
    board.addEventListener("click", this.onClick);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("keydown", this.onKeyDown);
  }

  dispose(): void {
    this.cancel();
    this.board.removeEventListener("pointerdown", this.onPointerDown);
    this.board.removeEventListener("click", this.onClick);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("keydown", this.onKeyDown);
  }

  private readonly onClick = (event: MouseEvent): void => {
    const handle = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-drag-handle]") : null;
    if (!handle) return;
    if (handle.dataset.dragged === "true") {
      handle.dataset.dragged = "false";
      event.preventDefault();
      return;
    }
    const issueNumber = Number(handle.closest<HTMLElement>("[data-issue]")?.dataset.issue);
    if (Number.isSafeInteger(issueNumber)) this.callbacks.openMoveMenu(issueNumber, handle);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.session) return;
    const handle = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-drag-handle]") : null;
    const card = handle?.closest<HTMLElement>("[data-issue]");
    if (!handle || !card) return;
    const issueNumber = Number(card.dataset.issue);
    if (!Number.isSafeInteger(issueNumber) || !this.callbacks.canStart(issueNumber)) return;
    const statusValue = card.dataset.status;
    const source = statusValue && statusValue !== "unclassified" ? statusValue as WorkflowStatus : null;
    const session: DragSession = {
      pointerId: event.pointerId,
      issueNumber,
      source,
      handle,
      card,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      touch: event.pointerType === "touch",
      active: false,
      moved: false,
    };
    this.session = session;
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener("pointermove", this.onPointerMove);
    handle.addEventListener("pointerup", this.onPointerUp, { once: true });
    handle.addEventListener("pointercancel", this.onPointerCancel, { once: true });
    handle.addEventListener("lostpointercapture", this.onLostCapture, { once: true });
    if (session.touch) session.longPress = window.setTimeout(() => this.activate(session), 300);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const session = this.session;
    if (!session || event.pointerId !== session.pointerId) return;
    session.x = event.clientX;
    session.y = event.clientY;
    const distance = Math.hypot(session.x - session.startX, session.y - session.startY);
    if (!session.active) {
      if (session.touch) {
        if (distance > 8) this.cleanup(false);
        return;
      }
      if (distance >= 4) this.activate(session);
    }
    if (!session.active) return;
    event.preventDefault();
    session.moved = true;
    this.position(session);
    this.updateTarget(session);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const session = this.session;
    if (!session || event.pointerId !== session.pointerId) return;
    if (!session.active) {
      this.cleanup(false);
      return;
    }
    const target = session.targetStatus;
    const valid = target !== undefined && target !== session.source;
    const issueNumber = session.issueNumber;
    const source = session.source;
    const handle = session.handle;
    this.cleanup(true);
    handle.dataset.dragged = "true";
    if (valid) this.callbacks.drop(issueNumber, source, target);
    else this.callbacks.remains(issueNumber, source);
  };

  private readonly onPointerCancel = (): void => this.cancel();
  private readonly onLostCapture = (): void => {
    if (this.session?.active) this.cancel();
  };

  private activate(session: DragSession): void {
    if (this.session !== session || session.active) return;
    window.clearTimeout(session.longPress);
    session.active = true;
    session.card.setAttribute("aria-busy", "true");
    session.card.classList.add("drag-source");
    const rect = session.card.getBoundingClientRect();
    const placeholder = document.createElement("div");
    placeholder.className = "task-placeholder";
    placeholder.style.height = `${rect.height}px`;
    placeholder.setAttribute("aria-hidden", "true");
    session.card.after(placeholder);
    session.placeholder = placeholder;
    const ghost = session.card.cloneNode(true) as HTMLElement;
    ghost.className = "task-card drag-ghost";
    ghost.style.width = `${rect.width}px`;
    ghost.inert = true;
    this.overlayRoot.append(ghost);
    session.ghost = ghost;
    for (const target of this.board.querySelectorAll<HTMLElement>("[data-drop-status]")) target.classList.add("drop-available");
    this.position(session);
    this.callbacks.announce(`Picked up issue #${session.issueNumber} from ${this.callbacks.labelFor(session.source)}.`);
    this.scrollFrame = requestAnimationFrame(this.autoScroll);
  }

  private position(session: DragSession): void {
    if (session.ghost) session.ghost.style.transform = `translate3d(${session.x + 12}px, ${session.y + 12}px, 0)`;
  }

  private updateTarget(session: DragSession): void {
    const target = document.elementFromPoint(session.x, session.y)?.closest<HTMLElement>("[data-drop-status]");
    if (session.target !== target) {
      session.target?.classList.remove("drop-target");
      session.target?.querySelector<HTMLElement>(".drop-cue")?.remove();
      if (target === null || target === undefined) {
        delete session.target;
        delete session.targetStatus;
      } else {
        const targetStatus = target.dataset.dropStatus as WorkflowStatus;
        session.target = target;
        session.targetStatus = targetStatus;
        target.classList.add("drop-target");
        target.append(Object.assign(document.createElement("p"), { className: "drop-cue", textContent: `Drop in ${targetStatus}` }));
        this.callbacks.announce(`Move issue #${session.issueNumber} to ${targetStatus}.`);
      }
    }
  }

  private readonly autoScroll = (): void => {
    const session = this.session;
    if (!session?.active) return;
    const rect = this.board.getBoundingClientRect();
    let speed = 0;
    if (session.x < rect.left + 48) speed = -Math.min(20, (rect.left + 48 - session.x) / 2);
    else if (session.x > rect.right - 48) speed = Math.min(20, (session.x - (rect.right - 48)) / 2);
    if (speed) this.board.scrollLeft += speed;
    this.scrollFrame = requestAnimationFrame(this.autoScroll);
  };

  private cancel(): void {
    const session = this.session;
    if (!session) return;
    const active = session.active;
    const issueNumber = session.issueNumber;
    const source = session.source;
    this.cleanup(active);
    if (active) this.callbacks.remains(issueNumber, source);
  }

  private cleanup(releaseCapture: boolean): void {
    const session = this.session;
    if (!session) return;
    window.clearTimeout(session.longPress);
    if (this.scrollFrame !== undefined) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = undefined;
    session.target?.classList.remove("drop-target");
    session.target?.querySelector<HTMLElement>(".drop-cue")?.remove();
    session.ghost?.remove();
    session.placeholder?.remove();
    session.card.classList.remove("drag-source");
    session.card.removeAttribute("aria-busy");
    for (const target of this.board.querySelectorAll<HTMLElement>("[data-drop-status]")) target.classList.remove("drop-available");
    session.handle.removeEventListener("pointermove", this.onPointerMove);
    this.session = undefined;
    if (releaseCapture && session.handle.hasPointerCapture(session.pointerId)) session.handle.releasePointerCapture(session.pointerId);
  }
}

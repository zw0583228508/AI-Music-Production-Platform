export type SaveAcknowledgement = "synced" | "resave" | "ignored";

export class EditorConflictError extends Error {
  readonly name = "EditorConflictError";

  constructor() {
    super("The arrangement changed elsewhere. Choose whether to load the latest revision or apply your local edit to it.");
  }
}

export class EditorSaveCoordinator {
  private generation = 0;
  private inFlightGeneration: number | null = null;

  markChanged(): number {
    this.generation += 1;
    return this.generation;
  }

  hasInFlightSave(): boolean {
    return this.inFlightGeneration !== null;
  }

  beginSave(): number | null {
    if (this.inFlightGeneration !== null) return null;
    this.inFlightGeneration = this.generation;
    return this.inFlightGeneration;
  }

  acknowledge(savingGeneration: number): SaveAcknowledgement {
    if (this.inFlightGeneration !== savingGeneration) return "ignored";
    this.inFlightGeneration = null;
    return this.generation === savingGeneration ? "synced" : "resave";
  }

  reject(savingGeneration: number): void {
    if (this.inFlightGeneration === savingGeneration) {
      this.inFlightGeneration = null;
    }
  }
}
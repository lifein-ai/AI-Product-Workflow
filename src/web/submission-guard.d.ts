export interface SubmissionAction {
  kind: string;
  requestId: string;
}

export interface SubmissionGuard {
  begin(kind: string, detail?: Record<string, unknown>): SubmissionAction | null;
  finish(action: SubmissionAction): void;
  isActive(): boolean;
}

export function createSubmissionGuard(options?: {
  log?: (event: string, detail: Record<string, unknown>) => void;
}): SubmissionGuard;

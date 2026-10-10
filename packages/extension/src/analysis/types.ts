/**
 * Auth-flow analysis over recorded traffic (CONTRACTS §12.3). Pure, lead-owned types.
 */
export interface AuthFlowStep {
  exchangeId: string;
  role: 'unauthorized' | 'refresh' | 'retry' | 'other';
  at: number;
}

export interface AuthFlow {
  /** The 401 (or 403) that started it, its refresh call(s), and the retried request(s). */
  steps: AuthFlowStep[];
  /** More than one refresh call for the same expiry within `windowMs`: the classic token-refresh stampede. */
  stampede?: { refreshCalls: number; windowMs: number };
  /** The retry never happened, or got 401 again. */
  problem?: string;
}

export interface AuthAnalysis {
  flows: AuthFlow[];
}

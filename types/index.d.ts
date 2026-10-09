/** One Ticket of a Run, as its event log tells it. */
export type RunTicket = {
  n: number;
  title: string;
  tier: string;
  /** The Run's last line about it, and when. */
  say: string;
  sayAt: string;
  cost: number;
  outcome: 'landed' | 'parked' | 'aborted' | 'failed' | null;
  /** The commit it landed in, the Park's reason, what an abort discarded, or the failure that stopped the Run. */
  detail: string;
};

/** A Run, read from its `run-<time>.jsonl`. */
export type RunView = {
  file: string;
  startedAt: string;
  lastAt: string;
  /** The Run's process, when its log names it. */
  pid: number | null;
  /** What the owner asked of it while it went. */
  asked: 'stop' | 'abort' | null;
  ended: { kind: 'finished' | 'stopped' | 'aborted'; at: string; error: string } | null;
  /** The Frontier when it started. */
  ready: number[];
  tickets: RunTicket[];
  /** The Tickets it is working, in the order it claimed them: claimed, with no outcome yet, while it has not ended. */
  inFlight: number[];
  sessions: number;
  cost: number;
};

/** One past Run, for the history. */
export type RunSummary = {
  file: string;
  startedAt: string;
  lastAt: string;
  ending: 'finished' | 'stopped' | 'aborted' | 'open';
  askedStop: boolean;
  landed: number;
  parked: number;
  aborted: number;
  cost: number;
  /** Why it stopped, when it did. */
  error: string;
  tickets: RunTicket[];
};

export type FrontierEntry = {
  n: number;
  title: string;
  tier: string;
  assignees: string[];
  /** Its open blockers, `#12` or `#12 [human]`. */
  waitsOn: string[];
};

export type FrontierView = {
  ready: FrontierEntry[];
  inProgress: FrontierEntry[];
  waiting: FrontierEntry[];
  specsLabelled: number[];
  /** When it was read, ms since the epoch. */
  at: number;
  error: string;
};

/** Something only the owner can move. */
export type Attention = {
  kind: 'ci' | 'pr' | 'human' | 'info' | 'triage' | 'claimed' | 'spec';
  n: number | null;
  text: string;
  href: string | null;
};

export type OwnerView = { items: Attention[]; at: number; error: string };

/** What the session working a Ticket in flight did last, from its transcript. */
export type Activity = { ticket: number; calls: number; last: string };

export type Notice = { text: string; isError: boolean; at: number };

export type Project = {
  main: string;
  logDir: string;
  repo: string;
  base: string;
  name: string;
  /** The Contract's `parallel`, the most Tickets a Run works at once, or null when it caps nothing. */
  parallel: number | null;
};

declare module 'claude-code' {
  interface PluginState {
    verkstad: {
      project: Project | null;
      run: RunView | null;
      /** Whether the Run's process is still there, when the log names it. */
      isAlive: boolean | null;
      history: RunSummary[];
      frontier: FrontierView | null;
      owner: OwnerView | null;
      /** One for each Ticket in flight whose session's transcript was read. */
      activity: Activity[];
      /** The last control's answer. */
      notice: Notice | null;
      /** The past Run whose Tickets the history shows, by its event log. */
      expanded: string | null;
      /** Abort was pressed once and waits for its confirmation. */
      isConfirmingAbort: boolean;
      /** When Start launched a Run whose event log has not appeared yet; 0 otherwise. */
      startingAt: number;
      /** Now, refreshed by the poll, so that ages redraw. */
      tick: number;
    };
  }
}

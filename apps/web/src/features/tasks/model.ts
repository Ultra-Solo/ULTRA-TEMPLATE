export const STATUSES = ["todo", "in_progress", "done"] as const;
export type Status = (typeof STATUSES)[number];

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly status: Status;
}

export const LABELS: Readonly<Record<Status, string>> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

/** Mirrors the services' transition rules, so the interface offers only moves the API accepts. */
const NEXT: Readonly<Record<Status, readonly Status[]>> = {
  todo: ["in_progress"],
  in_progress: ["todo", "done"],
  done: [],
};

export const nextStatuses = (status: Status): readonly Status[] => NEXT[status];

const isStatus = (value: unknown): value is Status => STATUSES.some((status) => status === value);

/** The API response is external input: validated once, here, instead of trusted by every component. */
export function parseTasks(json: unknown): Task[] {
  if (!Array.isArray(json)) throw new Error("expected the API to return a list of tasks");
  return json.map((item: unknown, index) => {
    if (typeof item !== "object" || item === null) throw new Error(`task ${index} is not an object`);
    const { id, title, status } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof title !== "string" || !isStatus(status)) {
      throw new Error(`task ${index} does not have a string id, a string title and a known status`);
    }
    return { id, title, status };
  });
}

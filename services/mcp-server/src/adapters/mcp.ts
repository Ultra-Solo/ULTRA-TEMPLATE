/**
 * The inbound adapter: the use cases as MCP tools.
 *
 * It does three things and nothing else — declare each tool (its input and output schemas and the
 * hints a client decides on), call a use case, and turn the outcome into text and structured content. A failure the caller can act on comes back as `isError: true` with
 * the reason, because a thrown error reaches the model as a protocol error it cannot inspect.
 */
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { DomainError, MAX_TITLE_LENGTH, nextStatuses, STATUSES } from "../domain/task.ts";
import type { Task } from "../domain/task.ts";
import { GatewayError } from "../application/ports.ts";
import type { TaskGateway } from "../application/ports.ts";
import { createTask, getTask, listTasks, moveTask } from "../application/task-tools.ts";

export const SERVER_NAME = "tasks";

// `isError` and `structuredContent` are written `| undefined` because exactOptionalPropertyTypes is
// on: without it this type is not assignable to what registerTool expects, and the error names the
// deprecated overload.
type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown> | undefined;
  isError?: boolean | undefined;
};

/** A task as a client reads it: what the API answers, plus the moves its status allows. */
const taskOutput = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextStatuses: z.array(z.enum(STATUSES)).describe("The statuses move_task accepts for this task now"),
});

const structured = (task: Task) => ({ ...task, nextStatuses: [...nextStatuses(task.status)] });

const describe = (task: Task): string =>
  `${task.id}  ${task.status.padEnd(11)} ${task.title}  (moves from here: ${nextStatuses(task.status).join(", ") || "none"})`;

/** The text a model reads and the structured value a client parses, saying the same thing. */
const answer = (text: string, structuredContent: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  structuredContent,
});

/**
 * Both failures a caller can do something about — a rule it broke, or an API that would not answer —
 * are reported as tool errors. Anything else is a bug here and is left to propagate. A tool error
 * carries no structured content, and the SDK does not hold it to the output schema.
 */
async function attempt(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof DomainError) return { content: [{ type: "text", text: `${err.code}: ${err.message}` }], isError: true };
    if (err instanceof GatewayError) return { content: [{ type: "text", text: err.message }], isError: true };
    throw err;
  }
}

/**
 * Hints a client uses to decide what to run without asking. Every tool here talks to one task API,
 * so none reaches an open world, and none deletes anything.
 */
const READS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
// Creating twice makes two tasks, and moving twice is refused the second time: neither is idempotent.
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

// A model reads the rules from the descriptions, so they are written from the domain's own statement of
// them, which scripts/check-facts.mjs holds to scripts/rules/task-rules.json. Prose written by hand here
// would be a second statement of the rules that nothing compares.
const FIRST_STATUS = STATUSES[0];
const LEGAL_MOVES = STATUSES.flatMap((from) => nextStatuses(from).map((to) => `${from} → ${to}`)).join(", ");

/** The server, reporting `version` to every client that connects. */
export function createServer(gateway: TaskGateway, { version }: { version: string }): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version }, { capabilities: { tools: {} } });

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "List every task with its status and the moves that status allows.",
      inputSchema: z.object({}),
      outputSchema: z.object({ tasks: z.array(taskOutput) }),
      annotations: READS,
    },
    async () =>
      attempt(async () => {
        const tasks = await listTasks(gateway);
        return answer(tasks.length === 0 ? "No tasks yet." : tasks.map(describe).join("\n"), { tasks: tasks.map(structured) });
      }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get a task",
      description: "Get one task by id, with its status and the moves that status allows.",
      inputSchema: z.object({ id: z.string().describe("The id of the task, as list_tasks reports it") }),
      outputSchema: z.object({ task: taskOutput }),
      annotations: READS,
    },
    async ({ id }) =>
      attempt(async () => {
        const task = await getTask(gateway, id);
        return answer(describe(task), { task: structured(task) });
      }),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create a task",
      description: `Create a task. It starts in the ${FIRST_STATUS} status.`,
      // No maxLength: a schema counts UTF-16 units before trimming, the rules count code points after it.
      // The domain checks the length, as the API does, and says why a title is refused.
      inputSchema: z.object({ title: z.string().describe(`What the task is, in a line of at most ${MAX_TITLE_LENGTH} characters`) }),
      outputSchema: z.object({ task: taskOutput }),
      annotations: WRITES,
    },
    async ({ title }) =>
      attempt(async () => {
        const task = await createTask(gateway, title);
        return answer(`Created ${describe(task)}`, { task: structured(task) });
      }),
  );

  server.registerTool(
    "move_task",
    {
      title: "Move a task",
      description: `Move a task to another status. Legal moves: ${LEGAL_MOVES}. Any other is refused.`,
      inputSchema: z.object({
        id: z.string().describe("The id of the task, as list_tasks reports it"),
        status: z.enum(STATUSES).describe("The status to move it to"),
      }),
      outputSchema: z.object({ task: taskOutput }),
      annotations: WRITES,
    },
    async ({ id, status }) =>
      attempt(async () => {
        const task = await moveTask(gateway, id, status);
        return answer(`Moved ${describe(task)}`, { task: structured(task) });
      }),
  );

  return server;
}

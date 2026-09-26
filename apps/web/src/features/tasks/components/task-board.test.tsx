// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskBoard } from "./task-board.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it("lists tasks and offers only the moves the API accepts", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json([{ id: "a", title: "ship it", status: "todo" }])),
  );
  render(<TaskBoard />);

  expect(await screen.findByText("ship it")).toBeTruthy();
  expect(screen.getByRole("button", { name: "In progress" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
});

it("moves a task, then reloads the list", async () => {
  let status = "todo";
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      status = "in_progress";
      return json({});
    }
    return json([{ id: "a", title: "ship it", status }]);
  });
  vi.stubGlobal("fetch", fetch);
  render(<TaskBoard />);

  fireEvent.click(await screen.findByRole("button", { name: "In progress" }));

  await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toBeTruthy());
  expect(fetch).toHaveBeenCalledWith("/api/tasks/a/status", expect.objectContaining({ method: "PATCH", body: '{"status":"in_progress"}' }));
});

it("shows the service's error message when a request fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json({ error: "service unavailable" }, 503)),
  );
  render(<TaskBoard />);

  expect((await screen.findByRole("alert")).textContent).toBe("service unavailable");
});

it("leaves a title's length to the API, which counts characters where the input would count UTF-16 units", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json([])),
  );
  render(<TaskBoard />);

  // A maxLength of 200 would stop at 100 astral characters, half of what the API takes.
  expect((await screen.findByRole("textbox")).hasAttribute("maxlength")).toBe(false);
});

/** A fetch whose answers the test hands out, in whatever order it likes. */
function controlledFetch() {
  const calls: { path: string; init?: RequestInit; answer: (response: Response) => void }[] = [];
  const fetch = vi.fn(
    (path: string, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        calls.push({ path, init, answer: resolve });
      }),
  );
  return { fetch, calls };
}

it("a form submitted twice while its request is out creates one task", async () => {
  const { fetch, calls } = controlledFetch();
  vi.stubGlobal("fetch", fetch);
  render(<TaskBoard />);
  calls[0]?.answer(json([]));
  fireEvent.change(await screen.findByRole("textbox"), { target: { value: "ship it" } });
  const form = screen.getByRole("textbox").closest("form") as HTMLFormElement;
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(1);
});

it("a move the API refuses still reloads the list, and shows why", async () => {
  let status = "todo";
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      status = "in_progress"; // someone else moved it first
      return json({ error: "cannot move a task from in_progress to in_progress" }, 409);
    }
    return json([{ id: "a", title: "ship it", status }]);
  });
  vi.stubGlobal("fetch", fetch);
  render(<TaskBoard />);

  fireEvent.click(await screen.findByRole("button", { name: "In progress" }));

  expect((await screen.findByRole("alert")).textContent).toMatch(/cannot move/);
  await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toBeTruthy());
});

it("a list that answers after a newer one is ignored", async () => {
  const { fetch, calls } = controlledFetch();
  vi.stubGlobal("fetch", fetch);
  const both = (a: string, b: string) =>
    json([
      { id: "a", title: "first", status: a },
      { id: "b", title: "second", status: b },
    ]);
  render(<TaskBoard />);
  calls[0]?.answer(both("todo", "todo"));
  const [moveFirst, moveSecond] = await screen.findAllByRole("button", { name: "In progress" });
  // Two moves, each followed by a reload; the second reload answers before the first.
  fireEvent.click(moveFirst as HTMLElement);
  await waitFor(() => expect(calls).toHaveLength(2));
  calls[1]?.answer(json({}));
  await waitFor(() => expect(calls).toHaveLength(3));
  fireEvent.click(moveSecond as HTMLElement);
  await waitFor(() => expect(calls).toHaveLength(4));
  calls[3]?.answer(json({}));
  await waitFor(() => expect(calls).toHaveLength(5));
  calls[4]?.answer(both("in_progress", "in_progress"));
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Done" })).toHaveLength(2));
  calls[2]?.answer(both("in_progress", "todo"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.getAllByRole("button", { name: "Done" })).toHaveLength(2);
});

it("adding a task clears the form and reloads the list", async () => {
  let tasks: unknown[] = [];
  const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      tasks = [{ id: "a", title: "ship it", status: "todo" }];
      return json(tasks[0], 201);
    }
    return json(tasks);
  });
  vi.stubGlobal("fetch", fetch);
  render(<TaskBoard />);
  const input = (await screen.findByRole("textbox")) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "ship it" } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
  expect(await screen.findByText("ship it")).toBeTruthy();
  expect(input.value).toBe("");
});

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

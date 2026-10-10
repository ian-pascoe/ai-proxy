import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { WorkerEnv } from "../src/platform/env.ts";
import { runScheduledTasks, type ScheduledTask, scheduledTasks } from "../src/scheduled.ts";

const ctx = {} as unknown as ExecutionContext;

describe("scheduled dispatch", () => {
  it("registers the model catalog refresh", () => {
    expect(scheduledTasks.map((task) => task.name)).toContain("model-catalog-refresh");
  });

  it("runs every task in order, gives them the invocation's bindings and isolates failures", async () => {
    const log: string[] = [];

    const tasks: ScheduledTask[] = [
      { name: "first", run: Effect.sync(() => void log.push("first")) },
      { name: "boom", run: Effect.fail(new Error("boom")) },
      { name: "defect", run: Effect.die("defect") },
      {
        name: "last",
        run: Effect.gen(function* () {
          const bindings = yield* WorkerEnv;
          log.push(bindings === env ? "last:env" : "last:other-env");
        }),
      },
    ];

    await runScheduledTasks(tasks, env, ctx);
    expect(log).toEqual(["first", "last:env"]);
  });
});

import api from "./api.ts";
import { advanceBatchRun } from "./batch-runner.ts";
import { drain, startRun, sweepEngine } from "./runner.ts";
import { verifyAccess } from "./access.ts";
import type { Env } from "./types.ts";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return api.fetch(request, env, ctx);
    }

    // The dashboard itself is gated too, so an unauthenticated hit never sees
    // the shell of the app, only a 401.
    if (!(await verifyAccess(request, env))) {
      return new Response("Unauthorized. Sign in through Cloudflare Access.", {
        status: 401,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === env.SWEEP_CRON) {
      const open = await env.DB.prepare(
        "SELECT id FROM runs WHERE status IN ('running','processing','judging') LIMIT 1",
      ).first();
      if (open) {
        console.log("sweep skipped: previous run still in progress");
        return;
      }
      const { runId, taskCount } = await startRun(env, "cron");
      console.log(`sweep ${runId} opened with ${taskCount} tasks`);
      return;
    }
    // Both engines are advanced every tick: a batch run may be in flight while
    // an older synchronous run is still draining.
    ctx.waitUntil(
      Promise.allSettled([
        advanceBatchRun(env).then((m) => console.log(m)),
        drain(env).then((r) =>
          console.log(`drain claimed=${r.claimed} done=${r.done} errors=${r.errors}`),
        ),
      ]),
    );
  },
};

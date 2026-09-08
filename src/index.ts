import api from "./api";
import { drain, startRun } from "./runner";
import { verifyAccess } from "./access";
import type { Env } from "./types";

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
      const open = await env.DB.prepare("SELECT id FROM runs WHERE status = 'running' LIMIT 1").first();
      if (open) {
        console.log("sweep skipped: previous run still in progress");
        return;
      }
      const { runId, taskCount } = await startRun(env, "cron");
      console.log(`sweep ${runId} opened with ${taskCount} tasks`);
      return;
    }
    ctx.waitUntil(
      drain(env).then((r) =>
        console.log(`drain claimed=${r.claimed} done=${r.done} errors=${r.errors}`),
      ),
    );
  },
};

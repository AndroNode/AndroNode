import { Container, getRandom } from "@cloudflare/containers";

interface Env {
  VERIFIER: DurableObjectNamespace<VerifierContainer>;
  VERIFIER_TOKEN: string;
}

/** Python ONNX verifier in a Cloudflare Container. No internet access: the model is baked into the image. */
export class VerifierContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "15m";
  enableInternet = false;
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = { VERIFIER_TOKEN: env.VERIFIER_TOKEN, THREADS: "2" };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/health") {
      const given = req.headers.get("authorization") ?? "";
      if (!env.VERIFIER_TOKEN || given !== `Bearer ${env.VERIFIER_TOKEN}`) return new Response("unauthorized", { status: 401 });
    }
    const instance = await getRandom(env.VERIFIER, 2);
    return instance.fetch(req);
  },
} satisfies ExportedHandler<Env>;

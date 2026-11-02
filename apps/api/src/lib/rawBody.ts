import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/**
 * Keep the exact request bytes for JSON bodies in this (encapsulated) scope, so webhook signatures
 * can be verified over what was actually sent. Call inside a route plugin, before its routes.
 */
export function keepRawJson(scope: FastifyInstance) {
  scope.removeContentTypeParser("application/json");
  scope.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const text = body as string;
    req.rawBody = text;
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error("Invalid JSON body") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
}

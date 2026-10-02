/**
 * The Express app: security headers, CORS, body parsing, rate limits, routers, errors.
 *
 * Order matters here and is not arbitrary. Helmet before anything can respond, CORS
 * before routes so preflights are answered, cookie parsing before the CSRF check that
 * depends on it, rate limits before handlers, and the error middleware last.
 */
import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { env, isProduction, isTest } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { globalLimiter } from "./middleware/rate-limit.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { walletRouter } from "./modules/wallet/wallet.routes.js";
import { slotsRouter } from "./modules/slots/slots.routes.js";
import { vipRouter } from "./modules/vip/vip.routes.js";
import { sportsRouter } from "./modules/sports/sports.routes.js";
import { pokerRouter } from "./modules/poker/poker.routes.js";
import { adminRouter } from "./modules/admin/admin.routes.js";

export function createApp(): Express {
  const app = express();

  // Behind a TLS-terminating proxy, req.ip must come from X-Forwarded-For or every
  // per-IP rate limit would see the proxy's address and throttle everyone together.
  if (env.TRUST_PROXY) app.set("trust proxy", 1);

  // Belt and braces for chip amounts. Services already serialise bigint to strings; if
  // one ever slips through, this keeps it exact rather than throwing or rounding.
  app.set("json replacer", (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString(10) : value,
  );

  app.disable("x-powered-by");

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // The API serves JSON only; nothing it returns should ever be rendered.
          scriptSrc: ["'none'"],
          styleSrc: ["'none'"],
          imgSrc: ["'none'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
          connectSrc: ["'self'"],
        },
      },
      // 180 days with subdomains and preload, per the PRD's HSTS requirement. Browsers
      // ignore it over plain http, so this is harmless in development.
      hsts: { maxAge: 15_552_000, includeSubDomains: true, preload: true },
      crossOriginResourcePolicy: { policy: "same-site" },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );

  app.use(
    cors({
      // Exactly the frontend origin, never a wildcard: credentialed requests require it,
      // and a wildcard would let any site call the API with the user's cookie.
      origin: env.WEB_ORIGIN,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
      maxAge: 86_400,
    }),
  );

  // A slot config is a few KB; nothing legitimate here is larger than this.
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());

  if (!isTest) {
    app.use(
      pinoHttp({
        logger,
        // Health checks would otherwise bury everything else.
        autoLogging: { ignore: (request) => request.url === "/api/health" },
      }),
    );
  }

  app.use(globalLimiter);

  app.get("/api/health", (_request, response) => {
    response.json({
      status: "ok",
      provider: env.DATABASE_PROVIDER,
      redis: env.REDIS_URL ? "external" : "in-process",
      environment: env.NODE_ENV,
    });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/wallet", walletRouter);
  app.use("/api/slots", slotsRouter);
  app.use("/api/vip", vipRouter);
  app.use("/api/sports", sportsRouter);
  app.use("/api/poker", pokerRouter);
  app.use("/api/admin", adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  if (!isProduction) {
    logger.debug({ origin: env.WEB_ORIGIN }, "app configured");
  }

  return app;
}

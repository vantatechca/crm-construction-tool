// server/index.ts
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import authRouter from "./auth";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { config } from "dotenv";
import voice_AI_CallRouter from "./routes/twilio-call.route";
import { loadUser } from "./middleware/auth";
import path from "path";
import { spamPatternLearning } from "./services/spamPatternLearning";
import twoFactorRoutes from "./routes/2fa";
import passport from "./config/passport";
import cors from "cors";
import { trackSessionActivity } from "./middleware/session-activity";
import fs from "fs";

// Import pool from db.ts
import { pool } from "./db";

config();

// ✅ SMART ENVIRONMENT DETECTION
const isNgrok = process.env.NGROK_MODE === "true";
const isProduction = process.env.NODE_ENV === "production";
const mode = isNgrok ? "NGROK" : isProduction ? "PRODUCTION" : "DEVELOPMENT";

console.log(`🚀 Starting server in ${mode} mode`);

// Database connection monitoring
pool.on("error", (err) => {
  console.error("❌ Unexpected database error:", err);
  if (err.message?.includes("ENOTFOUND")) {
    console.error("💡 Database hostname cannot be resolved");
    console.error("💡 If using Neon free tier, check if database is suspended");
  }
});

pool.query("SELECT NOW()", (err, res) => {
  if (err) {
    console.error("❌ Database connection failed:", err.message);
    if (err.message?.includes("ENOTFOUND")) {
      console.error("💡 Cannot resolve database hostname");
      console.error("💡 Check your DATABASE_URL in .env");
    }
  } else {
    console.log("✅ Database connected successfully");
  }
});

const app = express();

// Lightweight liveness endpoint for Render. Keep this independent of optional
// integrations so deploy health checks only reflect whether the web process is up.
app.get("/api/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});


// Always trust proxy for ngrok and production (Render)
app.set("trust proxy", 1);

// ✅ SMART CORS CONFIGURATION
app.use(
  cors({
    origin: isNgrok
      ? true // Allow all origins for ngrok testing
      : isProduction
      ? process.env.FRONTEND_URL || false // Specific origin in production
      : "http://localhost:5000", // Local dev
    credentials: true,
  })
);

// Stripe needs the untouched request body for signature verification. Keep the
// rest of the app available for local testing when Stripe is not configured.
if (process.env.STRIPE_SECRET_KEY) {
  const { default: stripeWebhookRouter } = await import(
    "./routes/stripe-webhook"
  );
  app.use(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    stripeWebhookRouter
  );
} else {
  app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    (_req, res) => res.status(503).json({ error: "Stripe is not configured" })
  );
}

// Twilio webhook (raw body)
app.use("/api/twilioCall_webhook", express.raw({ type: "application/json" }));

// Standard middleware
app.use(express.json());
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
app.use(express.urlencoded({ extended: true }));

// ✅ SMART SESSION CONFIGURATION
const PgSession = connectPgSimple(session);

app.use("/api/twilioCall_webhook", voice_AI_CallRouter);

app.use(
  session({
    store: new PgSession({
      pool: pool as any,
      tableName: "sessions",
      createTableIfMissing: true,
      pruneSessionInterval: 60 * 60, // 1 hour
    }),
    secret: process.env.SESSION_SECRET || "change-this-secret-in-production",
    resave: false,
    saveUninitialized: false,
    rolling: true, // ✅ Refresh session on every request
    name: "sessionId",
    proxy: true, // ✅ Important for production proxies
    cookie: {
      secure: isProduction || isNgrok, // ✅ HTTPS in production/ngrok
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // ✅ 30 days default
      sameSite: isProduction || isNgrok ? "none" : "lax",
      path: "/",
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());
app.use(loadUser);
app.use(trackSessionActivity);

// Routes
app.use(authRouter);
app.use(twoFactorRoutes);

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      console.log(logLine);
    }
  });

  next();
});

(async () => {
  console.log("🚀 Initializing services...");

  try {
    await spamPatternLearning.initialize();
    console.log("✅ Spam pattern learning initialized");
  } catch (error) {
    console.error("❌ Failed to initialize spam pattern learning:", error);
  }

  // ✅ NEW: Initialize AI health monitor
  try {
    const { aiHealthMonitor } = await import("./services/ai-health-monitor");
    aiHealthMonitor.start();
    console.log("✅ AI health monitor initialized");
  } catch (error) {
    console.error("❌ Failed to initialize AI health monitor:", error);
  }

  // ✅ NEW: Initialize AI retry worker
  try {
    const { aiRetryWorker } = await import("./services/ai-retry-worker");
    aiRetryWorker.start();
    console.log("✅ AI retry worker initialized");
  } catch (error) {
    console.error("❌ Failed to initialize AI retry worker:", error);
  }

  // SESSION CLEANUP CRON 
  const { sessionManager } = await import("./services/session-manager");
  
  // Session cleanup cron (runs every hour)
  setInterval(async () => {
    try {
      console.log("🧹 Running session cleanup...");
      await sessionManager.cleanupExpiredSessions();
    } catch (error) {
      console.error("❌ Session cleanup error:", error);
    }
  }, 60 * 60 * 1000); // Every hour

  console.log("✅ Session cleanup cron started");

 const server = await registerRoutes(app);

console.log("📋 ========================================\n");

  // Error handler
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    res.status(status).json({ message });
    console.error(err);
  });

  // Serve static files in production
  if (process.env.NODE_ENV === "production") {
    // Serve frontend build
    const publicPath = path.join(process.cwd(), "dist", "public");
    
    if (fs.existsSync(publicPath)) {
      app.use(express.static(publicPath));
      app.get("*", (_req: Request, res: Response) => {
        res.sendFile(path.join(publicPath, "index.html"));
      });
      console.log("✅ Serving static files from:", publicPath);
    } else {
      console.log("⚠️ No frontend build found - backend only mode");
    }
  } else {
    // Development mode - setup Vite
    try {
      const vite = await import("./vite.js");
      await vite.setupVite(app, server);
    } catch (error) {
      console.error("❌ Failed to setup Vite:", error);
    }
  }

   const PORT = parseInt(process.env.PORT || "5000", 10);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Environment: ${mode}`);
    console.log(`🔐 Session store: PostgreSQL`);
    console.log(`🧠 AI Pattern Learning: Active`);
    console.log(`🔌 WebSocket server: Initialized`);
    
    if (isNgrok) {
      console.log(`🌐 NGROK MODE - Ready for WhatsApp webhook testing`);
      console.log(`🔗 Set webhook to: https://YOUR-NGROK-URL.ngrok-free.app/api/whatsapp/webhook`);
    } else if (isProduction) {
      console.log(`🌍 PRODUCTION MODE - CORS: ${process.env.FRONTEND_URL}`);
    } else {
      console.log(`🛠️ DEVELOPMENT MODE - Local testing only`);
    }
  });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.log("⚠️ SIGTERM signal received: closing HTTP server");
    server.close(() => {
      console.log("✅ HTTP server closed");
      process.exit(0);
    });
  });
})();

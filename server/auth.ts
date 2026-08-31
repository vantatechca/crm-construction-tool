// server/auth.ts
import { Router } from "express";
import { db } from "./db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcrypt";
import passport, { googleOAuthConfigured } from "./config/passport";
import { sessionManager } from "./services/session-manager";

const router = Router();
const SALT_ROUNDS = 10;
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5000";

const googleUnavailable = (_req: any, res: any) =>
  res.status(503).json({ error: "Google OAuth is not configured" });

// Signup
router.post("/api/auth/signup", async (req, res) => {
  try {
    console.log("=== SIGNUP DEBUG ===");
    console.log("Request body:", req.body);

    const { email, password, firstName, lastName } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "Password must be at least 8 characters",
      });
    }

    // Check if user exists
    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()));

    if (existingUser) {
      return res.status(400).json({ error: "Email already registered" });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Create user
    const [newUser] = await db
      .insert(users)
      .values({
        email: email.toLowerCase(),
        passwordHash: passwordHash,
        firstName: firstName || null,
        lastName: lastName || null,
        role: "user",
        emailVerified: false,
      })
      .returning();

    // ✅ SEND VERIFICATION EMAIL
    try {
      const { sendVerificationEmail } = await import(
        "./services/email-verification"
      );
      await sendVerificationEmail(
        newUser.email!,
        newUser.id,
        newUser.firstName || "User"
      );
      console.log(`✅ Verification email sent to: ${newUser.email}`);
    } catch (emailError) {
      console.error("⚠️ Failed to send verification email:", emailError);
      // Don't fail signup if email fails
    }

    // ✅ Store session metadata with device tracking
    (req.session as any).userId = newUser.id;
    (req.session as any).createdAt = new Date().toISOString();
    (req.session as any).userAgent = req.headers["user-agent"];
    (req.session as any).ipAddress = req.ip || req.headers["x-forwarded-for"];
    (req.session as any).deviceInfo = sessionManager.parseUserAgent(
      req.headers["user-agent"] || ""
    );

    // Save session
    req.session.save((err) => {
      if (err) {
        console.error("❌ Session save error:", err);
        return res.status(500).json({ error: "Failed to create session" });
      }

      console.log("✅ User created and session saved:", newUser.email);

      res.json({
        user: {
          id: newUser.id,
          email: newUser.email,
          firstName: newUser.firstName,
          lastName: newUser.lastName,
          role: newUser.role,
          emailVerified: newUser.emailVerified,
        },
      });
    });
  } catch (error: any) {
    console.error("Signup error:", error);
    res.status(500).json({ error: "Signup failed" });
  }
});

// 🆕 Login - Step 1: Verify credentials
router.post("/api/auth/login", async (req, res) => {
  try {
    console.log("=== LOGIN BACKEND DEBUG ===");
    const { email, password, rememberMe } = req.body; // ✅ Add rememberMe

    if (!email || !password) {
      console.log("❌ Missing credentials");
      return res.status(400).json({ error: "Email and password required" });
    }

    // Find user
    console.log("🔍 Looking up user:", email.toLowerCase());
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()));

    if (!user || !user.passwordHash) {
      console.log("❌ User not found or no password hash");
      return res.status(401).json({ error: "Invalid credentials" });
    }

    console.log("✅ User found:", user.email);

    // Verify password
    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      console.log("❌ Password incorrect");
      return res.status(401).json({ error: "Invalid credentials" });
    }

    console.log("✅ Password valid");

    // 🆕 CHECK IF 2FA IS ENABLED
    if (user.twoFactorEnabled) {
      console.log("🔐 2FA required for user:", user.email);

      // Store user ID temporarily for 2FA verification
      (req.session as any).pending2FAUserId = user.id;

      await new Promise((resolve, reject) => {
        req.session.save((err) => {
          if (err) reject(err);
          else resolve(true);
        });
      });

      // Don't create full session yet, return 2FA required
      return res.json({
        requires2FA: true,
        userId: user.id,
        email: user.email,
        message: "Please enter your 2FA code",
      });
    }

    // 🔓 NO 2FA - Complete login immediately

    // ✅ Set session expiry based on rememberMe
    if (rememberMe) {
      req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
      console.log("✅ Remember me enabled: 30 days session");
    } else {
      req.session.cookie.maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
      console.log("✅ Standard session: 7 days");
    }

    // ✅ Store session metadata with device tracking
    (req.session as any).userId = user.id;
    (req.session as any).createdAt = new Date().toISOString();
    (req.session as any).userAgent = req.headers["user-agent"];
    (req.session as any).ipAddress = req.ip || req.headers["x-forwarded-for"];
    (req.session as any).deviceInfo = sessionManager.parseUserAgent(
      req.headers["user-agent"] || ""
    );

    // Update login stats
    await db
      .update(users)
      .set({
        lastLoginAt: new Date(),
        loginCount: (user.loginCount || 0) + 1,
      })
      .where(eq(users.id, user.id));

    req.session.save((err) => {
      if (err) {
        console.error("❌ Session save error:", err);
        return res.status(500).json({ error: "Failed to create session" });
      }

      console.log("✅ Login successful (no 2FA)!");

      res.json({
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          phone: user.phone,
          role: user.role,
          emailVerified: user.emailVerified,
          isTrialActive: user.isTrialActive,
          trialEndsAt: user.trialEndsAt,
          twoFactorEnabled: user.twoFactorEnabled,
        },
        sessionExpiry: req.session.cookie.maxAge,
      });
    });
  } catch (error: any) {
    console.error("❌ Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

// 🆕 Login - Step 2: Verify 2FA code and complete login
router.post("/api/auth/verify-2fa", async (req, res) => {
  try {
    const { userId, code, useBackupCode, rememberMe } = req.body; // ✅ Add rememberMe

    if (!userId || !code) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Verify the pending 2FA matches
    const pendingUserId = (req.session as any).pending2FAUserId;
    if (pendingUserId !== userId) {
      return res.status(401).json({ error: "Invalid session" });
    }

    // Get user
    const [user] = await db.select().from(users).where(eq(users.id, userId));

    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      return res.status(400).json({ error: "2FA not enabled" });
    }

    // Verify 2FA code
    const { verify2FACode, verifyBackupCode, decrypt2FASecret } = await import(
      "./services/2fa-service"
    );

    let isValid = false;

    if (useBackupCode) {
      const result = await verifyBackupCode(
        user.twoFactorBackupCodes as string[],
        code
      );
      isValid = result.valid;

      if (isValid) {
        await db
          .update(users)
          .set({
            twoFactorBackupCodes: result.remainingCodes,
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));

        console.log(
          "✅ Backup code used. Remaining:",
          result.remainingCodes.length
        );
      }
    } else {
      const decryptedSecret = decrypt2FASecret(user.twoFactorSecret);
      isValid = verify2FACode(decryptedSecret, code);
    }

    if (!isValid) {
      console.log("❌ Invalid 2FA code for user:", userId);
      return res.status(401).json({ error: "Invalid verification code" });
    }

    console.log("✅ 2FA verification successful");

    // ✅ Set session expiry based on rememberMe
    if (rememberMe) {
      req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
      console.log("✅ Remember me enabled: 30 days session");
    } else {
      req.session.cookie.maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
      console.log("✅ Standard session: 7 days");
    }

    // ✅ Store session metadata
    (req.session as any).createdAt = new Date().toISOString();
    (req.session as any).userAgent = req.headers["user-agent"];
    (req.session as any).ipAddress = req.ip || req.headers["x-forwarded-for"];
    (req.session as any).deviceInfo = sessionManager.parseUserAgent(
      req.headers["user-agent"] || ""
    );

    // Update login stats
    await db
      .update(users)
      .set({
        lastLoginAt: new Date(),
        loginCount: (user.loginCount || 0) + 1,
      })
      .where(eq(users.id, userId));

    // Clear pending 2FA and create full session
    delete (req.session as any).pending2FAUserId;
    (req.session as any).userId = user.id;

    req.session.save((err) => {
      if (err) {
        console.error("❌ Session save error:", err);
        return res.status(500).json({ error: "Failed to create session" });
      }

      console.log("✅ 2FA login complete!");

      res.json({
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          phone: user.phone,
          role: user.role,
          emailVerified: user.emailVerified,
          isTrialActive: user.isTrialActive,
          trialEndsAt: user.trialEndsAt,
          twoFactorEnabled: user.twoFactorEnabled,
        },
        sessionExpiry: req.session.cookie.maxAge,
      });
    });
  } catch (error: any) {
    console.error("❌ 2FA verification error:", error);
    res.status(500).json({ error: "2FA verification failed" });
  }
});

// Logout
router.post("/api/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: "Logout failed" });
    }
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

// Get current user
router.get("/api/auth/me", async (req, res) => {
  try {
    const userId = (req.session as any).userId;

    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const [user] = await db.select().from(users).where(eq(users.id, userId));

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        profileImageUrl: user.profileImageUrl,
        role: user.role,
        emailVerified: user.emailVerified,
        isTrialActive: user.isTrialActive,
        trialEndsAt: user.trialEndsAt,
        twoFactorEnabled: user.twoFactorEnabled,
        passwordHash: user.passwordHash,
        oauthProvider: user.oauthProvider,
        googleId: user.googleId,

        // notification preferences
        emailNotifications: user.emailNotifications ?? true,
        whatsappNotifications: user.whatsappNotifications ?? false,
        leadNotifications: user.leadNotifications ?? true,
        bookingNotifications: user.bookingNotifications ?? true,
        weeklyReports: user.weeklyReports ?? true,

        // Settings JSONB (for regional preferences)
        settings: user.settings || {
          regional: {
            timezone: "UTC",
            language: "en",
          },
        },
      },
    });
  } catch (error: any) {
    console.error("Get user error:", error);
    res.status(500).json({ error: "Failed to get user" });
  }
});

// ==================== GOOGLE OAUTH ROUTES ====================

// OAuth Init Route - Track referrer
router.get("/api/auth/google/init", (req, res) => {
  const referrer = (req.query.referrer as string) || "unknown";
  (req.session as any).oauthReferrer = referrer;

  console.log(`🔐 OAuth initiated from: ${referrer}`);

  req.session.save((err) => {
    if (err) {
      console.error("❌ Session save error:", err);
      return res.redirect("/login?error=session_failed");
    }

    res.redirect("/api/auth/google");
  });
});

// Initiate Google OAuth
router.get(
  "/api/auth/google",
  googleOAuthConfigured
    ? passport.authenticate("google", { scope: ["profile", "email"] })
    : googleUnavailable
);

// Google OAuth callback
router.get(
  "/api/auth/google/callback",
  googleOAuthConfigured
    ? passport.authenticate("google", {
        failureRedirect: `${frontendUrl}/login?error=google_auth_failed`,
      })
    : googleUnavailable,
  (req, res) => {
    const user = req.user as any;

    if (!user) {
      console.error("❌ No user returned from Google OAuth");
      return res.redirect(
        `${frontendUrl}/login?error=auth_failed`
      );
    }

    // ✅ Get auth type and referrer
    const authType = user._authType || "unknown";
    const referrer = (req.session as any).oauthReferrer || "unknown";

    console.log(`🔐 OAuth completed:`, {
      authType,
      referrer,
      email: user.email,
    });

    // ✅ Set session with device tracking (OAuth users get 30 days by default)
    (req.session as any).userId = user.id;
    (req.session as any).createdAt = new Date().toISOString();
    (req.session as any).userAgent = req.headers["user-agent"];
    (req.session as any).ipAddress = req.ip || req.headers["x-forwarded-for"];
    (req.session as any).deviceInfo = sessionManager.parseUserAgent(
      req.headers["user-agent"] || ""
    );

    // OAuth users get 30-day sessions by default
    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;

    // ✅ Clear OAuth referrer
    delete (req.session as any).oauthReferrer;

    req.session.save((err) => {
      if (err) {
        console.error("❌ Session save error:", err);
        return res.redirect(
          `${frontendUrl}/login?error=session_failed`
        );
      }

      // ✅ Redirect to FRONTEND with appropriate message
      let redirectPath = "/dashboard";

      switch (authType) {
        case "new_oauth_signup":
          redirectPath += "?auth=signup_success";
          break;
        case "returning_oauth_login":
          redirectPath += "?auth=login_success";
          break;
        case "oauth_account_linked":
          redirectPath += "?auth=account_linked";
          break;
        default:
          redirectPath += "?auth=success";
      }

      const fullRedirectUrl = `${frontendUrl}${redirectPath}`;
      console.log(`✅ Google OAuth success, redirecting to: ${fullRedirectUrl}`);
      res.redirect(fullRedirectUrl);
    });
  }
);

export default router;

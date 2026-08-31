// server/config/passport.ts
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { db } from "../db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";

// ✅ DYNAMIC CALLBACK URL DETECTION
const getCallbackURL = (): string => {
  // Priority 1: Use explicit GOOGLE_CALLBACK_URL if set
  if (process.env.GOOGLE_CALLBACK_URL) {
    console.log("📍 Using explicit GOOGLE_CALLBACK_URL");
    return process.env.GOOGLE_CALLBACK_URL;
  }

  // Priority 2: Construct from BASE_URL
  if (process.env.BASE_URL) {
    const url = `${process.env.BASE_URL}/api/auth/google/callback`;
    console.log("📍 Constructing callback URL from BASE_URL");
    return url;
  }

  // Priority 3: Construct from FRONTEND_URL (fallback)
  if (process.env.FRONTEND_URL) {
    const url = `${process.env.FRONTEND_URL}/api/auth/google/callback`;
    console.log("📍 Constructing callback URL from FRONTEND_URL");
    return url;
  }

  // Priority 4: Detect from NODE_ENV
  // Production deployments should always set BASE_URL or
  // GOOGLE_CALLBACK_URL explicitly. This fallback keeps local testing local.
  console.log("📍 Using localhost default URL");
  return "http://localhost:5000/api/auth/google/callback";
};

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const GOOGLE_CALLBACK_URL = getCallbackURL(); // ✅ Dynamic detection
export const googleOAuthConfigured = Boolean(
  GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET
);

// ✅ Enhanced logging
console.log("🔐 [GOOGLE OAUTH] Configuration:");
console.log("  Client ID:", GOOGLE_CLIENT_ID ? "✅ Set" : "❌ Missing");
console.log("  Client Secret:", GOOGLE_CLIENT_SECRET ? "✅ Set" : "❌ Missing");
console.log("  Callback URL:", GOOGLE_CALLBACK_URL);
console.log("  Environment:", process.env.NODE_ENV || "development");
console.log("  BASE_URL:", process.env.BASE_URL || "not set");

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.warn("⚠️ Google OAuth credentials missing in .env");
}

// ✅ Serialize user - use string ID
passport.serializeUser((user: Express.User, done) => {
  done(null, user.id);
});

// ✅ Deserialize user - return full user object
passport.deserializeUser(async (id: string, done) => {
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    done(null, user || undefined);
  } catch (error) {
    done(error, undefined);
  }
});

// Google OAuth Strategy
if (googleOAuthConfigured) passport.use(
  new GoogleStrategy(
    {
      clientID: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackURL: GOOGLE_CALLBACK_URL, // ✅ Using dynamic URL
      scope: ["profile", "email"],
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        console.log("🔍 [GOOGLE OAUTH] Callback received");
        console.log("  Profile email:", profile.emails?.[0]?.value);
        console.log("  Google ID:", profile.id);

        const googleEmail = profile.emails?.[0]?.value?.toLowerCase();
        const googleId = profile.id;

        if (!googleEmail) {
          console.error("❌ No email from Google profile");
          return done(new Error("No email from Google"), undefined);
        }

        // Check if user exists by Google ID
        let [existingUser] = await db
          .select()
          .from(users)
          .where(eq(users.googleId, googleId));

        if (existingUser) {
          console.log("✅ Existing Google user found:", existingUser.email);

          // ✅ Prepare update data
          const updateData: any = {
            lastLoginAt: new Date(),
            loginCount: (existingUser.loginCount || 0) + 1,
            updatedAt: new Date(),
          };

          // ✅ Only update profile picture if:
          // 1. User has NO profile picture, OR
          // 2. Current profile picture is still from Google (not uploaded)
          const hasCustomImage =
            existingUser.profileImageUrl &&
            existingUser.profileImageUrl.includes("cloudinary.com");

          if (!hasCustomImage) {
            // User has no image or still using Google image - update it
            updateData.profileImageUrl = profile.photos?.[0]?.value; // ✅ Correct
            console.log("🖼️ Updating profile picture from Google");
          } else {
            // User has custom uploaded image - don't touch it
            console.log("🖼️ Keeping custom uploaded profile picture");
          }

          await db
            .update(users)
            .set(updateData)
            .where(eq(users.id, existingUser.id));

          // ✅ Mark as returning user
          (existingUser as any)._authType = "returning_oauth_login";
          console.log("🔄 Auth type: returning_oauth_login");

          return done(null, existingUser);
        }

        // Check if user exists with same email
        [existingUser] = await db
          .select()
          .from(users)
          .where(eq(users.email, googleEmail));

        if (existingUser) {
          console.log("🔗 Linking Google to existing account:", googleEmail);

          const [updatedUser] = await db
            .update(users)
            .set({
              googleId: googleId,
              oauthProvider: "google",
              emailVerified: true,
              profileImageUrl: profile.photos?.[0]?.value,
              lastLoginAt: new Date(),
              loginCount: (existingUser.loginCount || 0) + 1,
              updatedAt: new Date(),
            })
            .where(eq(users.id, existingUser.id))
            .returning();

          // Mark as account linking
          (updatedUser as any)._authType = "oauth_account_linked";
          console.log("🔗 Auth type: oauth_account_linked");

          return done(null, updatedUser);
        }

        // Create new user
        console.log("🆕 Creating new Google user:", googleEmail);

        const [newUser] = await db
          .insert(users)
          .values({
            email: googleEmail,
            googleId: googleId,
            oauthProvider: "google",
            firstName: profile.name?.givenName || null,
            lastName: profile.name?.familyName || null,
            profileImageUrl: profile.photos?.[0]?.value,
            emailVerified: true,
            role: "user",
            loginCount: 1,
            lastLoginAt: new Date(),
          })
          .returning();

        console.log("✅ New Google user created:", newUser.email);

        // Mark as new signup
        (newUser as any)._authType = "new_oauth_signup";
        console.log("🆕 Auth type: new_oauth_signup");

        return done(null, newUser);
      } catch (error: any) {
        console.error("❌ [GOOGLE OAUTH] Error:", error);
        return done(error, undefined);
      }
    }
  )
);

export default passport;

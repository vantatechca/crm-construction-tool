// sever/shared/schema.ts

import { sql } from "drizzle-orm";
import { relations } from "drizzle-orm";
import {
  pgTable,
  varchar,
  text,
  timestamp,
  integer,
  decimal,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Session storage table (required for auth)
export const sessions = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)]
);

// Users table
export const users = pgTable("users", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  email: varchar("email").unique(),
  passwordHash: text("password_hash"),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  phone: varchar("phone"),
  profileImageUrl: varchar("profile_image_url"),
  role: varchar("role").default("user"), // user, super_admin

  // OAuth fields
  googleId: text("google_id").unique(),
  oauthProvider: text("oauth_provider"),

  // Email Verification
  emailVerified: boolean("email_verified").default(false).notNull(),
  verificationToken: text("verification_token"),
  passwordResetToken: text("password_reset_token"),
  passwordResetExpiry: timestamp("password_reset_expiry"),

  // 🆕 Two-Factor Authentication
  twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
  twoFactorSecret: text("two_factor_secret"),
  twoFactorBackupCodes: jsonb("two_factor_backup_codes").default(
    sql`'[]'::jsonb`
  ),

  // Subscription
  stripeCustomerId: varchar("stripe_customer_id"),
  subscriptionType: varchar("subscription_type").default("trial"), // trial, pro, enterprise
  trialEndsAt: timestamp("trial_ends_at"),
  isTrialActive: boolean("is_trial_active").default(false),
  hasUnlockedTrial: boolean("has_unlocked_trial").default(false),

  // Activity
  lastLoginAt: timestamp("last_login_at"),
  loginCount: integer("login_count").default(0),
  isActive: boolean("is_active").default(true),
  settings: jsonb("settings").default(sql`'{}'::jsonb`),

  emailNotifications: boolean("email_notifications").default(true),
  whatsappNotifications: boolean("whatsapp_notifications").default(false),
  leadNotifications: boolean("lead_notifications").default(true),
  bookingNotifications: boolean("booking_notifications").default(true),
  weeklyReports: boolean("weekly_reports").default(true),

  // Timestamps
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Subscriptions table
export const subscriptions = pgTable("subscriptions", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  userId: varchar("user_id")
    .references(() => users.id)
    .notNull(),

  // Stripe IDs
  stripeCustomerId: varchar("stripe_customer_id").unique(),
  stripeSubscriptionId: varchar("stripe_subscription_id").unique(),
  stripePriceId: varchar("stripe_price_id"),

  // Subscription details
  plan: varchar("plan").notNull(), // starter, professional, enterprise
  billingPeriod: varchar("billing_period").notNull(), // monthly, yearly
  status: varchar("status").notNull(), // active, canceled, past_due, trialing

  // Pricing
  amount: integer("amount").notNull(), // in cents
  currency: varchar("currency").default("usd"),

  // Dates
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false),
  canceledAt: timestamp("canceled_at"),

  // Trial
  trialStart: timestamp("trial_start"),
  trialEnd: timestamp("trial_end"),

  // Metadata
  metadata: jsonb("metadata").default({}),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Payment history table
export const payments = pgTable("payments", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  userId: varchar("user_id")
    .references(() => users.id)
    .notNull(),
  subscriptionId: varchar("subscription_id").references(() => subscriptions.id),

  // Stripe IDs
  stripePaymentIntentId: varchar("stripe_payment_intent_id").unique(),
  stripeInvoiceId: varchar("stripe_invoice_id"),

  // Payment details
  amount: integer("amount").notNull(), // in cents
  currency: varchar("currency").default("usd"),
  status: varchar("status").notNull(), // succeeded, pending, failed

  // Invoice
  invoiceUrl: varchar("invoice_url"),
  receiptUrl: varchar("receipt_url"),

  // Dates
  paidAt: timestamp("paid_at"),
  failedAt: timestamp("failed_at"),

  // Metadata
  description: text("description"),
  metadata: jsonb("metadata").default({}),

  createdAt: timestamp("created_at").defaultNow(),
});

export const subscriptionsRelations = relations(
  subscriptions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [subscriptions.userId],
      references: [users.id],
    }),
    payments: many(payments),
  })
);

export const paymentsRelations = relations(payments, ({ one }) => ({
  user: one(users, {
    fields: [payments.userId],
    references: [users.id],
  }),
  subscription: one(subscriptions, {
    fields: [payments.subscriptionId],
    references: [subscriptions.id],
  }),
}));

// Trial activations tracking
export const trialActivations = pgTable("trial_activations", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  userId: varchar("user_id")
    .references(() => users.id)
    .notNull(),
  activatedAt: timestamp("activated_at").defaultNow(),
  trialDays: integer("trial_days").default(14),
  source: varchar("source").default("dashboard"), // dashboard, landing, referral
  ipAddress: varchar("ip_address"),
  userAgent: text("user_agent"),
});

// User activity logs for super admin
export const userActivities = pgTable("user_activities", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  userId: varchar("user_id")
    .references(() => users.id)
    .notNull(),
  action: varchar("action").notNull(), // login, trial_activated, feature_used, etc.
  resource: varchar("resource"), // leads, clients, conversations, etc.
  details: jsonb("details"),
  ipAddress: varchar("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow(),
});

// System metrics for super admin dashboard
export const systemMetrics = pgTable("system_metrics", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  date: timestamp("date").defaultNow(),
  totalUsers: integer("total_users").default(0),
  activeTrials: integer("active_trials").default(0),
  expiredTrials: integer("expired_trials").default(0),
  totalClients: integer("total_clients").default(0),
  totalLeads: integer("total_leads").default(0),
  totalConversations: integer("total_conversations").default(0),
  avgResponseTime: decimal("avg_response_time", { precision: 8, scale: 2 }),
  conversionRate: decimal("conversion_rate", { precision: 5, scale: 4 }),
  createdAt: timestamp("created_at").defaultNow(),
});

// Clients table (multi-tenant)
export const clients = pgTable("clients", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: varchar("name").notNull(),
  industry: varchar("industry").notNull(),
  website: varchar("website"),
  phone: varchar("phone"),
  email: varchar("email"),
  whatsappNumber: varchar("whatsapp_number"),
  userId: varchar("user_id").references(() => users.id),
  isActive: boolean("is_active").default(true),
  settings: jsonb("settings").default({}),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  whatsappPhoneNumberId: text("whatsapp_phone_number_id"), // New field for WhatsApp Business API
});

// Leads table
export const leads = pgTable("leads", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  clientId: varchar("client_id")
    .references(() => clients.id)
    .notNull(),
  firstName: varchar("first_name"),
  lastName: varchar("last_name"),
  email: varchar("email").unique(),
  phone: varchar("phone").unique(),
  company: varchar("company"),
  source: varchar("source").default("landing_page"),
  status: varchar("status").default("new"), // new, qualified, hot, converted, lost, not-a-lead
  temperature: varchar("temperature").default("cold"),

  qualificationScore: decimal("qualification_score", {
    precision: 3,
    scale: 2,
  }).default("0.0"),
  auditResults: jsonb("audit_results"),
  utmData: jsonb("utm_data"),
  consentGiven: boolean("consent_given").default(false),
  responseTimeSeconds: integer("response_time_seconds"),
  manualScore: varchar("manual_score"), // Manual override score
  isManualOverride: boolean("is_manual_override").default(false),
  tags: jsonb("tags").default(sql`'[]'::jsonb`),
  internalNotes: text("internal_notes"),
  lastContactedAt: timestamp("last_contacted_at"),
  nextFollowUpAt: timestamp("next_follow_up_at"),

  submissionCount: integer("submission_count").default(1),
  lastSubmittedAt: timestamp("last_submitted_at").defaultNow(),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  viewedAt: timestamp("viewed_at"),
  callID: varchar("call_id"),
});

// Lead activity log table
export const leadActivityLog = pgTable("lead_activity_log", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  leadId: varchar("lead_id")
    .references(() => leads.id)
    .notNull(),
  userId: varchar("user_id").references(() => users.id),
  action: varchar("action").notNull(), // "score_changed", "status_changed", "tag_added", "note_added"
  fieldChanged: varchar("field_changed"), // "status", "score", "tags"
  oldValue: text("old_value"),
  newValue: text("new_value"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

// NEW TABLE: Lead Tags (predefined tags)
export const leadTags = pgTable("lead_tags", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  clientId: varchar("client_id")
    .references(() => clients.id)
    .notNull(),
  name: varchar("name").notNull(), // "urgent", "vip", "follow-up"
  color: varchar("color").notNull().default("blue"), // "red", "green", "blue", "yellow"
  icon: varchar("icon"), // Optional icon name
  createdAt: timestamp("created_at").defaultNow(),
});

// Conversations table
export const conversations = pgTable("conversations", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  leadId: varchar("lead_id")
    .references(() => leads.id)
    .notNull(),
  clientId: varchar("client_id")
    .references(() => clients.id)
    .notNull(),
  channel: varchar("channel").notNull(), // whatsapp, sms, email
  status: varchar("status").default("active"), // active, paused, completed
  isAiHandled: boolean("is_ai_handled").default(true),
  humanTakeoverAt: timestamp("human_takeover_at"),
  lastMessageAt: timestamp("last_message_at").defaultNow(),
  qualificationScore: decimal("qualification_score", {
    precision: 3,
    scale: 2,
  }).default("0.0"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  unreadCount: integer("unread_count").default(0),
  lastReadAt: timestamp("last_read_at"),
  reopenedAt: timestamp("reopened_at"),
});

// Messages table
export const messages = pgTable("messages", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  conversationId: varchar("conversation_id")
    .references(() => conversations.id)
    .notNull(),
  content: text("content").notNull(),
  sender: varchar("sender").notNull(), // ai, human, lead
  channel: varchar("channel").notNull(),
  messageType: varchar("message_type").default("text"), // text, image, video, template
  metadata: jsonb("metadata"),
  sentAt: timestamp("sent_at").defaultNow(),
  deliveredAt: timestamp("delivered_at"),
  readAt: timestamp("read_at"),
  isStatusMessage: boolean("is_status_message").default(false),

  reactions: jsonb("reactions").default(sql`'[]'::jsonb`), // array of emoji, userId, userName, timestamp
});

// Quick Reply Templates table
export const quickReplyTemplates = pgTable("quick_reply_templates", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  clientId: varchar("client_id")
    .references(() => clients.id)
    .notNull(),
  name: varchar("name").notNull(), // "Greeting - Morning"
  content: text("content").notNull(), // "Hi {firstName}! How can I help?"
  category: varchar("category").notNull(), // "greeting", "pricing", "booking", "follow-up"
  variables: jsonb("variables").default([]), // ["firstName", "company"]
  shortcut: varchar("shortcut"), // Optional: "/morning"
  usageCount: integer("usage_count").default(0),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type QuickReplyTemplate = typeof quickReplyTemplates.$inferSelect;
export type InsertQuickReplyTemplate = typeof quickReplyTemplates.$inferInsert;

// VSL (Video Sales Letter) table
export const vsls = pgTable("vsls", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  clientId: varchar("client_id")
    .references(() => clients.id)
    .notNull(),
  title: varchar("title").notNull(),
  script: text("script"),
  targetDuration: varchar("target_duration").default("2min"), // 30s, 1min, 2min, 3min, 5min
  subtitleType: varchar("subtitle_type", { 
    enum: ["none", "traditional", "karaoke"] 
  }).default("none"),
  videoUrl: varchar("video_url"),
  thumbnailUrl: varchar("thumbnail_url"),
  duration: integer("duration"), // in seconds
  viewCount: integer("view_count").default(0),
  conversionRate: decimal("conversion_rate", {
    precision: 5,
    scale: 2,
  }).default("0.0"),
  isActive: boolean("is_active").default(true),
  cloudinaryVideoId: varchar("cloudinary_video_id"),
  cloudinaryThumbnailId: varchar("cloudinary_thumbnail_id"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// VSL Analytics table - tracks video engagement
export const vslAnalytics = pgTable("vsl_analytics", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  vslId: varchar("vsl_id")
    .references(() => vsls.id, { onDelete: "cascade" })
    .notNull(),
  sessionId: varchar("session_id").notNull().unique(), 
  watchTime: integer("watch_time").default(0), 
  completed: boolean("completed").default(false), 
  completionPercentage: integer("completion_percentage").default(0), 
  ipAddress: varchar("ip_address"),
  userAgent: varchar("user_agent"), 
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Bookings table
export const bookings = pgTable("bookings", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  leadId: varchar("lead_id")
    .references(() => leads.id)
    .notNull(),
  clientId: varchar("client_id")
    .references(() => clients.id)
    .notNull(),

  // Meeting details
  title: text("title").notNull(),
  description: text("description"),
  location: text("location"),

  // Scheduling
  scheduledAt: timestamp("scheduled_at").notNull(), // Keep existing field name
  scheduledFor: timestamp("scheduled_for").notNull(), // Add new field for clarity
  duration: integer("duration").default(60), // changed from 30 to 60 minutes

  // Status
  status: varchar("status").default("scheduled"), // scheduled, confirmed, completed, cancelled, no_show

  // Attendee info
  attendeeEmail: varchar("attendee_email"),
  attendeeName: varchar("attendee_name"),
  attendeePhone: varchar("attendee_phone"),

  // Additional fields
  meetingType: varchar("meeting_type"), // site-visit, consultation, follow-up
  meetingUrl: varchar("meeting_url"),
  notes: text("notes"),
  reminderSent: boolean("reminder_sent").default(false),

  reminder24hSent: boolean("reminder_24h_sent").default(false),
  reminder1hSent: boolean("reminder_1h_sent").default(false),
  reminder24hSentAt: timestamp("reminder_24h_sent_at"),
  reminder1hSentAt: timestamp("reminder_1h_sent_at"),

  proposedBy: varchar("proposed_by"), // 'ai' or 'human'
  aiConfidence: decimal("ai_confidence", { precision: 3, scale: 2 }), // 0.0-1.0
  approvedBy: varchar("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  rejectedReason: text("rejected_reason"),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Analytics table
export const analytics = pgTable("analytics", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  clientId: varchar("client_id")
    .references(() => clients.id)
    .notNull(),
  date: timestamp("date").notNull(),
  metric: varchar("metric").notNull(), // total_leads, conversion_rate, avg_response_time, etc.
  value: decimal("value", { precision: 10, scale: 2 }).notNull(),
  metadata: jsonb("metadata"),
});

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  clients: many(clients),
}));

export const clientsRelations = relations(clients, ({ one, many }) => ({
  user: one(users, {
    fields: [clients.userId],
    references: [users.id],
  }),
  leads: many(leads),
  conversations: many(conversations),
  vsls: many(vsls),
  bookings: many(bookings),
  analytics: many(analytics),
}));

export const leadsRelations = relations(leads, ({ one, many }) => ({
  client: one(clients, {
    fields: [leads.clientId],
    references: [clients.id],
  }),
  conversations: many(conversations),
  bookings: many(bookings),
}));

export const conversationsRelations = relations(
  conversations,
  ({ one, many }) => ({
    lead: one(leads, {
      fields: [conversations.leadId],
      references: [leads.id],
    }),
    client: one(clients, {
      fields: [conversations.clientId],
      references: [clients.id],
    }),
    messages: many(messages),
  })
);

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

export const vslsRelations = relations(vsls, ({ one }) => ({
  client: one(clients, {
    fields: [vsls.clientId],
    references: [clients.id],
  }),
}));

export const bookingsRelations = relations(bookings, ({ one }) => ({
  lead: one(leads, {
    fields: [bookings.leadId],
    references: [leads.id],
  }),
  client: one(clients, {
    fields: [bookings.clientId],
    references: [clients.id],
  }),
}));

export const analyticsRelations = relations(analytics, ({ one }) => ({
  client: one(clients, {
    fields: [analytics.clientId],
    references: [clients.id],
  }),
}));

// Insert schemas
export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertClientSchema = createInsertSchema(clients).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertLeadSchema = createInsertSchema(leads).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
});

export const insertVslSchema = createInsertSchema(vsls).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertBookingSchema = createInsertSchema(bookings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Video and Notion SOP tables are defined in advanced-schema.ts.
// Keep each SQL table in only one Drizzle schema source.
export const spamPatterns = pgTable("spam_patterns", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  pattern: varchar("pattern").notNull().unique(), // ✅ ADD .unique()
  category: varchar("category").notNull(), // food, retail, service, test, other
  detectionCount: integer("detection_count").default(0).notNull(), // ✅ ADD .notNull()
  falsePositiveCount: integer("false_positive_count").default(0).notNull(), // ✅ ADD .notNull()
  confidence: decimal("confidence", { precision: 3, scale: 2 })
    .default("0.50")
    .notNull(), // ✅ ADD .notNull()
  lastDetected: timestamp("last_detected").defaultNow().notNull(), // ✅ ADD .notNull()
  createdAt: timestamp("created_at").defaultNow().notNull(), // ✅ ADD .notNull()
  updatedAt: timestamp("updated_at").defaultNow().notNull(), // ✅ ADD .notNull()
});

// Add at the end of schema.ts

// Call Recordings table
export const callRecordings = pgTable("call_recordings", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  callId: varchar("call_id").notNull().unique(),
  leadId: varchar("lead_id").references(() => leads.id),
  clientId: varchar("client_id")
    .references(() => clients.id)
    .notNull(),
  twilioCallSid: varchar("twilio_call_sid"),

  recordingUrl: varchar("recording_url"),
  duration: integer("duration"),
  fileSize: integer("file_size"),
  format: varchar("format").default("mp3"),

  callStatus: varchar("call_status").default("completed"),
  wasTransferred: boolean("was_transferred").default(false),
  transferredAt: timestamp("transferred_at"),
  transferredTo: varchar("transferred_to"),

  recordingConsent: boolean("recording_consent").default(false),
  consentGivenAt: timestamp("consent_given_at"),

  transcript: text("transcript"),
  transcriptStatus: varchar("transcript_status").default("pending"),

  aiSummary: text("ai_summary"),
  sentiment: varchar("sentiment"),
  keyTopics: jsonb("key_topics").default(sql`'[]'::jsonb`),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Call Events table
export const callEvents = pgTable("call_events", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  callId: varchar("call_id").notNull(),
  eventType: varchar("event_type").notNull(),
  eventData: jsonb("event_data"),
  timestamp: timestamp("timestamp").defaultNow(),
});

// ==================== FOLLOW-UPS TABLES ====================

// Follow-up Sequences (Templates)
export const followUpSequences = pgTable("follow_up_sequences", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  clientId: varchar("client_id")
    .references(() => clients.id)
    .notNull(),
  name: varchar("name").notNull(), // "48-Hour Fast Lane", "No Response Nurture"
  description: text("description"),
  triggerType: varchar("trigger_type").notNull(), // "no_response", "time_based", "behavior"
  channel: varchar("channel").default("whatsapp"), // whatsapp, sms, email
  steps: integer("steps").default(0), // Number of messages in sequence
  status: varchar("status").default("active"), // "active", "paused", "draft"
  isDefault: boolean("is_default").default(false), // Auto-apply to new leads
  metadata: jsonb("metadata").default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Follow-up Steps (Messages in a sequence)
export const followUpSteps = pgTable("follow_up_steps", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  sequenceId: varchar("sequence_id")
    .references(() => followUpSequences.id)
    .notNull(),
  stepNumber: integer("step_number").notNull(), // 1, 2, 3...
  delayMinutes: integer("delay_minutes").notNull(), // 30, 360, 1440 (30min, 6hr, 24hr)
  content: text("content").notNull(), // Message template with {{variables}}
  channel: varchar("channel").default("whatsapp"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Scheduled Follow-ups (Actual messages to send)
export const followUps = pgTable("follow_ups", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  sequenceId: varchar("sequence_id").references(() => followUpSequences.id),
  stepId: varchar("step_id").references(() => followUpSteps.id),
  leadId: varchar("lead_id")
    .references(() => leads.id)
    .notNull(),
  clientId: varchar("client_id")
    .references(() => clients.id)
    .notNull(),
  conversationId: varchar("conversation_id").references(() => conversations.id),

  // Message details
  content: text("content").notNull(), // Rendered message (variables replaced)
  channel: varchar("channel").default("whatsapp"),

  // Scheduling
  scheduledFor: timestamp("scheduled_for").notNull(),
  sentAt: timestamp("sent_at"),

  // Status
  status: varchar("status").default("pending"), // "pending", "sent", "failed", "cancelled"
  errorMessage: text("error_message"),

  // Metadata
  stepNumber: integer("step_number"),
  metadata: jsonb("metadata").default(sql`'{}'::jsonb`),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ==================== FAILED MESSAGES TABLE ====================
// For handling Claude API 529 errors and retries
export const failedMessages = pgTable("failed_messages", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  
  // Message identification
  messageId: varchar("message_id"), // Original WhatsApp message ID
  conversationId: varchar("conversation_id").references(() => conversations.id),
  leadId: varchar("lead_id").references(() => leads.id).notNull(),
  clientId: varchar("client_id").references(() => clients.id).notNull(),
  
  // Message content
  phoneNumber: varchar("phone_number").notNull(),
  content: text("content").notNull(),
  
  // Failure tracking
  failureReason: text("failure_reason").notNull(),
  errorCode: varchar("error_code"), // e.g., "529", "500"
  retryAfter: timestamp("retry_after").notNull(),
  
  // Retry management
  retryCount: integer("retry_count").default(0).notNull(),
  maxRetries: integer("max_retries").default(5).notNull(),
  status: varchar("status").default("pending").notNull(), // pending, processing, completed, failed, escalated
  
  // Timestamps
  lastRetryAt: timestamp("last_retry_at"),
  processedAt: timestamp("processed_at"),
  escalatedAt: timestamp("escalated_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  
  // Metadata
  metadata: jsonb("metadata").default(sql`'{}'::jsonb`),
});

// Relations
export const failedMessagesRelations = relations(failedMessages, ({ one }) => ({
  lead: one(leads, {
    fields: [failedMessages.leadId],
    references: [leads.id],
  }),
  client: one(clients, {
    fields: [failedMessages.clientId],
    references: [clients.id],
  }),
  conversation: one(conversations, {
    fields: [failedMessages.conversationId],
    references: [conversations.id],
  }),
}));

// Relations
export const followUpSequencesRelations = relations(
  followUpSequences,
  ({ one, many }) => ({
    client: one(clients, {
      fields: [followUpSequences.clientId],
      references: [clients.id],
    }),
    steps: many(followUpSteps),
    followUps: many(followUps),
  })
);

export const followUpStepsRelations = relations(followUpSteps, ({ one }) => ({
  sequence: one(followUpSequences, {
    fields: [followUpSteps.sequenceId],
    references: [followUpSequences.id],
  }),
}));

export const followUpsRelations = relations(followUps, ({ one }) => ({
  sequence: one(followUpSequences, {
    fields: [followUps.sequenceId],
    references: [followUpSequences.id],
  }),
  step: one(followUpSteps, {
    fields: [followUps.stepId],
    references: [followUpSteps.id],
  }),
  lead: one(leads, {
    fields: [followUps.leadId],
    references: [leads.id],
  }),
  client: one(clients, {
    fields: [followUps.clientId],
    references: [clients.id],
  }),
  conversation: one(conversations, {
    fields: [followUps.conversationId],
    references: [conversations.id],
  }),
}));

// Insert schemas
export const insertFollowUpSequenceSchema = createInsertSchema(
  followUpSequences
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertFollowUpStepSchema = createInsertSchema(followUpSteps).omit({
  id: true,
  createdAt: true,
});

export const insertFollowUpSchema = createInsertSchema(followUps).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type FollowUpSequence = typeof followUpSequences.$inferSelect;
export type InsertFollowUpSequence = z.infer<
  typeof insertFollowUpSequenceSchema
>;
export type FollowUpStep = typeof followUpSteps.$inferSelect;
export type InsertFollowUpStep = z.infer<typeof insertFollowUpStepSchema>;
export type FollowUp = typeof followUps.$inferSelect;
export type InsertFollowUp = z.infer<typeof insertFollowUpSchema>;

// Type exports
export type CallRecording = typeof callRecordings.$inferSelect;
export type InsertCallRecording = typeof callRecordings.$inferInsert;
export type CallEvent = typeof callEvents.$inferSelect;
export type InsertCallEvent = typeof callEvents.$inferInsert;
// Insert schema
export const insertSpamPatternSchema = createInsertSchema(spamPatterns).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Type exports
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type UpsertUser = typeof users.$inferInsert;
export type TrialActivation = typeof trialActivations.$inferSelect;
export type InsertTrialActivation = typeof trialActivations.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type InsertSubscription = typeof subscriptions.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type InsertPayment = typeof payments.$inferInsert;
export type UserActivity = typeof userActivities.$inferSelect;
export type InsertUserActivity = typeof userActivities.$inferInsert;
export type SystemMetric = typeof systemMetrics.$inferSelect;
export type InsertSystemMetric = typeof systemMetrics.$inferInsert;
export type InsertUser = z.infer<typeof insertUserSchema>;

export type Client = typeof clients.$inferSelect;
export type InsertClient = z.infer<typeof insertClientSchema>;

export type Lead = typeof leads.$inferSelect;
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type LeadActivityLog = typeof leadActivityLog.$inferSelect;
export type InsertLeadActivityLog = typeof leadActivityLog.$inferInsert;
export type LeadTag = typeof leadTags.$inferSelect;
export type InsertLeadTag = typeof leadTags.$inferInsert;

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;

export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

export type VSL = typeof vsls.$inferSelect;
export type InsertVSL = z.infer<typeof insertVslSchema>;
export type VSLAnalytics = typeof vslAnalytics.$inferSelect;
export type InsertVSLAnalytics = typeof vslAnalytics.$inferInsert;

export type Booking = typeof bookings.$inferSelect;
export type InsertBooking = z.infer<typeof insertBookingSchema>;

export type Analytics = typeof analytics.$inferSelect;

export type SpamPattern = typeof spamPatterns.$inferSelect;
export type InsertSpamPattern = z.infer<typeof insertSpamPatternSchema>;

export type FailedMessage = typeof failedMessages.$inferSelect;
export type InsertFailedMessage = typeof failedMessages.$inferInsert;

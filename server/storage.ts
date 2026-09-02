// server/storage.ts

import {
  users,
  clients,
  leads,
  conversations,
  messages,
  vsls,
  vslAnalytics,
  bookings,
  analytics,
  trialActivations,
  userActivities,
  systemMetrics,
  spamPatterns,
  subscriptions,
  payments,
  followUpSequences,
  followUpSteps,
  followUps,
  type User,
  type UpsertUser,
  type Client,
  type InsertClient,
  type Lead,
  type InsertLead,
  type Conversation,
  type InsertConversation,
  type Message,
  type InsertMessage,
  type VSL,
  type InsertVSL,
  
  type Booking,
  type InsertBooking,
  type Analytics,
  type InsertFollowUpSequence,
  type InsertFollowUpStep,
  type InsertFollowUp,
  callRecordings,
  failedMessages,
  type FailedMessage,
  type InsertFailedMessage,
} from "@shared/schema";
import {
  leadScoring,
  competitorTracking,
  serpMonitoring,
  brandMentions,
  executiveReports,
  opportunityAlerts,
  technicalIssues,
  videoSOPs,
  notionSOPs,
  whiteLabelSettings,
  kpiAnomalies,
} from "@shared/advanced-schema";
import { db } from "./db";
import { eq, desc, and, gte, sql, count } from "drizzle-orm";
import { quickReplyTemplates } from "@shared/schema";
import {
  leadActivityLog,
  leadTags,
  InsertLeadActivityLog,
  InsertLeadTag,
} from "@shared/schema";
import { normalizePhone, normalizeEmail } from "./utils/normalize";

export interface IStorage {
  // User operations (required for auth)
  getUser(id: string): Promise<User | undefined>;
  upsertUser(user: UpsertUser): Promise<User>;

  // Client operations
  getClients(userId: string): Promise<Client[]>;
  getClient(id: string): Promise<Client | undefined>;
  getClientByWhatsAppPhoneNumberId(
    phoneNumberId: string
  ): Promise<Client | undefined>;
  createClient(client: InsertClient): Promise<Client>;
  updateClient(id: string, updates: Partial<InsertClient>): Promise<Client>;

  // Lead operations
  getLeads(clientId: string, limit?: number): Promise<Lead[]>;
  getLead(id: string): Promise<Lead | undefined>;
  createLead(lead: InsertLead): Promise<Lead>;
  updateLead(id: string, updates: Partial<InsertLead>): Promise<Lead>;
  getLeadsByStatus(clientId: string, status: string): Promise<Lead[]>;

  // Conversation operations
  getConversations(
    clientId: string,
    limit?: number
  ): Promise<(Conversation & { lead: Lead })[]>;
  getConversation(id: string): Promise<Conversation | undefined>;
  createConversation(conversation: InsertConversation): Promise<Conversation>;
  updateConversation(
    id: string,
    updates: Partial<InsertConversation>
  ): Promise<Conversation>;
  getActiveConversations(
    clientId: string
  ): Promise<(Conversation & { lead: Lead })[]>;

  getAllConversations(
    clientId: String
  ): Promise<(Conversation & { lead: Lead })[]>;

  getHotLeads(clientId: string): Promise<(Conversation & { lead: Lead })[]>;
  markConversationAsRead(conversationId: string): Promise<void>; // ADD THIS
  incrementUnreadCount(conversationId: string): Promise<void>;

  // Message operations
  getMessages(conversationId: string, limit?: number): Promise<Message[]>;
  createMessage(message: InsertMessage): Promise<Message>;

  // VSL operations
  getVSLs(clientId: string): Promise<VSL[]>;
  createVSL(vsl: InsertVSL): Promise<VSL>;

  // Booking operations
  getBookings(clientId: string): Promise<any[]>;
  getBooking(bookingId: string): Promise<Booking | undefined>;
  createBooking(booking: InsertBooking): Promise<Booking>;
  updateBooking(
    bookingId: string,
    updates: Partial<InsertBooking>
  ): Promise<Booking>;
  deleteBooking(bookingId: string): Promise<void>;
  getLeadBookings(leadId: string): Promise<Booking[]>;

  // Analytics operations
  getKPIs(clientId: string): Promise<{
    totalLeads: number;
    conversionRate: number;
    avgResponseTime: number;
    aiHandledPercentage: number;
  }>;
  getRecentActivity(clientId: string): Promise<any[]>;

  getSpamPatterns(): Promise<any[]>;
  saveSpamPatterns(patterns: any[]): Promise<void>;

  // Message reactions
  getMessage(messageId: string): Promise<Message | undefined>;
  addReaction(
    messageId: string,
    reaction: { emoji: string; userId: string; userName: string }
  ): Promise<void>;
  removeReaction(
    messageId: string,
    userId: string,
    emoji: string
  ): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async updateUser(
    userId: string,
    updates: Partial<typeof users.$inferInsert>
  ) {
    const [updatedUser] = await db
      .update(users)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();
    return updatedUser;
  }
  // User operations
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async upsertUser(userData: UpsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(userData)
      .onConflictDoUpdate({
        target: users.id,
        set: {
          ...userData,
          updatedAt: new Date(),
        },
      })
      .returning();
    return user;
  }

  // Get all clients with user info (for super admin)
  async getAllClientsWithUsers(): Promise<any[]> {
    return await db
      .select({
        id: clients.id,
        name: clients.name,
        industry: clients.industry,
        website: clients.website,
        phone: clients.phone,
        email: clients.email,
        whatsappNumber: clients.whatsappNumber,
        isActive: clients.isActive,
        createdAt: clients.createdAt,
        user: {
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          role: users.role,
        },
      })
      .from(clients)
      .leftJoin(users, eq(clients.userId, users.id))
      .where(eq(clients.isActive, true))
      .orderBy(desc(clients.createdAt));
  }

  // Get all users with their client counts (for super admin)
  async getAllUsersWithStats(): Promise<any[]> {
    return await db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        subscriptionType: users.subscriptionType,
        isTrialActive: users.isTrialActive,
        trialEndsAt: users.trialEndsAt,
        isActive: users.isActive,
        createdAt: users.createdAt,
        clientCount: count(clients.id),
      })
      .from(users)
      .leftJoin(clients, eq(users.id, clients.userId))
      .groupBy(users.id)
      .orderBy(desc(users.createdAt));
  }

  // Client operations
  async getClients(userId: string): Promise<Client[]> {
    return await db
      .select()
      .from(clients)
      .where(eq(clients.userId, userId))
      .orderBy(desc(clients.createdAt));
  }

  async getClient(id: string): Promise<Client | undefined> {
    const [client] = await db.select().from(clients).where(eq(clients.id, id));
    return client;
  }

  async getClientByWhatsAppPhoneNumberId(
    phoneNumberId: string
  ): Promise<Client | undefined> {
    const [client] = await db
      .select()
      .from(clients)
      .where(
        and(
          eq(clients.whatsappPhoneNumberId, phoneNumberId.trim()),
          eq(clients.isActive, true)
        )
      )
      .limit(1);
    return client;
  }

  async createClient(client: InsertClient): Promise<Client> {
    const [newClient] = await db.insert(clients).values(client).returning();
    return newClient;
  }

  async updateClient(
    id: string,
    updates: Partial<InsertClient>
  ): Promise<Client> {
    const [updated] = await db
      .update(clients)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(clients.id, id))
      .returning();
    return updated;
  }

  async deleteClient(clientId: string): Promise<void> {
    console.log(
      `🗑️ [DELETE CLIENT] Starting cascade deletion for: ${clientId}`
    );

    try {
      // Get all leads for this client
      const clientLeads = await db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.clientId, clientId));

      const leadIds = clientLeads.map((l) => l.id);
      console.log(`📋 Found ${leadIds.length} leads to delete`);

      // Get all conversations for this client
      const clientConversations = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.clientId, clientId));

      const conversationIds = clientConversations.map((c) => c.id);
      console.log(`💬 Found ${conversationIds.length} conversations`);

      // Delete messages for all conversations
      for (const conversationId of conversationIds) {
        await db
          .delete(messages)
          .where(eq(messages.conversationId, conversationId));
      }
      console.log(`✅ Deleted messages`);

      // Delete conversations
      await db
        .delete(conversations)
        .where(eq(conversations.clientId, clientId));
      console.log(`✅ Deleted conversations`);

      // Delete bookings
      await db.delete(bookings).where(eq(bookings.clientId, clientId));
      console.log(`✅ Deleted bookings`);

      // Delete follow-ups
      await db.delete(followUps).where(eq(followUps.clientId, clientId));
      console.log(`✅ Deleted follow-ups`);

      // Delete follow-up sequences and steps
      const sequences = await db
        .select({ id: followUpSequences.id })
        .from(followUpSequences)
        .where(eq(followUpSequences.clientId, clientId));

      for (const seq of sequences) {
        await db
          .delete(followUpSteps)
          .where(eq(followUpSteps.sequenceId, seq.id));
      }
      await db
        .delete(followUpSequences)
        .where(eq(followUpSequences.clientId, clientId));
      console.log(`✅ Deleted follow-up sequences`);

      // Delete lead activity logs
      for (const leadId of leadIds) {
        await db
          .delete(leadActivityLog)
          .where(eq(leadActivityLog.leadId, leadId));
      }
      console.log(`✅ Deleted lead activity logs`);

      // Delete leads
      await db.delete(leads).where(eq(leads.clientId, clientId));
      console.log(`✅ Deleted leads`);

      // Delete VSLs
      await db.delete(vsls).where(eq(vsls.clientId, clientId));
      console.log(`✅ Deleted VSLs`);

      // Delete quick reply templates
      await db
        .delete(quickReplyTemplates)
        .where(eq(quickReplyTemplates.clientId, clientId));
      console.log(`✅ Deleted quick reply templates`);

      // Delete lead tags
      await db.delete(leadTags).where(eq(leadTags.clientId, clientId));
      console.log(`✅ Deleted lead tags`);

      // Delete analytics
      await db.delete(analytics).where(eq(analytics.clientId, clientId));
      console.log(`✅ Deleted analytics`);

      // Finally, delete the client
      await db.delete(clients).where(eq(clients.id, clientId));
      console.log(`✅ Deleted client`);

      console.log(`🎯 [DELETE CLIENT] Cascade deletion completed: ${clientId}`);
    } catch (error) {
      console.error(`❌ [DELETE CLIENT] Error:`, error);
      throw new Error("Failed to delete client. Please contact support.");
    }
  }

  // Lead operations
  async getLeads(clientId: string, limit = 50): Promise<Lead[]> {
    return await db
      .select()
      .from(leads)
      .where(eq(leads.clientId, clientId))
      .orderBy(desc(leads.createdAt))
      .limit(limit);
  }

  async getLead(id: string): Promise<Lead | undefined> {
    const [lead] = await db.select().from(leads).where(eq(leads.id, id));
    return lead;
  }

  async createLead(lead: InsertLead): Promise<Lead> {
    console.log("📝 [UPSERT LEAD] Checking for existing lead...");

    // Normalize phone and email for comparison
    const normalizedPhone = lead.phone ? normalizePhone(lead.phone) : null;
    const normalizedEmail = lead.email ? normalizeEmail(lead.email) : null;

    // Check if lead already exists by phone OR email
    let existingLead: Lead | undefined;

    if (normalizedPhone) {
      console.log(`🔍 [UPSERT] Searching by phone: ${normalizedPhone}`);
      existingLead = await this.getLeadByPhone(normalizedPhone);
    }

    // If not found by phone, try email
    if (!existingLead && normalizedEmail) {
      console.log(`🔍 [UPSERT] Searching by email: ${normalizedEmail}`);
      const [leadByEmail] = await db
        .select()
        .from(leads)
        .where(sql`LOWER(${leads.email}) = ${normalizedEmail}`)
        .limit(1);

      existingLead = leadByEmail;
    }

    // ✅ UPSERT: Update existing lead
    if (existingLead) {
      console.log(`♻️ [UPSERT] Found existing lead: ${existingLead.id}`);
      console.log(
        `   Previous submissions: ${existingLead.submissionCount || 1}`
      );

      const [updatedLead] = await db
        .update(leads)
        .set({
          // Update core info (in case they changed)
          firstName: lead.firstName || existingLead.firstName,
          lastName: lead.lastName || existingLead.lastName,
          company: lead.company || existingLead.company,

          // ✅ Refresh audit results with new data
          auditResults: lead.auditResults || existingLead.auditResults,

          // ✅ Increment submission count
          submissionCount: (existingLead.submissionCount || 1) + 1,
          lastSubmittedAt: new Date(),

          // Update temperature based on new qualification
          temperature: lead.temperature || existingLead.temperature,
          qualificationScore:
            lead.qualificationScore || existingLead.qualificationScore,

          // Keep status as-is (don't reset to 'new' if already qualified)
          // status remains unchanged

          updatedAt: new Date(),
        })
        .where(eq(leads.id, existingLead.id))
        .returning();

      console.log(
        `✅ [UPSERT] Updated existing lead (submission #${updatedLead.submissionCount})`
      );

      return updatedLead;
    }

    // ✅ INSERT: Create new lead
    console.log("🆕 [UPSERT] Creating new lead...");

    const [newLead] = await db
      .insert(leads)
      .values({
        ...lead,
        phone: normalizedPhone || lead.phone,
        email: normalizedEmail || lead.email,
        submissionCount: 1,
        lastSubmittedAt: new Date(),
      })
      .returning();

    console.log(`✅ [UPSERT] Created new lead: ${newLead.id}`);

    return newLead;
  }

  async updateLead(id: string, updates: Partial<InsertLead>): Promise<Lead> {
    const [updated] = await db
      .update(leads)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(leads.id, id))
      .returning();
    return updated;
  }

  async getLeadsByStatus(clientId: string, status: string): Promise<Lead[]> {
    return await db
      .select()
      .from(leads)
      .where(and(eq(leads.clientId, clientId), eq(leads.status, status)))
      .orderBy(desc(leads.createdAt));
  }

  async getLeadByPhone(phone: string): Promise<Lead | undefined> {
    const normalizedPhone = normalizePhone(phone);

    // Try exact match first
    const [exactMatch] = await db
      .select()
      .from(leads)
      .where(eq(leads.phone, normalizedPhone))
      .limit(1);

    if (exactMatch) return exactMatch;

    // Fallback: search all leads and normalize (for backward compatibility)
    const allLeads = await db
      .select()
      .from(leads)
      .where(sql`${leads.phone} IS NOT NULL`);
    return allLeads.find((l) => normalizePhone(l.phone!) === normalizedPhone);
  }

  // Lead Activity Log
  async logLeadActivity(activity: InsertLeadActivityLog): Promise<any> {
    const [newLog] = await db
      .insert(leadActivityLog)
      .values(activity)
      .returning();
    return newLog;
  }

  async getLeadActivityLog(leadId: string): Promise<any[]> {
    return await db
      .select({
        id: leadActivityLog.id,
        action: leadActivityLog.action,
        fieldChanged: leadActivityLog.fieldChanged,
        oldValue: leadActivityLog.oldValue,
        newValue: leadActivityLog.newValue,
        notes: leadActivityLog.notes,
        createdAt: leadActivityLog.createdAt,
        user: {
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
        },
      })
      .from(leadActivityLog)
      .leftJoin(users, eq(leadActivityLog.userId, users.id))
      .where(eq(leadActivityLog.leadId, leadId))
      .orderBy(desc(leadActivityLog.createdAt))
      .limit(50);
  }

  // Lead Tags
  async getLeadTags(clientId: string): Promise<any[]> {
    return await db
      .select()
      .from(leadTags)
      .where(eq(leadTags.clientId, clientId))
      .orderBy(leadTags.name);
  }

  async createLeadTag(tag: InsertLeadTag): Promise<any> {
    const [newTag] = await db.insert(leadTags).values(tag).returning();
    return newTag;
  }

  // Update lead with manual controls
  // Update lead with manual controls
  async updateLeadManual(
    leadId: string,
    updates: Partial<InsertLead>,
    userId?: string
  ): Promise<Lead> {
    console.log("🔄 Updating lead in database:", leadId, updates);

    // Get old lead for logging
    const oldLead = await this.getLead(leadId);

    // Update the lead
    const [updated] = await db
      .update(leads)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(leads.id, leadId))
      .returning();

    console.log("✅ Database updated. New values:", {
      manualScore: updated.manualScore,
      isManualOverride: updated.isManualOverride,
      temperature: updated.temperature, // ADD THIS LINE
      status: updated.status, // ADD THIS LINE
      tags: updated.tags,
    });

    // Log activity if userId provided
    if (userId && oldLead) {
      const changes: any[] = [];

      if (updates.status && updates.status !== oldLead.status) {
        changes.push({
          leadId,
          userId,
          action: "status_changed",
          fieldChanged: "status",
          oldValue: oldLead.status,
          newValue: updates.status,
        });
      }

      if (updates.temperature && updates.temperature !== oldLead.temperature) {
        changes.push({
          leadId,
          userId,
          action: "temperature_changed",
          fieldChanged: "temperature",
          oldValue: oldLead.temperature,
          newValue: updates.temperature,
        });
      }

      if (updates.manualScore && updates.manualScore !== oldLead.manualScore) {
        changes.push({
          leadId,
          userId,
          action: "score_changed",
          fieldChanged: "manualScore",
          oldValue: oldLead.manualScore || oldLead.qualificationScore,
          newValue: updates.manualScore,
        });
      }

      if (updates.manualScore && updates.manualScore !== oldLead.manualScore) {
        changes.push({
          leadId,
          userId,
          action: "score_changed",
          fieldChanged: "manualScore",
          oldValue: oldLead.manualScore || oldLead.qualificationScore,
          newValue: updates.manualScore,
        });
      }

      if (updates.tags) {
        changes.push({
          leadId,
          userId,
          action: "tags_updated",
          fieldChanged: "tags",
          oldValue: JSON.stringify(oldLead.tags || []),
          newValue: JSON.stringify(updates.tags),
        });
      }

      if (
        updates.internalNotes &&
        updates.internalNotes !== oldLead.internalNotes
      ) {
        changes.push({
          leadId,
          userId,
          action: "note_added",
          fieldChanged: "internalNotes",
          oldValue: oldLead.internalNotes,
          newValue: updates.internalNotes,
        });
      }

      // Log all changes
      for (const change of changes) {
        try {
          await this.logLeadActivity(change);
        } catch (err) {
          console.error("Failed to log activity:", err);
        }
      }
    }

    return updated;
  }

  // Conversation operations
  async getConversations(
    clientId: string,
    limit = 20
  ): Promise<(Conversation & { lead: Lead })[]> {
    return await db
      .select({
        id: conversations.id,
        leadId: conversations.leadId,
        clientId: conversations.clientId,
        channel: conversations.channel,
        status: conversations.status,
        isAiHandled: conversations.isAiHandled,
        humanTakeoverAt: conversations.humanTakeoverAt,
        lastMessageAt: conversations.lastMessageAt,
        qualificationScore: conversations.qualificationScore,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
        lead: leads,
        unreadCount: conversations.unreadCount,
        lastReadAt: conversations.lastReadAt,
        reopenedAt: conversations.reopenedAt,
      })
      .from(conversations)
      .innerJoin(leads, eq(conversations.leadId, leads.id))
      .where(eq(conversations.clientId, clientId))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(limit);
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id));
    return conversation;
  }

  async createConversation(
    conversation: InsertConversation
  ): Promise<Conversation> {
    const [newConversation] = await db
      .insert(conversations)
      .values(conversation)
      .returning();
    return newConversation;
  }

  async updateConversation(
    id: string,
    updates: Partial<InsertConversation>
  ): Promise<Conversation> {
    const [updated] = await db
      .update(conversations)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(conversations.id, id))
      .returning();
    return updated;
  }

  async getActiveConversations(
    clientId: string
  ): Promise<(Conversation & { lead: Lead })[]> {
    return await db
      .select({
        id: conversations.id,
        leadId: conversations.leadId,
        clientId: conversations.clientId,
        channel: conversations.channel,
        status: conversations.status,
        isAiHandled: conversations.isAiHandled,
        humanTakeoverAt: conversations.humanTakeoverAt,
        lastMessageAt: conversations.lastMessageAt,
        qualificationScore: conversations.qualificationScore,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
        lead: leads,
        unreadCount: conversations.unreadCount,
        lastReadAt: conversations.lastReadAt,
        reopenedAt: conversations.reopenedAt,
      })
      .from(conversations)
      .innerJoin(leads, eq(conversations.leadId, leads.id))
      .where(
        and(
          eq(conversations.clientId, clientId),
          eq(conversations.status, "active")
        )
      )
      .orderBy(desc(conversations.lastMessageAt));
  }

  // ✅ NEW METHOD: Get ALL conversations (including closed ones)
  async getAllConversations(
    clientId: string
  ): Promise<(Conversation & { lead: Lead })[]> {
    return await db
      .select({
        id: conversations.id,
        leadId: conversations.leadId,
        clientId: conversations.clientId,
        channel: conversations.channel,
        status: conversations.status,
        isAiHandled: conversations.isAiHandled,
        humanTakeoverAt: conversations.humanTakeoverAt,
        lastMessageAt: conversations.lastMessageAt,
        qualificationScore: conversations.qualificationScore,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
        lead: leads,
        unreadCount: conversations.unreadCount,
        lastReadAt: conversations.lastReadAt,
        reopenedAt: conversations.reopenedAt,
      })
      .from(conversations)
      .innerJoin(leads, eq(conversations.leadId, leads.id))
      .where(eq(conversations.clientId, clientId))
      .orderBy(desc(conversations.lastMessageAt));
  }

  async getMessageByWhatsAppId(
    whatsappMessageId: string
  ): Promise<Message | undefined> {
    const allMessages = await db.select().from(messages);
    return allMessages.find(
      (m) =>
        m.metadata &&
        typeof m.metadata === "object" &&
        "whatsappMessageId" in m.metadata &&
        m.metadata.whatsappMessageId === whatsappMessageId
    );
  }

  // ==================== SPAM PATTERN LEARNING METHODS ====================

  async getSpamPatterns(): Promise<any[]> {
    try {
      return await db
        .select()
        .from(spamPatterns)
        .where(gte(spamPatterns.confidence, "0.30")) // Lower threshold
        .orderBy(desc(spamPatterns.confidence));
    } catch (error) {
      console.error("Error fetching spam patterns:", error);
      return [];
    }
  }

  async saveSpamPatterns(patterns: any[]): Promise<void> {
    try {
      for (const pattern of patterns) {
        await db
          .insert(spamPatterns)
          .values({
            id: pattern.id,
            pattern: pattern.pattern,
            category: pattern.category,
            detectionCount: pattern.detectionCount,
            falsePositiveCount: pattern.falsePositiveCount,
            confidence: pattern.confidence,
            lastDetected: pattern.lastDetected,
            createdAt: pattern.createdAt,
            updatedAt: pattern.updatedAt,
          })
          .onConflictDoUpdate({
            target: spamPatterns.pattern, // ✅ Now this will work!
            set: {
              detectionCount: pattern.detectionCount,
              falsePositiveCount: pattern.falsePositiveCount,
              confidence: pattern.confidence,
              lastDetected: pattern.lastDetected,
              updatedAt: new Date(),
            },
          });
      }
      console.log(`✅ Saved ${patterns.length} spam patterns to database`);
    } catch (error) {
      console.error("❌ Error saving spam patterns:", error);
    }
  }

  async getHotLeads(
    clientId: string
  ): Promise<(Conversation & { lead: Lead })[]> {
    return await db
      .select({
        id: conversations.id,
        leadId: conversations.leadId,
        clientId: conversations.clientId,
        channel: conversations.channel,
        status: conversations.status,
        isAiHandled: conversations.isAiHandled,
        humanTakeoverAt: conversations.humanTakeoverAt,
        lastMessageAt: conversations.lastMessageAt,
        qualificationScore: conversations.qualificationScore,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
        lead: leads,
        unreadCount: conversations.unreadCount,
        lastReadAt: conversations.lastReadAt,
        reopenedAt: conversations.reopenedAt,
      })
      .from(conversations)
      .innerJoin(leads, eq(conversations.leadId, leads.id))
      .where(
        and(
          eq(conversations.clientId, clientId), // MAKE SURE THIS IS HERE
          gte(conversations.qualificationScore, "0.7")
        )
      )
      .orderBy(desc(conversations.qualificationScore));
  }

  async markConversationAsRead(conversationId: string): Promise<void> {
    console.log(`📖 [DB] Marking conversation ${conversationId} as read`);

    await db
      .update(conversations)
      .set({
        unreadCount: 0,
        lastReadAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));

    console.log(`✅ [DB] Conversation ${conversationId} marked as read`);
  }

  async incrementUnreadCount(conversationId: string): Promise<void> {
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));

    if (conversation) {
      await db
        .update(conversations)
        .set({
          unreadCount: (conversation.unreadCount || 0) + 1,
        })
        .where(eq(conversations.id, conversationId));
    }
  }

  // Message operations
  async getMessages(conversationId: string, limit = 50): Promise<Message[]> {
    return await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.sentAt))
      .limit(limit);
  }

  async createMessage(message: InsertMessage): Promise<Message> {
    const [newMessage] = await db.insert(messages).values(message).returning();
    return newMessage;
  }

  // Mark messages as read
  async markMessagesAsRead(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;

    console.log(
      `💾 [DB] Marking ${messageIds.length} messages as read in database`
    );

    // ✅ Use a single query with proper SQL
    await db
      .update(messages)
      .set({
        readAt: new Date(),
      })
      .where(
        sql`${messages.id} = ANY(ARRAY[${sql.join(
          messageIds.map((id) => sql`${id}`),
          sql`, `
        )}]::text[])`
      );

    console.log(
      `✅ [DB] Successfully marked ${messageIds.length} messages as read`
    );
  }

  // Mark previous outgoing messages as read when lead responds
  async markPreviousMessagesAsRead(conversationId: string): Promise<void> {
    console.log(
      `📖 [DB] Marking previous outgoing messages as read for conversation ${conversationId}`
    );

    // Get all messages from this conversation that aren't from the lead
    // and don't have readAt set yet
    const unreadOutgoingMessages = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          sql`${messages.sender} != 'lead'`,
          sql`${messages.readAt} IS NULL`
        )
      );

    if (unreadOutgoingMessages.length > 0) {
      console.log(
        `   Found ${unreadOutgoingMessages.length} unread outgoing messages`
      );
      const messageIds = unreadOutgoingMessages.map((m) => m.id);
      await this.markMessagesAsRead(messageIds);
    } else {
      console.log(`   No unread outgoing messages found`);
    }
  }

  // ==================== MESSAGE REACTION METHODS ====================

  async getMessage(messageId: string): Promise<Message | undefined> {
    const [message] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);
    return message;
  }

  async addReaction(
    messageId: string,
    reaction: { emoji: string; userId: string; userName: string }
  ): Promise<void> {
    const message = await this.getMessage(messageId);
    if (!message) throw new Error("Message not found");

    const currentReactions = (message.reactions as any[]) || [];

    // ✅ FIX: Remove any existing reaction from this user first
    const filteredReactions = currentReactions.filter(
      (r: any) => r.userId !== reaction.userId
    );

    // ✅ Add the new reaction (replacing old one if it existed)
    const newReactions = [
      ...filteredReactions,
      {
        ...reaction,
        timestamp: new Date().toISOString(),
      },
    ];

    await db
      .update(messages)
      .set({ reactions: newReactions as any })
      .where(eq(messages.id, messageId));

    console.log(
      `✅ Added/replaced reaction ${reaction.emoji} for user ${reaction.userId} on message ${messageId}`
    );
  }

  async removeReaction(
    messageId: string,
    userId: string,
    emoji: string
  ): Promise<void> {
    const message = await this.getMessage(messageId);
    if (!message) throw new Error("Message not found");

    const currentReactions = (message.reactions as any[]) || [];

    // ✅ FIX: If emoji is empty, remove ALL reactions from this user
    const newReactions =
      !emoji || emoji.trim() === ""
        ? currentReactions.filter((r: any) => r.userId !== userId)
        : currentReactions.filter(
            (r: any) => !(r.userId === userId && r.emoji === emoji)
          );

    await db
      .update(messages)
      .set({ reactions: newReactions as any })
      .where(eq(messages.id, messageId));

    console.log(
      emoji
        ? `✅ Removed reaction ${emoji} from user ${userId} on message ${messageId}`
        : `✅ Removed all reactions from user ${userId} on message ${messageId}`
    );
  }

  async removeAllReactionsFromUser(messageId: string, userId: string) {
    const message = await db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId))
      .limit(1);

    if (!message[0]) return null;

    const currentReactions = (message[0].reactions as any[]) || [];

    // Remove all reactions from this user
    const updatedReactions = currentReactions.filter(
      (r: any) => r.userId !== userId
    );

    await db
      .update(messages)
      .set({ reactions: updatedReactions })
      .where(eq(messages.id, messageId));

    return this.getMessage(messageId);
  }

  // Quick Reply Templates
  async getQuickReplyTemplates(clientId: string): Promise<any[]> {
    return await db
      .select()
      .from(quickReplyTemplates)
      .where(
        and(
          eq(quickReplyTemplates.clientId, clientId),
          eq(quickReplyTemplates.isActive, true)
        )
      )
      .orderBy(desc(quickReplyTemplates.usageCount));
  }

  async createQuickReplyTemplate(template: any): Promise<any> {
    const [newTemplate] = await db
      .insert(quickReplyTemplates)
      .values(template)
      .returning();
    return newTemplate;
  }

  async updateQuickReplyTemplate(id: string, updates: any): Promise<any> {
    const [updated] = await db
      .update(quickReplyTemplates)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(quickReplyTemplates.id, id))
      .returning();
    return updated;
  }

  async deleteQuickReplyTemplate(id: string): Promise<void> {
    await db
      .update(quickReplyTemplates)
      .set({ isActive: false })
      .where(eq(quickReplyTemplates.id, id));
  }

  async incrementTemplateUsage(id: string): Promise<void> {
    await db
      .update(quickReplyTemplates)
      .set({
        usageCount: sql`${quickReplyTemplates.usageCount} + 1`,
      })
      .where(eq(quickReplyTemplates.id, id));
  }

  // VSL operations
  async getVSLs(clientId: string): Promise<VSL[]> {
    return await db
      .select()
      .from(vsls)
      .where(eq(vsls.clientId, clientId))
      .orderBy(desc(vsls.createdAt));
  }

  // Advanced Features - Lead Scoring
  async createLeadScoring(data: any): Promise<any> {
    const [newScoring] = await db.insert(leadScoring).values(data).returning();
    return newScoring;
  }

  async getLeadScoring(leadId: string): Promise<any> {
    return await db
      .select()
      .from(leadScoring)
      .where(eq(leadScoring.leadId, leadId))
      .orderBy(desc(leadScoring.createdAt));
  }

  // Competitor Tracking
  async createCompetitorTracking(data: any): Promise<any> {
    const [newTracking] = await db
      .insert(competitorTracking)
      .values(data)
      .returning();
    return newTracking;
  }

  async getCompetitorTracking(clientId: string): Promise<any[]> {
    return await db
      .select()
      .from(competitorTracking)
      .where(eq(competitorTracking.clientId, clientId))
      .orderBy(desc(competitorTracking.trackingDate));
  }

  // SERP Monitoring
  async createSerpMonitoring(data: any): Promise<any> {
    const [newSerp] = await db.insert(serpMonitoring).values(data).returning();
    return newSerp;
  }

  async getSerpMonitoring(clientId: string): Promise<any[]> {
    return await db
      .select()
      .from(serpMonitoring)
      .where(eq(serpMonitoring.clientId, clientId))
      .orderBy(desc(serpMonitoring.checkDate));
  }

  // Brand Mentions
  async createBrandMention(data: any): Promise<any> {
    const [newMention] = await db
      .insert(brandMentions)
      .values(data)
      .returning();
    return newMention;
  }

  async getBrandMentions(clientId: string): Promise<any[]> {
    return await db
      .select()
      .from(brandMentions)
      .where(eq(brandMentions.clientId, clientId))
      .orderBy(desc(brandMentions.mentionDate));
  }

  // Executive Reports
  async createExecutiveReport(data: any): Promise<any> {
    const [newReport] = await db
      .insert(executiveReports)
      .values(data)
      .returning();
    return newReport;
  }

  async getExecutiveReports(clientId: string): Promise<any[]> {
    return await db
      .select()
      .from(executiveReports)
      .where(eq(executiveReports.clientId, clientId))
      .orderBy(desc(executiveReports.generatedAt));
  }

  // Opportunity Alerts
  async createOpportunityAlert(data: any): Promise<any> {
    const [newAlert] = await db
      .insert(opportunityAlerts)
      .values(data)
      .returning();
    return newAlert;
  }

  async getOpportunityAlerts(clientId: string): Promise<any[]> {
    return await db
      .select()
      .from(opportunityAlerts)
      .where(eq(opportunityAlerts.clientId, clientId))
      .orderBy(desc(opportunityAlerts.createdAt));
  }

  // Technical Issues
  async createTechnicalIssue(data: any): Promise<any> {
    const [newIssue] = await db
      .insert(technicalIssues)
      .values(data)
      .returning();
    return newIssue;
  }

  async getTechnicalIssues(clientId: string): Promise<any[]> {
    return await db
      .select()
      .from(technicalIssues)
      .where(eq(technicalIssues.clientId, clientId))
      .orderBy(desc(technicalIssues.createdAt));
  }

  // Video SOPs
  async createVideoSOP(data: any): Promise<any> {
    const [newSOP] = await db.insert(videoSOPs).values(data).returning();
    return newSOP;
  }

  async getVideoSOPs(clientId?: string): Promise<any[]> {
    const query = db.select().from(videoSOPs);
    if (clientId) {
      return await query
        .where(eq(videoSOPs.clientId, clientId))
        .orderBy(desc(videoSOPs.createdAt));
    }
    return await query
      .where(eq(videoSOPs.isPublic, true))
      .orderBy(desc(videoSOPs.createdAt));
  }

  // Notion SOPs
  async createNotionSOP(data: any): Promise<any> {
    const [newSOP] = await db.insert(notionSOPs).values(data).returning();
    return newSOP;
  }

  async getNotionSOPs(clientId: string): Promise<any[]> {
    return await db
      .select()
      .from(notionSOPs)
      .where(eq(notionSOPs.clientId, clientId))
      .orderBy(desc(notionSOPs.createdAt));
  }

  // White Label Settings
  async createWhiteLabelSettings(data: any): Promise<any> {
    const [newSettings] = await db
      .insert(whiteLabelSettings)
      .values(data)
      .returning();
    return newSettings;
  }

  async getWhiteLabelSettings(clientId: string): Promise<any> {
    const [settings] = await db
      .select()
      .from(whiteLabelSettings)
      .where(eq(whiteLabelSettings.clientId, clientId))
      .limit(1);
    return settings;
  }

  async updateWhiteLabelSettings(clientId: string, data: any): Promise<any> {
    const [updated] = await db
      .update(whiteLabelSettings)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(whiteLabelSettings.clientId, clientId))
      .returning();
    return updated;
  }

  // KPI Anomalies
  async createKpiAnomaly(data: any): Promise<any> {
    const [newAnomaly] = await db.insert(kpiAnomalies).values(data).returning();
    return newAnomaly;
  }

  async getKpiAnomalies(clientId: string): Promise<any[]> {
    return await db
      .select()
      .from(kpiAnomalies)
      .where(eq(kpiAnomalies.clientId, clientId))
      .orderBy(desc(kpiAnomalies.detectedAt));
  }

  // Trial and User Management
  async activateUserTrial(
    userId: string,
    trialDays: number = 14
  ): Promise<any> {
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);

    // Update user with trial info
    const [updatedUser] = await db
      .update(users)
      .set({
        isTrialActive: true,
        hasUnlockedTrial: true,
        trialEndsAt,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();

    // Record trial activation
    const [activation] = await db
      .insert(trialActivations)
      .values({
        userId,
        trialDays,
        source: "dashboard",
      })
      .returning();

    return { user: updatedUser, activation };
  }

  async getUserTrialStatus(userId: string): Promise<any> {
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        isTrialActive: users.isTrialActive,
        hasUnlockedTrial: users.hasUnlockedTrial,
        trialEndsAt: users.trialEndsAt,
        subscriptionType: users.subscriptionType,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) return null;

    // Calculate days left if trial is active
    let daysLeft = 0;
    if (user.isTrialActive && user.trialEndsAt) {
      const now = new Date();
      const endDate = new Date(user.trialEndsAt);
      daysLeft = Math.max(
        0,
        Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      );

      // Check if trial has expired
      if (daysLeft === 0) {
        await db
          .update(users)
          .set({ isTrialActive: false, updatedAt: new Date() })
          .where(eq(users.id, userId));
        user.isTrialActive = false;
      }
    }

    return { ...user, daysLeft };
  }

  async logUserActivity(
    userId: string,
    action: string,
    resource?: string,
    details?: any
  ): Promise<any> {
    const [activity] = await db
      .insert(userActivities)
      .values({
        userId,
        action,
        resource,
        details,
      })
      .returning();

    return activity;
  }

  // Activity Log
  async getUserActivityLog(
    userId: string,
    filters: { type?: string; startDate?: Date; endDate?: Date },
    limit = 100
  ): Promise<any[]> {
    // Start building the query conditions array
    const conditions = [eq(userActivities.userId, userId)];

    // Add filters dynamically if they exist
    if (filters.type && filters.type !== "all") {
      conditions.push(eq(userActivities.action, filters.type));
    }
    if (filters.startDate) {
      conditions.push(gte(userActivities.createdAt, filters.startDate));
    }
    if (filters.endDate) {
      // Set to the end of the selected day for an inclusive search
      const nextDay = new Date(filters.endDate);
      nextDay.setHours(23, 59, 59, 999);
      conditions.push(sql`${userActivities.createdAt} <= ${nextDay}`);
    }

    return await db
      .select({
        id: userActivities.id,
        action: userActivities.action,
        resource: userActivities.resource,
        details: userActivities.details,
        ipAddress: userActivities.ipAddress,
        userAgent: userActivities.userAgent,
        createdAt: userActivities.createdAt,
      })
      .from(userActivities)
      // ✅ CORRECTED: This now uses all the conditions from the array.
      .where(and(...conditions))
      .orderBy(desc(userActivities.createdAt))
      .limit(limit);
  }

  // Super Admin Functions
  async getSuperAdminDashboard(): Promise<any> {
    const [metrics] = await db
      .select({
        totalUsers: count(users.id),
      })
      .from(users);

    const [activeTrials] = await db
      .select({
        count: count(users.id),
      })
      .from(users)
      .where(eq(users.isTrialActive, true));

    const [expiredTrials] = await db
      .select({
        count: count(users.id),
      })
      .from(users)
      .where(
        and(eq(users.hasUnlockedTrial, true), eq(users.isTrialActive, false))
      );

    return {
      totalUsers: metrics.totalUsers || 0,
      activeTrials: activeTrials.count || 0,
      expiredTrials: expiredTrials.count || 0,
      totalClients: 0, // Will be calculated from clients table
      totalLeads: 0, // Will be calculated from leads table
    };
  }

  async getAllClients() {
    return await db.select().from(clients).where(eq(clients.isActive, true));
  }

  // Get user by email
  async getUserByEmail(email: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    return user;
  }

  // Create user
  async createUser(data: any) {
    const [user] = await db.insert(users).values(data).returning();
    return user;
  }

  // ==================== EMAIL VERIFICATION METHODS ====================

  async verifyUserEmail(userId: string): Promise<void> {
    await db
      .update(users)
      .set({
        emailVerified: true,
        verificationToken: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    console.log(`✅ User ${userId} email verified`);
  }

  async updatePasswordResetToken(
    userId: string,
    token: string,
    expiry: Date
  ): Promise<void> {
    await db
      .update(users)
      .set({
        passwordResetToken: token,
        passwordResetExpiry: expiry,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    console.log(`✅ Password reset token set for user ${userId}`);
  }

  async resetUserPassword(
    userId: string,
    newPasswordHash: string
  ): Promise<void> {
    await db
      .update(users)
      .set({
        passwordHash: newPasswordHash,
        passwordResetToken: null,
        passwordResetExpiry: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    console.log(`✅ Password reset for user ${userId}`);
  }

  async getUserById(userId: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return user;
  }

  async getUserByResetToken(token: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.passwordResetToken, token))
      .limit(1);

    return user;
  }

  async getAllUsersForAdmin(
    searchQuery?: string,
    statusFilter?: string
  ): Promise<any[]> {
    // Build where conditions array
    const whereConditions = [];

    if (searchQuery) {
      whereConditions.push(
        sql`${users.email} ILIKE ${`%${searchQuery}%`} OR 
            ${users.firstName} ILIKE ${`%${searchQuery}%`} OR 
            ${users.lastName} ILIKE ${`%${searchQuery}%`}`
      );
    }

    if (statusFilter && statusFilter !== "all") {
      switch (statusFilter) {
        case "trial":
          whereConditions.push(eq(users.isTrialActive, true));
          break;
        case "expired":
          whereConditions.push(
            and(
              eq(users.hasUnlockedTrial, true),
              eq(users.isTrialActive, false)
            )
          );
          break;
        default:
          whereConditions.push(eq(users.subscriptionType, statusFilter));
      }
    }

    // Build query with or without where clause
    const baseSelect = db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        subscriptionType: users.subscriptionType,
        isTrialActive: users.isTrialActive,
        trialEndsAt: users.trialEndsAt,
        lastLoginAt: users.lastLoginAt,
        loginCount: users.loginCount,
        createdAt: users.createdAt,
        clientsCount: count(clients.id),
      })
      .from(users)
      .leftJoin(clients, eq(users.id, clients.userId));

    // Apply where conditions if any, then group and order
    if (whereConditions.length > 0) {
      return await baseSelect
        .where(
          whereConditions.length === 1
            ? whereConditions[0]
            : and(...whereConditions)
        )
        .groupBy(users.id)
        .orderBy(desc(users.createdAt));
    }

    // No where conditions - just group and order
    return await baseSelect.groupBy(users.id).orderBy(desc(users.createdAt));
  }

  /**
   * ⚠️ DANGER ZONE: Hard delete user account with cascade
   * This permanently deletes ALL user data across all tables
   */
  async deleteUserAccount(userId: string): Promise<void> {
    console.log(
      `⚠️ [DELETE ACCOUNT] Starting cascade deletion for user: ${userId}`
    );

    try {
      // Step 1: Get all clients owned by this user
      const userClients = await db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.userId, userId));

      const clientIds = userClients.map((c) => c.id);
      console.log(`📊 Found ${clientIds.length} clients to delete`);

      // Step 2: For each client, delete associated data
      for (const clientId of clientIds) {
        console.log(`🔄 Deleting data for client: ${clientId}`);

        // Get all leads for this client
        const clientLeads = await db
          .select({ id: leads.id })
          .from(leads)
          .where(eq(leads.clientId, clientId));

        const leadIds = clientLeads.map((l) => l.id);
        console.log(`  📋 Found ${leadIds.length} leads`);

        // Get all conversations for this client
        const clientConversations = await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.clientId, clientId));

        const conversationIds = clientConversations.map((c) => c.id);
        console.log(`  💬 Found ${conversationIds.length} conversations`);

        // Delete messages for all conversations
        for (const conversationId of conversationIds) {
          await db
            .delete(messages)
            .where(eq(messages.conversationId, conversationId));
        }
        console.log(`  ✅ Deleted messages`);

        // Delete conversations
        await db
          .delete(conversations)
          .where(eq(conversations.clientId, clientId));
        console.log(`  ✅ Deleted conversations`);

        // Delete bookings
        await db.delete(bookings).where(eq(bookings.clientId, clientId));
        console.log(`  ✅ Deleted bookings`);

        // Delete lead activity logs
        for (const leadId of leadIds) {
          await db
            .delete(leadActivityLog)
            .where(eq(leadActivityLog.leadId, leadId));
        }
        console.log(`  ✅ Deleted lead activity logs`);

        // Delete leads
        await db.delete(leads).where(eq(leads.clientId, clientId));
        console.log(`  ✅ Deleted leads`);

        // Delete VSLs
        await db.delete(vsls).where(eq(vsls.clientId, clientId));
        console.log(`  ✅ Deleted VSLs`);

        // Delete video SOPs
        await db.delete(videoSOPs).where(eq(videoSOPs.clientId, clientId));
        console.log(`  ✅ Deleted video SOPs`);

        // Delete Notion SOPs
        await db.delete(notionSOPs).where(eq(notionSOPs.clientId, clientId));
        console.log(`  ✅ Deleted Notion SOPs`);

        // Delete quick reply templates
        await db
          .delete(quickReplyTemplates)
          .where(eq(quickReplyTemplates.clientId, clientId));
        console.log(`  ✅ Deleted quick reply templates`);

        // Delete lead tags
        await db.delete(leadTags).where(eq(leadTags.clientId, clientId));
        console.log(`  ✅ Deleted lead tags`);

        // Delete analytics
        await db.delete(analytics).where(eq(analytics.clientId, clientId));
        console.log(`  ✅ Deleted analytics`);
      }

      // Step 3: Delete all clients
      await db.delete(clients).where(eq(clients.userId, userId));
      console.log(`✅ Deleted all clients`);

      // Step 4: Delete user-specific data

      // Delete subscriptions
      await db.delete(subscriptions).where(eq(subscriptions.userId, userId));
      console.log(`✅ Deleted subscriptions`);

      // Delete payments
      await db.delete(payments).where(eq(payments.userId, userId));
      console.log(`✅ Deleted payments`);

      // Delete trial activations
      await db
        .delete(trialActivations)
        .where(eq(trialActivations.userId, userId));
      console.log(`✅ Deleted trial activations`);

      // Delete user activities
      await db.delete(userActivities).where(eq(userActivities.userId, userId));
      console.log(`✅ Deleted user activities`);

      // Step 5: Finally, delete the user
      await db.delete(users).where(eq(users.id, userId));
      console.log(`✅ Deleted user account`);

      console.log(
        `🎯 [DELETE ACCOUNT] Cascade deletion completed for user: ${userId}`
      );
    } catch (error) {
      console.error(
        `❌ [DELETE ACCOUNT] Error during cascade deletion:`,
        error
      );
      throw new Error("Failed to delete account. Please contact support.");
    }
  }

  async getRecentActivities(limit: number = 50): Promise<any[]> {
    return await db
      .select({
        id: userActivities.id,
        userId: userActivities.userId,
        action: userActivities.action,
        resource: userActivities.resource,
        details: userActivities.details,
        createdAt: userActivities.createdAt,
        userEmail: users.email,
      })
      .from(userActivities)
      .innerJoin(users, eq(userActivities.userId, users.id))
      .orderBy(desc(userActivities.createdAt))
      .limit(limit);
  }

  async recordSystemMetrics(): Promise<any> {
    const dashboard = await this.getSuperAdminDashboard();

    const [metrics] = await db
      .insert(systemMetrics)
      .values({
        totalUsers: dashboard.totalUsers,
        activeTrials: dashboard.activeTrials,
        expiredTrials: dashboard.expiredTrials,
        totalClients: dashboard.totalClients,
        totalLeads: dashboard.totalLeads,
        avgResponseTime: sql`(SELECT AVG(response_time_seconds) FROM leads WHERE response_time_seconds IS NOT NULL)`,
        conversionRate: sql`(SELECT COUNT(*) FILTER (WHERE status = 'converted') * 100.0 / COUNT(*) FROM leads WHERE created_at > NOW() - INTERVAL '30 days')`,
      })
      .returning();

    return metrics;
  }



  // ============= BOOKING METHODS =============

  async getBookings(clientId: string) {
    return db
      .select({
        id: bookings.id,
        leadId: bookings.leadId,
        clientId: bookings.clientId,
        title: bookings.title,
        description: bookings.description,
        location: bookings.location,
        scheduledFor: bookings.scheduledFor,
        scheduledAt: bookings.scheduledAt,
        duration: bookings.duration,
        status: bookings.status,
        attendeeEmail: bookings.attendeeEmail,
        attendeeName: bookings.attendeeName,
        attendeePhone: bookings.attendeePhone,
        meetingType: bookings.meetingType,
        meetingUrl: bookings.meetingUrl,
        notes: bookings.notes,
        reminderSent: bookings.reminderSent,
        reminder24hSent: bookings.reminder24hSent,
        reminder1hSent: bookings.reminder1hSent,
        reminder24hSentAt: bookings.reminder24hSentAt,
        reminder1hSentAt: bookings.reminder1hSentAt,

        createdAt: bookings.createdAt,
        updatedAt: bookings.updatedAt,
      })
      .from(bookings)
      .where(eq(bookings.clientId, clientId))
      .orderBy(desc(bookings.scheduledFor));
  }

  async getBooking(bookingId: string) {
    const [booking] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, bookingId));
    return booking;
  }

  async createBooking(data: InsertBooking) {
    const [booking] = await db.insert(bookings).values(data).returning();
    return booking;
  }

  // Add this method around line 800 (near other booking methods)
  async getPendingBookings(clientId: string) {
    return db
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.clientId, clientId),
          eq(bookings.status, "pending_approval")
        )
      )
      .orderBy(desc(bookings.createdAt));
  }

  async approveBooking(bookingId: string, userId: string) {
    const [booking] = await db
      .update(bookings)
      .set({
        status: "scheduled",
        approvedBy: userId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(bookings.id, bookingId))
      .returning();
    return booking;
  }

  async rejectBooking(bookingId: string, reason?: string) {
    const [booking] = await db
      .update(bookings)
      .set({
        status: "cancelled",
        rejectedReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(bookings.id, bookingId))
      .returning();
    return booking;
  }

  async updateBooking(bookingId: string, updates: Partial<InsertBooking>) {
    const [booking] = await db
      .update(bookings)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(bookings.id, bookingId))
      .returning();
    return booking;
  }

  async deleteBooking(bookingId: string) {
    await db.delete(bookings).where(eq(bookings.id, bookingId));
  }

  // Get upcoming bookings for a lead
  async getLeadBookings(leadId: string) {
    return db
      .select()
      .from(bookings)
      .where(eq(bookings.leadId, leadId))
      .orderBy(desc(bookings.scheduledFor));
  }

  // Find Pending Booking
  async findPendingBookingByLeadId(leadId: string): Promise<Booking | null> {
    const [booking] = await db
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.leadId, leadId),
          eq(bookings.status, "pending_approval")
        )
      )
      .limit(1);

    return booking || null;
  }

  // Delete lead
  async deleteLeadAndAssociations(leadId: string): Promise<void> {
    console.log(`🗑️ [Cascade Delete] Starting deletion for lead: ${leadId}`);
    try {
      // 5. Delete all follow-ups for this lead FIRST (before conversations)
      await db.delete(followUps).where(eq(followUps.leadId, leadId));
      console.log(`  ✅ Deleted follow-ups.`);

      // 6. Find all conversations for this lead
      const leadConversations = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.leadId, leadId));

      const conversationIds = leadConversations.map((c) => c.id);
      if (conversationIds.length > 0) {
        console.log(`  Deleting ${conversationIds.length} conversations...`);

        // 7. Delete all messages for those conversations
        await db.delete(messages).where(
          sql`${messages.conversationId} = ANY(ARRAY[${sql.join(
            conversationIds.map((id) => sql`${id}`),
            sql`, `
          )}])`
        );
        console.log(`  ✅ Deleted messages.`);

        // 8. Delete the conversations (now safe after follow-ups deleted)
        await db.delete(conversations).where(eq(conversations.leadId, leadId));
        console.log(`  ✅ Deleted conversations.`);
      }

      // 9. Delete all bookings for this lead
      await db.delete(bookings).where(eq(bookings.leadId, leadId));
      console.log(`  ✅ Deleted bookings.`);

      // 10. Delete all lead activity logs for this lead
      await db
        .delete(leadActivityLog)
        .where(eq(leadActivityLog.leadId, leadId));
      console.log(`  ✅ Deleted lead activity logs.`);

      // 11. Finally, delete the lead
      await db.delete(leads).where(eq(leads.id, leadId));
      console.log(`  ✅ Deleted lead.`);

      console.log(`🎯 [Cascade Delete] Successfully deleted lead: ${leadId}`);
    } catch (error) {
      console.error(
        `❌ [Cascade Delete] Error deleting lead ${leadId}:`,
        error
      );
      throw error; // Re-throw so the API can return proper error
    }
  }

  // Analytics operations
  async getKPIs(clientId: string): Promise<{
    // Current Period (Last 30 days)
    totalLeads: number;
    conversionRate: number;
    avgResponseTime: number;
    aiHandledPercentage: number;
    convertedLeads: number;
    // Previous Period (30-60 days ago) for comparison
    totalLeadsChange: number;
    conversionRateChange: number;
    avgResponseTimeChange: number;
    aiHandledPercentageChange: number;
    // Response Time Breakdown
    aiAvgResponseTime: number;
    humanAvgResponseTime: number;
  }> {
    try {
      // ✅ SAFETY CHECK: Verify client exists first
      const [clientExists] = await db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.id, clientId))
        .limit(1);

      if (!clientExists) {
        console.warn(
          `⚠️ [getKPIs] Client ${clientId} not found - returning zero metrics`
        );
        return {
          totalLeads: 0,
          conversionRate: 0,
          avgResponseTime: 0,
          aiHandledPercentage: 0,
          convertedLeads: 0,
          totalLeadsChange: 0,
          conversionRateChange: 0,
          avgResponseTimeChange: 0,
          aiHandledPercentageChange: 0,
          aiAvgResponseTime: 0,
          humanAvgResponseTime: 0,
        };
      }

      // Current period: Last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      // Previous period: 31-60 days ago
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

      // ==================CURRENT PERIOD=======================

      // Total leads in last 30 days
      const [currentLeadsResult] = await db
        .select({ count: count() })
        .from(leads)
        .where(
          and(eq(leads.clientId, clientId), gte(leads.createdAt, thirtyDaysAgo))
        );

      // ✅ DEBUG: Get sample of ALL leads for this client (no date filter)
      const [allLeadsForClient] = await db
        .select({ count: count() })
        .from(leads)
        .where(eq(leads.clientId, clientId));

      if (allLeadsForClient.count > 0 && currentLeadsResult.count === 0) {
        console.warn(
          `⚠️ [getKPIs] ISSUE: Client has ${allLeadsForClient.count} total leads, but 0 in last 30 days!`
        );
        console.warn(
          `⚠️ [getKPIs] This suggests leads are older than 30 days.`
        );

        // Get the most recent lead date
        const recentLead = await db
          .select({ createdAt: leads.createdAt })
          .from(leads)
          .where(eq(leads.clientId, clientId))
          .orderBy(desc(leads.createdAt))
          .limit(1);

        if (recentLead.length > 0) {
          console.warn(
            `⚠️ [getKPIs] Most recent lead created: ${recentLead[0].createdAt}`
          );
        }
      }

      // Converted leads (with bookings)
      const [currentConversionsResult] = await db
        .select({ count: count() })
        .from(leads)
        .innerJoin(bookings, eq(leads.id, bookings.leadId))
        .where(
          and(
            eq(leads.clientId, clientId),
            gte(leads.createdAt, thirtyDaysAgo),
            sql`${bookings.status} IN ('scheduled', 'confirmed')` // ✅ Only confirmed bookings
          )
        );

      // Average response time (all)
      const [currentAvgResponseResult] = await db
        .select({
          avg: sql<number>`AVG(${leads.responseTimeSeconds})`,
        })
        .from(leads)
        .where(
          and(
            eq(leads.clientId, clientId),
            gte(leads.createdAt, thirtyDaysAgo),
            sql`${leads.responseTimeSeconds} IS NOT NULL`
          )
        );

      // AI handled conversations
      const [currentAiHandledResult] = await db
        .select({ count: count() })
        .from(conversations)
        .where(
          and(
            eq(conversations.clientId, clientId),
            eq(conversations.isAiHandled, true),
            gte(conversations.createdAt, thirtyDaysAgo)
          )
        );

      const [currentTotalConversationsResult] = await db
        .select({ count: count() })
        .from(conversations)
        .where(
          and(
            eq(conversations.clientId, clientId),
            gte(conversations.createdAt, thirtyDaysAgo)
          )
        );

      // ================= PREVIOUS PERIOD ====================

      const [previousLeadsResult] = await db
        .select({ count: count() })
        .from(leads)
        .where(
          and(
            eq(leads.clientId, clientId),
            gte(leads.createdAt, sixtyDaysAgo),
            sql`${leads.createdAt} < ${thirtyDaysAgo}`
          )
        );

      const [previousConversionsResult] = await db
        .select({ count: count() })
        .from(leads)
        .innerJoin(bookings, eq(leads.id, bookings.leadId))
        .where(
          and(
            eq(leads.clientId, clientId),
            gte(leads.createdAt, sixtyDaysAgo),
            sql`${leads.createdAt} < ${thirtyDaysAgo}`,
            sql`${bookings.status} IN ('scheduled', 'confirmed')` // ✅ Only confirmed bookings
          )
        );

      const [previousAvgResponseResult] = await db
        .select({
          avg: sql<number>`AVG(${leads.responseTimeSeconds})`,
        })
        .from(leads)
        .where(
          and(
            eq(leads.clientId, clientId),
            gte(leads.createdAt, sixtyDaysAgo),
            sql`${leads.createdAt} < ${thirtyDaysAgo}`,
            sql`${leads.responseTimeSeconds} IS NOT NULL`
          )
        );

      const [previousAiHandledResult] = await db
        .select({ count: count() })
        .from(conversations)
        .where(
          and(
            eq(conversations.clientId, clientId),
            eq(conversations.isAiHandled, true),
            gte(conversations.createdAt, sixtyDaysAgo),
            sql`${conversations.createdAt} < ${thirtyDaysAgo}`
          )
        );

      const [previousTotalConversationsResult] = await db
        .select({ count: count() })
        .from(conversations)
        .where(
          and(
            eq(conversations.clientId, clientId),
            gte(conversations.createdAt, sixtyDaysAgo),
            sql`${conversations.createdAt} < ${thirtyDaysAgo}`
          )
        );

      // ============================== CALCULATE CURRENT VALUES ===============================
      const totalLeads = currentLeadsResult.count;
      const convertedLeads = currentConversionsResult.count;
      const conversionRate =
        totalLeads > 0 ? (convertedLeads / totalLeads) * 100 : 0;

      // ✅ FIX: Ensure avgResponseTime is a proper number
      const avgResponseTime = Number(currentAvgResponseResult.avg) || 0;

      const aiHandledPercentage =
        currentTotalConversationsResult.count > 0
          ? (currentAiHandledResult.count /
              currentTotalConversationsResult.count) *
            100
          : 0;

      // ============================== CALCULATE PREVIOUS VALUES ==============================
      const previousTotalLeads = previousLeadsResult.count;
      const previousConvertedLeads = previousConversionsResult.count;
      const previousConversionRate =
        previousTotalLeads > 0
          ? (previousConvertedLeads / previousTotalLeads) * 100
          : 0;

      // ✅ FIX: Ensure previousAvgResponseTime is a proper number
      const previousAvgResponseTime =
        Number(previousAvgResponseResult.avg) || 0;

      const previousAiHandledPercentage =
        previousTotalConversationsResult.count > 0
          ? (previousAiHandledResult.count /
              previousTotalConversationsResult.count) *
            100
          : 0;

      // ============================ CALCULATE CHANGES ================================
      const totalLeadsChange =
        previousTotalLeads > 0
          ? ((totalLeads - previousTotalLeads) / previousTotalLeads) * 100
          : 0;
      const conversionRateChange =
        previousConversionRate > 0
          ? conversionRate - previousConversionRate
          : 0;
      const avgResponseTimeChange =
        previousAvgResponseTime > 0
          ? ((avgResponseTime - previousAvgResponseTime) /
              previousAvgResponseTime) *
            100
          : 0;
      const aiHandledPercentageChange =
        previousAiHandledPercentage > 0
          ? aiHandledPercentage - previousAiHandledPercentage
          : 0;

      // ============================ AI vs HUMAN RESPONSE TIME =========================
      // Get AI response times (from conversations where AI handled first)
      const [aiResponseResult] = await db
        .select({
          avg: sql<number>`AVG(${leads.responseTimeSeconds})`,
        })
        .from(leads)
        .where(
          and(
            eq(leads.clientId, clientId),
            gte(leads.createdAt, thirtyDaysAgo),
            sql`${leads.responseTimeSeconds} IS NOT NULL`
          )
        );

      // Get Human response times (from conversations where human took over immediately)
      const [humanResponseResult] = await db
        .select({
          avg: sql<number>`
      AVG(
        EXTRACT(EPOCH FROM (
          (
            SELECT MIN(m.sent_at)
            FROM messages m
            WHERE m.conversation_id = ${conversations.id}
            AND m.sender = 'human'
            AND m.sent_at > ${conversations.humanTakeoverAt}
          ) - ${conversations.humanTakeoverAt}
        ))
      )
    `,
        })
        .from(conversations)
        .innerJoin(leads, eq(conversations.leadId, leads.id))
        .where(
          and(
            eq(leads.clientId, clientId),
            gte(leads.createdAt, thirtyDaysAgo),
            sql`${conversations.humanTakeoverAt} IS NOT NULL`,
            // ✅ Only count if there's actually a human message after takeover
            sql`EXISTS (
        SELECT 1 FROM messages m 
        WHERE m.conversation_id = ${conversations.id}
        AND m.sender = 'human'
        AND m.sent_at > ${conversations.humanTakeoverAt}
      )`
          )
        );

      const safeToFixed = (value: any, decimals: number): number => {
        if (value === null || value === undefined || isNaN(value)) {
          return 0;
        }
        return Number(Number(value).toFixed(decimals));
      };

      // ✅ FIX: Safely convert all values to numbers before .toFixed()
      const safeNumber = (val: any): number => {
        const num = Number(val);
        return isNaN(num) ? 0 : num;
      };

      const result = {
        // Current values
        totalLeads,
        convertedLeads,
        conversionRate: safeNumber(conversionRate.toFixed(1)),
        avgResponseTime: safeNumber(avgResponseTime.toFixed(0)),
        aiHandledPercentage: safeNumber(aiHandledPercentage.toFixed(1)),
        // Change percentages
        totalLeadsChange: safeNumber(totalLeadsChange.toFixed(1)),
        conversionRateChange: safeNumber(conversionRateChange.toFixed(1)),
        avgResponseTimeChange: safeNumber(avgResponseTimeChange.toFixed(1)),
        aiHandledPercentageChange: safeNumber(
          aiHandledPercentageChange.toFixed(1)
        ),
        // AI vs Human breakdown
        aiAvgResponseTime: safeNumber(
          (Number(aiResponseResult.avg) || 0).toFixed(0)
        ),
        humanAvgResponseTime: safeNumber(
          (Number(humanResponseResult.avg) || 0).toFixed(0)
        ),
      };

      return result;
    } catch (error: any) {
      console.error(
        `❌ [getKPIs] Error for client ${clientId}:`,
        error.message
      );
      console.error(`Stack trace:`, error.stack);

      // Return zero metrics on error instead of throwing
      return {
        totalLeads: 0,
        conversionRate: 0,
        avgResponseTime: 0,
        aiHandledPercentage: 0,
        convertedLeads: 0,
        totalLeadsChange: 0,
        conversionRateChange: 0,
        avgResponseTimeChange: 0,
        aiHandledPercentageChange: 0,
        aiAvgResponseTime: 0,
        humanAvgResponseTime: 0,
      };
    }
  }

  // ==================== PER-DAY ANALYTICS METHOD ====================

async getPerDayResponseTimes(clientId: string, timezone: string = 'America/Vancouver'): Promise<any> {
  console.log(`📊 [ANALYTICS] Calculating per-day response times for client: ${clientId}`);
  
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Get all conversations from last 30 days
    const recentConversations = await db
      .select({
        id: conversations.id,
        leadId: conversations.leadId,
        createdAt: conversations.createdAt,
        humanTakeoverAt: conversations.humanTakeoverAt,
        leadResponseTime: leads.responseTimeSeconds,
      })
      .from(conversations)
      .innerJoin(leads, eq(conversations.leadId, leads.id))
      .where(
        and(
          eq(conversations.clientId, clientId),
          gte(conversations.createdAt, thirtyDaysAgo)
        )
      );

    console.log(`   Found ${recentConversations.length} conversations`);

    // Initialize weekly data
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const weekData = dayNames.map((day) => ({
      day,
      aiTime: 0,
      aiCount: 0,
      humanTime: 0,
      humanCount: 0,
    }));

    // Calculate per-day AI response times
    for (const conv of recentConversations) {
      // Convert to specified timezone
      const localDate = new Date(conv.createdAt!.toLocaleString("en-US", {
        timeZone: timezone
      }));
      const dayIndex = localDate.getDay();

      // ✅ AI response time (always available from lead data)
      if (conv.leadResponseTime) {
        const aiTimeInMinutes = conv.leadResponseTime / 60;
        weekData[dayIndex].aiTime += aiTimeInMinutes;
        weekData[dayIndex].aiCount++;
      }

      // ✅ Human response time (calculate from messages)
      if (conv.humanTakeoverAt) {
        // Get all messages for this conversation
        const convMessages = await db
          .select()
          .from(messages)
          .where(eq(messages.conversationId, conv.id))
          .orderBy(messages.sentAt);

        // Find first human message AFTER takeover
        const firstHumanMsg = convMessages.find(
          (m) => m.sender === 'human' && 
                 m.sentAt && 
                 new Date(m.sentAt) > new Date(conv.humanTakeoverAt!)
        );

        if (firstHumanMsg && firstHumanMsg.sentAt) {
          const takeoverTime = new Date(conv.humanTakeoverAt).getTime();
          const firstResponseTime = new Date(firstHumanMsg.sentAt).getTime();
          const humanTimeSeconds = (firstResponseTime - takeoverTime) / 1000;
          
          if (humanTimeSeconds > 0) {
            const humanTimeMinutes = humanTimeSeconds / 60;
            weekData[dayIndex].humanTime += humanTimeMinutes;
            weekData[dayIndex].humanCount++;
          }
        }
      }
    }

    // Calculate averages
    const result = weekData.map((day) => ({
      day: day.day,
      aiTime: day.aiCount > 0 ? Number((day.aiTime / day.aiCount).toFixed(1)) : 0,
      humanTime: day.humanCount > 0 ? Number((day.humanTime / day.humanCount).toFixed(1)) : 0,
      aiCount: day.aiCount,
      humanCount: day.humanCount,
    }));

    console.log(`✅ [ANALYTICS] Per-day response times calculated`);
    return result;
  } catch (error) {
    console.error(`❌ [ANALYTICS] Error calculating per-day response times:`, error);
    return [];
  }
}

async getRecentActivity(clientId: string): Promise<any[]> {
  try {
    // ✅ Get recent bookings with inquiry
    const recentBookings = await db
      .select({
        type: sql<string>`'booking'`,
        description: sql<string>`'New booking confirmed'`,
        leadName: sql<string>`${leads.firstName} || ' ' || ${leads.lastName}`,
        company: leads.company,
        createdAt: bookings.createdAt,
        leadId: leads.id,
        conversationId: conversations.id,
      })
      .from(bookings)
      .innerJoin(leads, eq(bookings.leadId, leads.id))
      .leftJoin(conversations, eq(conversations.leadId, leads.id))
      .where(
        and(
          eq(leads.clientId, clientId),
          sql`${bookings.status} IN ('scheduled', 'confirmed')`
        )
      )
      .orderBy(desc(bookings.createdAt))
      .limit(5);

    // ✅ Get recent leads with inquiry
    const recentLeads = await db
      .select({
        type: sql<string>`'lead'`,
        description: sql<string>`'New lead captured'`,
        leadName: sql<string>`${leads.firstName} || ' ' || ${leads.lastName}`,
        company: leads.company,
        createdAt: leads.createdAt,
        leadId: leads.id,
        conversationId: conversations.id,
      })
      .from(leads)
      .leftJoin(conversations, eq(conversations.leadId, leads.id))
      .where(eq(leads.clientId, clientId))
      .orderBy(desc(leads.createdAt))
      .limit(5);

    // VSLs (no inquiry needed)
    const recentVSLs = await db
      .select({
        type: sql<string>`'vsl'`,
        description: sql<string>`'VSL generated for client'`,
        leadName: sql<string>`''`,
        company: vsls.title,
        createdAt: vsls.createdAt,
        leadId: sql<string>`NULL`,
        conversationId: sql<string>`NULL`,
      })
      .from(vsls)
      .where(eq(vsls.clientId, clientId))
      .orderBy(desc(vsls.createdAt))
      .limit(3);

    // ✅ Extract inquiry for each activity
    const activitiesWithInquiry = await Promise.all(
      [...recentBookings, ...recentLeads, ...recentVSLs].map(async (activity) => {
        let inquiry = null;

        // Get inquiry from first lead message in conversation
        if (activity.conversationId) {
          const firstLeadMessages = await db
            .select({
              content: messages.content,
            })
            .from(messages)
            .where(
              and(
                eq(messages.conversationId, activity.conversationId),
                eq(messages.sender, "lead")
              )
            )
            .orderBy(messages.sentAt)
            .limit(3); // Get first 3 messages to find inquiry

          if (firstLeadMessages.length > 0) {
            // Combine first few messages as inquiry (in case of multi-message inquiry)
            inquiry = firstLeadMessages
              .map((m) => m.content)
              .join(" ")
              .substring(0, 100); // Limit to 100 chars
            
            // Trim to last complete word
            if (inquiry.length === 100) {
              inquiry = inquiry.substring(0, inquiry.lastIndexOf(" ")) + "...";
            }
          }
        }

        return {
          ...activity,
          inquiry,
        };
      })
    );

    // Sort by date and return top 10
    return activitiesWithInquiry
      .sort((a, b) => {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return dateB - dateA;
      })
      .slice(0, 10);
  } catch (error) {
    console.error("❌ Error getting recent activity:", error);
    return [];
  }
}

  // ==================== VSL METHODS ====================

  async getVSL(vslId: string): Promise<VSL | undefined> {
    const [vsl] = await db
      .select()
      .from(vsls)
      .where(eq(vsls.id, vslId))
      .limit(1);
    return vsl;
  }

 async createVSL(vsl: InsertVSL): Promise<VSL> {
 
  const vslData = {
    ...vsl,
    targetDuration: vsl.targetDuration || "2min",
    subtitleType: vsl.subtitleType || "none",
  };
  
  console.log(`📝 [STORAGE] Creating VSL with target duration: ${vslData.targetDuration}`);
  
  const [newVSL] = await db.insert(vsls).values(vslData).returning();
  
  console.log(`✅ [STORAGE] VSL created: ${newVSL.id} (${newVSL.targetDuration})`);
  
  return newVSL;
}

  async updateVSL(vslId: string, data: Partial<InsertVSL>): Promise<VSL> {
    const [vsl] = await db
      .update(vsls)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(vsls.id, vslId))
      .returning();
    return vsl;
  }

  async deleteVSL(vslId: string): Promise<void> {
    await db.delete(vsls).where(eq(vsls.id, vslId));
  }

  async incrementVSLViews(vslId: string): Promise<void> {
    await db
      .update(vsls)
      .set({
        viewCount: sql`${vsls.viewCount} + 1`,
      })
      .where(eq(vsls.id, vslId));
  }

  async getVSLsByClient(clientId: string): Promise<VSL[]> {
  // Fetch all VSLs for the client
  const vslList = await db
    .select()
    .from(vsls)
    .where(eq(vsls.clientId, clientId))
    .orderBy(desc(vsls.createdAt));

  // ✅ Fetch analytics for each VSL
  const vslsWithAnalytics = await Promise.all(
    vslList.map(async (vsl) => {
      try {
        const analytics = await this.getVSLAnalytics(vsl.id);
        
        return {
          ...vsl,
          // Add analytics fields
          totalViews: analytics.totalViews,
          completionRate: analytics.completionRate,
          averageWatchTime: analytics.averageWatchTime,
          totalWatchTime: analytics.totalWatchTime,
          averageCompletionPercentage: analytics.averageCompletionPercentage,
        } as VSL;
      } catch (error) {
        console.error(`❌ Failed to fetch analytics for VSL ${vsl.id}:`, error);
        
        // Return VSL with default analytics values if fetch fails
        return {
          ...vsl,
          totalViews: 0,
          completionRate: 0,
          averageWatchTime: 0,
          totalWatchTime: 0,
          averageCompletionPercentage: 0,
        } as VSL;
      }
    })
  );

  return vslsWithAnalytics;
}

// VSL Analytics Methods
async trackVSLPlay(data: {
  vslId: string;
  sessionId: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  console.log(`📊 [STORAGE] Tracking play for VSL: ${data.vslId}, Session: ${data.sessionId}`);
  
  await db
    .insert(vslAnalytics)
    .values({
      vslId: data.vslId,
      sessionId: data.sessionId,
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
      watchTime: 0,
      completionPercentage: 0,
      completed: false,
    })
    .onConflictDoNothing(); 
  
  console.log(`✅ [STORAGE] Play tracked (or already exists)`);
}

async trackVSLProgress(
  sessionId: string,
  watchTime: number,
  completionPercentage: number,
  completed: boolean
): Promise<void> {
  await db
    .update(vslAnalytics)
    .set({
      watchTime,
      completionPercentage,
      completed,
      updatedAt: new Date(),
    })
    .where(eq(vslAnalytics.sessionId, sessionId));
}

async getVSLAnalytics(vslId: string): Promise<{
  totalViews: number;
  totalWatchTime: number;
  averageWatchTime: number;
  completionRate: number;
  averageCompletionPercentage: number;
}> {
  console.log(`📊 [STORAGE] Fetching analytics for VSL: ${vslId}`);
  
  const analytics = await db
    .select()
    .from(vslAnalytics)
    .where(eq(vslAnalytics.vslId, vslId));

  console.log(`   Found ${analytics.length} total records`);

  // ✅ FIX: Group by sessionId to get unique views
  const uniqueSessions = new Map<string, typeof analytics[0]>();
  
  analytics.forEach((record) => {
    const existing = uniqueSessions.get(record.sessionId);
    
    // Keep the record with the highest completion percentage (most recent)
    if (!existing || (record.completionPercentage || 0) > (existing.completionPercentage || 0)) {
      uniqueSessions.set(record.sessionId, record);
    }
  });

  const uniqueAnalytics = Array.from(uniqueSessions.values());
  console.log(`   Unique sessions: ${uniqueAnalytics.length}`);

  const totalViews = uniqueAnalytics.length;
  const totalWatchTime = uniqueAnalytics.reduce((sum, a) => sum + (a.watchTime || 0), 0);
  const completedViews = uniqueAnalytics.filter((a) => a.completed).length;
  const totalCompletionPercentage = uniqueAnalytics.reduce(
    (sum, a) => sum + (a.completionPercentage || 0),
    0
  );

  const result = {
    totalViews,
    totalWatchTime,
    averageWatchTime: totalViews > 0 ? Math.round(totalWatchTime / totalViews) : 0,
    completionRate: totalViews > 0 ? (completedViews / totalViews) * 100 : 0,
    averageCompletionPercentage:
      totalViews > 0 ? Math.round(totalCompletionPercentage / totalViews) : 0,
  };

  console.log(`✅ [STORAGE] Analytics calculated:`, result);
  return result;
}

  // ==================== FOLLOW-UPS METHODS ====================

  async createFollowUpSequence(data: InsertFollowUpSequence) {
    const [sequence] = await db
      .insert(followUpSequences)
      .values(data)
      .returning();
    return sequence;
  }

  async getFollowUpSequences(clientId: string) {
    return await db
      .select()
      .from(followUpSequences)
      .where(eq(followUpSequences.clientId, clientId))
      .orderBy(desc(followUpSequences.createdAt));
  }

  async getFollowUpSequence(sequenceId: string) {
    const [sequence] = await db
      .select()
      .from(followUpSequences)
      .where(eq(followUpSequences.id, sequenceId))
      .limit(1);
    return sequence;
  }

  async updateFollowUpSequence(
    sequenceId: string,
    data: Partial<InsertFollowUpSequence>
  ) {
    const [updated] = await db
      .update(followUpSequences)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(followUpSequences.id, sequenceId))
      .returning();
    return updated;
  }

  async deleteFollowUpSequence(sequenceId: string) {
    // Delete steps first
    await db
      .delete(followUpSteps)
      .where(eq(followUpSteps.sequenceId, sequenceId));
    // Delete sequence
    await db
      .delete(followUpSequences)
      .where(eq(followUpSequences.id, sequenceId));
  }

  async createFollowUpStep(data: InsertFollowUpStep) {
    const [step] = await db.insert(followUpSteps).values(data).returning();
    return step;
  }

  async getFollowUpSteps(sequenceId: string) {
    return await db
      .select()
      .from(followUpSteps)
      .where(eq(followUpSteps.sequenceId, sequenceId))
      .orderBy(followUpSteps.stepNumber);
  }

  async scheduleFollowUp(data: InsertFollowUp) {
    const [followUp] = await db.insert(followUps).values(data).returning();
    return followUp;
  }

  async getFollowUpsByClient(clientId: string, status?: string) {
    if (status) {
      return await db
        .select()
        .from(followUps)
        .where(
          and(eq(followUps.clientId, clientId), eq(followUps.status, status))
        )
        .orderBy(followUps.scheduledFor);
    }

    return await db
      .select()
      .from(followUps)
      .where(eq(followUps.clientId, clientId))
      .orderBy(desc(followUps.createdAt));
  }

  async getPendingFollowUpsByClient(clientId: string) {
    return await db
      .select()
      .from(followUps)
      .where(
        and(eq(followUps.clientId, clientId), eq(followUps.status, "pending"))
      )
      .orderBy(followUps.scheduledFor);
  }

  // ✅ NEW: Get pending follow-ups by lead ID
  async getPendingFollowUpsByLead(leadId: string) {
    return await db
      .select()
      .from(followUps)
      .where(and(eq(followUps.leadId, leadId), eq(followUps.status, "pending")))
      .orderBy(followUps.scheduledFor);
  }

  async cancelFollowUp(followUpId: string) {
    const [cancelled] = await db
      .update(followUps)
      .set({
        status: "cancelled",
        updatedAt: new Date(),
      })
      .where(eq(followUps.id, followUpId))
      .returning();
    return cancelled;
  }

  // Schedule follow-up sequence for a lead
  async scheduleFollowUpSequence(
    leadId: string,
    sequenceId: string,
    conversationId?: string
  ) {
    console.log(
      `📅 [STORAGE] Scheduling follow-up sequence for lead: ${leadId}`
    );

    const lead = await this.getLead(leadId);
    if (!lead) {
      throw new Error("Lead not found");
    }

    const sequence = await this.getFollowUpSequence(sequenceId);
    if (!sequence) {
      throw new Error("Sequence not found");
    }

    const steps = await this.getFollowUpSteps(sequenceId);
    if (steps.length === 0) {
      console.log(`⚠️ [STORAGE] No steps in sequence ${sequenceId}`);
      return [];
    }

    const scheduledFollowUps = [];
    const now = new Date();

    for (const step of steps) {
      // Calculate when to send
      const scheduledFor = new Date(
        now.getTime() + step.delayMinutes * 60 * 1000
      );

      // Replace variables in content
      const content = step.content
        .replace(/{{firstName}}/g, lead.firstName || "there")
        .replace(/{{lastName}}/g, lead.lastName || "")
        .replace(/{{company}}/g, lead.company || "");

      const followUp = await this.scheduleFollowUp({
        sequenceId: sequence.id,
        stepId: step.id,
        leadId: lead.id,
        clientId: lead.clientId,
        conversationId,
        content,
        channel: step.channel || "whatsapp",
        scheduledFor,
        status: "pending",
        stepNumber: step.stepNumber,
      });

      scheduledFollowUps.push(followUp);
      console.log(
        `✅ [STORAGE] Scheduled step ${
          step.stepNumber
        } for ${scheduledFor.toISOString()}`
      );
    }

    return scheduledFollowUps;
  }

  // Get single follow-up by ID
  async getFollowUpById(id: string) {
    const result = await db
      .select()
      .from(followUps)
      .where(eq(followUps.id, id))
      .limit(1);

    return result[0] || null;
  }

  // Update follow-up status
  async updateFollowUp(
    id: string,
    data: {
      status?: string;
      sentAt?: Date;
      errorMessage?: string;
    }
  ) {
    await db
      .update(followUps)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(followUps.id, id));
  }

  /**
 * Store a failed message for retry
 */
async createFailedMessage(data: InsertFailedMessage): Promise<FailedMessage> {
  console.log(`💾 [STORAGE] Storing failed message for lead: ${data.leadId}`);
  
  const [failedMessage] = await db
    .insert(failedMessages)
    .values(data)
    .returning();
  
  console.log(`✅ [STORAGE] Failed message stored: ${failedMessage.id}`);
  return failedMessage;
}

/**
 * Get pending failed messages ready for retry
 */
async getPendingFailedMessages(limit: number = 50): Promise<FailedMessage[]> {
  const now = new Date();
  
  return await db
    .select()
    .from(failedMessages)
    .where(
      and(
        eq(failedMessages.status, "pending"),
        sql`${failedMessages.retryAfter} <= ${now}`,
        sql`${failedMessages.retryCount} < ${failedMessages.maxRetries}`
      )
    )
    .orderBy(failedMessages.retryAfter)
    .limit(limit);
}

/**
 * Update failed message status
 */
async updateFailedMessage(
  id: string,
  updates: Partial<InsertFailedMessage>
): Promise<void> {
  await db
    .update(failedMessages)
    .set(updates)
    .where(eq(failedMessages.id, id));
}

/**
 * Get on-call team member (user with notifications enabled)
 */
async getOnCallTeamMember(): Promise<User | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.isActive, true),
        eq(users.role, "user"), // Not super_admin
        eq(users.emailNotifications, true)
      )
    )
    .orderBy(desc(users.lastLoginAt))
    .limit(1);
  
  return user || null;
}

/**
 * Get failed messages statistics
 */
async getFailedMessagesStats(clientId: string): Promise<{
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  escalated: number;
}> {
  const allMessages = await db
    .select()
    .from(failedMessages)
    .where(eq(failedMessages.clientId, clientId));
  
  return {
    total: allMessages.length,
    pending: allMessages.filter(m => m.status === 'pending').length,
    processing: allMessages.filter(m => m.status === 'processing').length,
    completed: allMessages.filter(m => m.status === 'completed').length,
    failed: allMessages.filter(m => m.status === 'failed').length,
    escalated: allMessages.filter(m => m.status === 'escalated').length,
  };
}
}

export const storage = new DatabaseStorage();

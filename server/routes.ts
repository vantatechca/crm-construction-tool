// server/routes.ts
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
// import vslapp from "./routes/vsl.route";
import {
  insertLeadSchema,
  insertClientSchema,
  insertBookingSchema,
  messages,
  subscriptions,
  users,
} from "@shared/schema";

import { whatsappService } from "./services/whatsapp";
import { leadQualificationService } from "./services/leadQualification";
import advancedRoutes from "./advanced-routes";
import { emailService } from "./services/email";
import {
  startReminderCron,
  setBroadcastFunction,
} from "./services/reminder-cron";
import bcrypt from "bcrypt";
import { requireAuth, requireSuperAdmin } from "./middleware/auth";

import { generateVSLScript, generateAudit } from "./services/claude";
import { vslGenerator } from "./services/vsl-generator";
import { sql, eq, desc } from "drizzle-orm";
import { db } from "./db";
import { normalizePhone, normalizeEmail } from "./utils/normalize";
import { cloudinaryService } from "./services/cloudinary.service";
import { sessionManager } from "./services/session-manager";


// Helper function to check if user owns the resource
function checkOwnership(
  userRole: string,
  resourceUserId: string,
  requestUserId: string
): boolean {
  // Super admin can view anything (read-only for support)
  if (userRole === "super_admin") {
    return true;
  }

  // Regular users can only access their own data
  return resourceUserId === requestUserId;
}

// Helper function to check for booking conflicts
function hasBookingConflict(
  newStart: Date,
  newEnd: Date,
  existingBookings: any[],
  excludeBookingId?: string
): { hasConflict: boolean; conflictingBooking?: any } {
  console.log("🔍 Checking for conflicts:");
  console.log(
    "  New booking:",
    newStart.toISOString(),
    "to",
    newEnd.toISOString()
  );
  console.log(
    "  Checking against",
    existingBookings.length,
    "existing bookings"
  );

  for (const booking of existingBookings) {
    // Skip cancelled/completed bookings and the booking being rescheduled
    if (booking.status !== "scheduled" || booking.id === excludeBookingId) {
      console.log(
        `  ⏭️  Skipping booking ${booking.id} (status: ${booking.status})`
      );
      continue;
    }

    const existingStart = new Date(booking.scheduledFor);
    const existingEnd = new Date(
      existingStart.getTime() + booking.duration * 60000
    );

    console.log(`  📋 Checking: ${booking.title}`);
    console.log(
      `     Existing: ${existingStart.toISOString()} to ${existingEnd.toISOString()}`
    );

    // Check if times overlap
    const hasOverlap =
      (newStart >= existingStart && newStart < existingEnd) || // New starts during existing
      (newEnd > existingStart && newEnd <= existingEnd) || // New ends during existing
      (newStart <= existingStart && newEnd >= existingEnd); // New encompasses existing

    if (hasOverlap) {
      console.log("  ❌ CONFLICT DETECTED!");
      return { hasConflict: true, conflictingBooking: booking };
    } else {
      console.log("  ✅ No conflict");
    }
  }

  console.log("✅ No conflicts found");
  return { hasConflict: false };
}

export async function registerRoutes(app: Express): Promise<Server> {
  if (process.env.STRIPE_SECRET_KEY) {
    const { default: stripeRouter } = await import("./routes/stripe");
    app.use("/api/stripe", requireAuth, stripeRouter);
  } else {
    app.use("/api/stripe", (_req, res) =>
      res.status(503).json({ error: "Stripe is not configured" })
    );
  }
  const httpServer = createServer(app);

  // app.use(vslapp);

  let wss: WebSocketServer | null = null;
  function broadcastUpdate(data: any) {
    if (!wss) return;
    const message = JSON.stringify(data);
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        // WebSocket.OPEN
        client.send(message);
      }
    });
  }

  // WebSocket server for real-time updates
  wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    // ✅ Add stability options
    clientTracking: true,
    perMessageDeflate: false,
  });

  leadQualificationService.setWebSocketServer(wss);

  // ✅ Connection tracking
  let connectionCount = 0;

  wss.on("connection", (ws: WebSocket) => {
    connectionCount++;
    const clientId = connectionCount;
    console.log(
      `✅ WebSocket client connected #${clientId} (Total: ${wss.clients.size})`
    );

    // ✅ Send immediate connection confirmation
    ws.send(
      JSON.stringify({
        type: "connection_established",
        clientId,
        timestamp: new Date().toISOString(),
      })
    );

    // ✅ Heartbeat/ping-pong to keep connection alive
    let isAlive = true;

    ws.on("pong", () => {
      isAlive = true;
    });

    const pingInterval = setInterval(() => {
      if (!isAlive) {
        console.log(
          `💔 Client #${clientId} didn't respond to ping, terminating`
        );
        return ws.terminate();
      }

      isAlive = false;
      ws.ping();
    }, 30000); // Ping every 30 seconds

    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());
        console.log(`📨 Received from client #${clientId}:`, data);

        // Handle client messages if needed (e.g., authentication)
      } catch (error) {
        console.error(
          `❌ Error parsing message from client #${clientId}:`,
          error
        );
      }
    });

    ws.on("close", () => {
      clearInterval(pingInterval);
      console.log(
        `🔌 WebSocket client disconnected #${clientId} (Remaining: ${wss.clients.size})`
      );
    });

    ws.on("error", (error) => {
      console.error(`❌ WebSocket error for client #${clientId}:`, error);
      clearInterval(pingInterval);
    });
  });

  console.log("✅ WebSocket server initialized on path: /ws");


  // ========================= SESSION ROUTES =========================================
  // Get user's active sessions
app.get("/api/user/sessions", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const currentSessionId = req.sessionID;

    const sessions = await sessionManager.getUserSessions(userId);

    // Mark current session
    const sessionsWithCurrent = sessions.map((session) => ({
      ...session,
      isCurrent: session.sessionId === currentSessionId,
    }));

    res.json({ sessions: sessionsWithCurrent });
  } catch (error: any) {
    console.error("❌ Error fetching sessions:", error);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// Revoke a specific session
app.delete("/api/user/sessions/:sessionId", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const { sessionId } = req.params;
    const currentSessionId = req.sessionID;

    // Prevent revoking current session
    if (sessionId === currentSessionId) {
      return res.status(400).json({
        error: "Cannot revoke current session. Use logout instead.",
      });
    }

    const success = await sessionManager.revokeSession(sessionId, userId);

    if (success) {
      res.json({ success: true, message: "Session revoked successfully" });
    } else {
      res.status(404).json({ error: "Session not found" });
    }
  } catch (error: any) {
    console.error("❌ Error revoking session:", error);
    res.status(500).json({ error: "Failed to revoke session" });
  }
});

// Revoke all other sessions
app.post("/api/user/sessions/revoke-all", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const currentSessionId = req.sessionID;

    const count = await sessionManager.revokeAllOtherSessions(
      currentSessionId,
      userId
    );

    res.json({
      success: true,
      message: `${count} session(s) revoked successfully`,
      count,
    });
  } catch (error: any) {
    console.error("❌ Error revoking sessions:", error);
    res.status(500).json({ error: "Failed to revoke sessions" });
  }
});

// Check session health
app.get("/api/user/session/status", requireAuth, async (req, res) => {
  try {
    const session = req.session as any;

    res.json({
      sessionId: req.sessionID,
      userId: session.userId,
      createdAt: session.createdAt,
      expiresAt: new Date(Date.now() + (session.cookie.maxAge || 0)),
      maxAge: session.cookie.maxAge,
      deviceInfo: session.deviceInfo,
      ipAddress: session.ipAddress,
    });
  } catch (error: any) {
    console.error("❌ Error checking session:", error);
    res.status(500).json({ error: "Failed to check session status" });
  }
});

  // ========================= LEADS ROUTE ======================================

  // Landing page lead capture
  app.post("/api/leads", async (req, res) => {
    try {
      const leadData = insertLeadSchema.parse(req.body);

      // Normalize phone and email BEFORE creating lead
      if (leadData.phone) {
        leadData.phone = normalizePhone(leadData.phone);
      }
      if (leadData.email) {
        leadData.email = normalizeEmail(leadData.email);
      }

      const auditInputs = req.body.auditInputs || {};
      const auditType = req.body.auditType || "construction";

      const firstName =
        req.body.firstName ||
        auditInputs.contactName?.split(" ")[0] ||
        "Unknown";
      const lastName =
        req.body.lastName ||
        auditInputs.contactName?.split(" ").slice(1).join(" ") ||
        "";

      // Audit results
      const auditResults = {
        type: auditType,
        source: "landing_page",
        projectType: auditInputs.projectType || "Unknown",
        timestamp: new Date().toISOString(),
        topFinding: "Construction inquiry received",
        wins: ["Lead captured from landing page"],
        risks: [],
        score: 15,
        timeline: "To be discussed",
        estimatedROI: "TBD",
      };

      // Calculate temperature
      const qualificationScore = 0.15;
      let temperature: "hot" | "warm" | "cold";

      if (qualificationScore >= 0.7) {
        temperature = "hot";
      } else if (qualificationScore >= 0.4) {
        temperature = "warm";
      } else {
        temperature = "cold";
      }

      // ✅ UPSERT: Create or update lead
      const lead = await storage.createLead({
        ...leadData,
        firstName,
        lastName,
        auditResults: auditResults,
        status: "new",
        qualificationScore: "0.15",
        temperature: temperature,
      });

      // ✅ Check if this is a re-submission
      const isResubmission = (lead.submissionCount || 1) > 1;

      if (isResubmission) {
        console.log(
          `♻️ [LEAD] Re-submission detected (count: ${lead.submissionCount})`
        );
      }

      // ✅ Send WhatsApp message (only if new OR first time in 24hrs)
      if (lead.phone) {
        // Check if we should send intro message
        const shouldSendIntro =
          !isResubmission ||
          !lead.lastSubmittedAt ||
          new Date().getTime() - new Date(lead.lastSubmittedAt).getTime() >
            24 * 60 * 60 * 1000;

        if (shouldSendIntro) {
          const introMessage = `Hi ${firstName}! 👋

Thanks for reaching out about your construction project!

I'm here to help you get started. To provide the best assistance, could you tell me:

1️⃣ What type of project? (e.g., kitchen remodel, new build, addition)
2️⃣ Approximate budget range?
3️⃣ When are you hoping to start?

Reply with the details and I'll connect you with our team right away! 🏗️`;

          await whatsappService.sendTextMessage(lead.phone, introMessage);

          // Create or get conversation
          let conversations = await storage.getConversations(
            leadData.clientId,
            100
          );
          let conversation = conversations.find((c) => c.leadId === lead.id);

          if (!conversation) {
            const newConv = await storage.createConversation({
              leadId: lead.id,
              clientId: lead.clientId,
              channel: "whatsapp",
              status: "active",
              isAiHandled: true,
              qualificationScore: "0.0",
            });

            conversations = await storage.getConversations(
              leadData.clientId,
              100
            );
            conversation = conversations.find((c) => c.leadId === lead.id);
          }

          if (conversation) {
            await storage.createMessage({
              conversationId: conversation.id,
              content: introMessage,
              sender: "ai",
              channel: "whatsapp",
              sentAt: new Date(),
              deliveredAt: new Date(),
              isStatusMessage: true,
            });

            console.log(
              "✅ Intro message sent and recorded for lead:",
              lead.id
            );

            broadcastUpdate({
              type: "new_conversation",
              conversation: {
                ...conversation,
                lead: lead,
              },
              leadId: lead.id,
            });
          }
        } else {
          console.log(`ℹ️ [LEAD] Skipping intro message (sent recently)`);
        }
      }

      // Schedule follow-ups (only for new leads)
      if (!isResubmission) {
        try {
          console.log(`📅 Scheduling follow-ups for new lead: ${lead.id}`);

          const sequences = await storage.getFollowUpSequences(
            leadData.clientId
          );
          const defaultSequence = sequences.find(
            (s) => s.isDefault && s.status === "active"
          );

          if (defaultSequence) {
            const conversations = await storage.getConversations(
              leadData.clientId,
              100
            );
            const conversation = conversations.find(
              (c) => c.leadId === lead.id
            );

            await storage.scheduleFollowUpSequence(
              lead.id,
              defaultSequence.id,
              conversation?.id
            );

            console.log(
              `✅ Scheduled ${defaultSequence.name} for lead: ${lead.id}`
            );
          }
        } catch (error) {
          console.error("❌ Error scheduling follow-ups:", error);
        }
      }

      // ✅ Return appropriate message
      res.json({
        success: true,
        leadId: lead.id,
        auditResults: lead.auditResults,
        isResubmission,
        submissionCount: lead.submissionCount,
        message: isResubmission
          ? "Thanks for the update! We'll be in touch soon."
          : "Thanks! Check your WhatsApp for next steps.",
      });
    } catch (error) {
      console.error("Error creating lead:", error);

      // ✅ Handle unique constraint violations gracefully
      if (
        error instanceof Error &&
        error.message.includes("unique constraint")
      ) {
        return res.status(409).json({
          message:
            "This contact information is already in our system. We'll be in touch soon!",
        });
      }

      res.status(400).json({
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
  // Update lead with manual overrides
  app.patch("/api/leads/:leadId/manual", async (req, res) => {
    try {
      const { leadId } = req.params;
      const userId = (req as any).user?.id; // Get from session if available

      console.log("📝 Manual lead update:", leadId, req.body);

      const lead = await storage.updateLeadManual(leadId, req.body, userId);

      console.log("✅ Lead updated:", lead);

      res.json(lead);
    } catch (error) {
      console.error("❌ Error updating lead:", error);
      res.status(500).json({ message: "Failed to update lead" });
    }
  });

  // Get lead activity log
  app.get("/api/leads/:leadId/activity", async (req, res) => {
    try {
      const { leadId } = req.params;
      const activity = await storage.getLeadActivityLog(leadId);
      res.json(activity);
    } catch (error) {
      console.error("Error fetching activity log:", error);
      res.status(500).json({ message: "Failed to fetch activity log" });
    }
  });

  // Get available tags for client
  app.get("/api/lead-tags/:clientId", async (req, res) => {
    try {
      const { clientId } = req.params;
      const tags = await storage.getLeadTags(clientId);
      res.json(tags);
    } catch (error) {
      console.error("Error fetching tags:", error);
      res.status(500).json({ message: "Failed to fetch tags" });
    }
  });

  // Create new tag
  app.post("/api/lead-tags", async (req, res) => {
    try {
      const tag = await storage.createLeadTag(req.body);
      res.json(tag);
    } catch (error) {
      console.error("Error creating tag:", error);
      res.status(500).json({ message: "Failed to create tag" });
    }
  });

  // Lead management routes
  app.get("/api/leads/:clientId", requireAuth, async (req, res) => {
    try {
      const { clientId } = req.params;
      const requestUser = req.user!;

      // Verify ownership
      if (requestUser.role !== "super_admin") {
        const client = await storage.getClient(clientId);
        if (!client || client.userId !== requestUser.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const leads = await storage.getLeads(clientId, 100);
      res.json(leads);
    } catch (error) {
      console.error("Error fetching leads:", error);
      res.status(500).json({ message: "Failed to fetch leads" });
    }
  });

  // Mark lead as viewed
  app.post("/api/leads/:leadId/view", async (req, res) => {
    try {
      const { leadId } = req.params;

      // Update lead with viewedAt timestamp
      const lead = await storage.updateLead(leadId, {
        viewedAt: new Date(),
      });

      res.json({ success: true, lead });
    } catch (error) {
      console.error("Error marking lead as viewed:", error);
      res.status(500).json({ message: "Failed to mark lead as viewed" });
    }
  });

  app.patch("/api/leads/:leadId", async (req, res) => {
    try {
      const { leadId } = req.params;
      const updateData = req.body;

      const lead = await storage.updateLead(leadId, {
        ...updateData,
        updatedAt: new Date(),
      });

      res.json(lead);
    } catch (error) {
      console.error("Error updating lead:", error);
      res.status(500).json({ message: "Failed to update lead" });
    }
  });

  app.delete("/api/leads/:leadId", async (req, res) => {
    try {
      const { leadId } = req.params;
      await storage.deleteLeadAndAssociations(leadId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting lead:", error);
      res.status(500).json({ message: "Failed to delete lead" });
    }
  });

  // Export leads to CSV
  app.get("/api/leads/:clientId/export", requireAuth, async (req, res) => {
    try {
      const { clientId } = req.params;
      const requestUser = req.user!;

      // Verify ownership
      if (requestUser.role !== "super_admin") {
        const client = await storage.getClient(clientId);
        if (!client || client.userId !== requestUser.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const leads = await storage.getLeads(clientId, 10000); // Get all leads

      // Build CSV
      const csvHeaders = [
        "Name",
        "Email",
        "Phone",
        "Company",
        "Score",
        "Status",
        "Temperature",
        "Source",
        "Created",
        "Last Contact",
        "Tags",
      ].join(",");

      const csvRows = leads.map((lead) => {
        const name = `${lead.firstName || ""} ${lead.lastName || ""}`.trim();
        const score = (
          parseFloat(lead.manualScore || lead.qualificationScore || "0") * 100
        ).toFixed(0);
        const created = lead.createdAt
          ? new Date(lead.createdAt).toLocaleDateString()
          : "";
        const lastContact = lead.lastContactedAt
          ? new Date(lead.lastContactedAt).toLocaleDateString()
          : "Never";
        const tags = Array.isArray(lead.tags) ? lead.tags.join("; ") : "";

        return [
          `"${name}"`,
          `"${lead.email || ""}"`,
          `"${lead.phone || ""}"`,
          `"${lead.company || ""}"`,
          `"${score}%"`,
          `"${lead.status || "new"}"`,
          `"${lead.temperature || "cold"}"`,
          `"${lead.source || ""}"`,
          `"${created}"`,
          `"${lastContact}"`,
          `"${tags}"`,
        ].join(",");
      });

      const csv = [csvHeaders, ...csvRows].join("\n");

      // Set headers for download
      const filename = `leads-export-${
        new Date().toISOString().split("T")[0]
      }.csv`;
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );

      res.send(csv);
    } catch (error) {
      console.error("Error exporting leads:", error);
      res.status(500).json({ message: "Failed to export leads" });
    }
  });

  // ============================ WHATSAPP WEBHOOK ROUTES  ==================================

  // WhatsApp webhook
  app.post("/api/webhooks/whatsapp", async (req, res) => {
    try {
      const incomingMessage = whatsappService.parseWebhook(req.body);

      if (incomingMessage) {
        console.log("📩 Parsed webhook:", {
          from: incomingMessage.from,
          message: incomingMessage.message.substring(0, 50),
          messageId: incomingMessage.messageId,
          hasReaction: !!incomingMessage.reaction,
          hasReadReceipt: !!incomingMessage.readReceipt,
        });

        // ✅ HANDLE READ RECEIPTS
        if (incomingMessage.readReceipt) {
          console.log(
            "📖 Processing read receipt:",
            incomingMessage.readReceipt
          );

          try {
            const allMessages = await db
              .select()
              .from(messages)
              .where(
                sql`${messages.metadata}->>'whatsappMessageId' = ${incomingMessage.readReceipt.messageId}`
              )
              .limit(1);

            if (allMessages.length === 0) {
              console.log(
                `❌ Message not found with WhatsApp ID: ${incomingMessage.readReceipt.messageId}`
              );
              return res.status(200).send("OK");
            }

            const message = allMessages[0];
            console.log(`✅ Found message: ${message.id}`);

            await db
              .update(messages)
              .set({
                readAt: new Date(incomingMessage.readReceipt.timestamp * 1000),
              })
              .where(eq(messages.id, message.id));

            console.log(`✅ Message marked as read in database`);

            broadcastUpdate({
              type: "message_read",
              messageId: message.id,
              conversationId: message.conversationId,
              readAt: new Date(incomingMessage.readReceipt.timestamp * 1000),
            });

            console.log(`✅ Read receipt broadcasted via WebSocket`);
          } catch (error) {
            console.error("❌ Error processing read receipt:", error);
          }

          return res.status(200).send("OK");
        }

        // ✅ Handle reactions
        if (incomingMessage.reaction) {
          console.log(
            "😊 Received WhatsApp reaction:",
            incomingMessage.reaction
          );

          try {
            const allMessages = await db
              .select()
              .from(messages)
              .where(
                sql`${messages.metadata}->>'whatsappMessageId' = ${incomingMessage.reaction.messageId}`
              )
              .limit(1);

            if (allMessages.length === 0) {
              console.log(
                `❌ Message not found with WhatsApp ID: ${incomingMessage.reaction.messageId}`
              );
              return res.status(200).send("OK");
            }

            const message = allMessages[0];
            console.log(`✅ Found message: ${message.id}`);

            const lead = await storage.getLeadByPhone(incomingMessage.from);

            if (!lead) {
              console.log(
                `❌ Lead not found for phone: ${incomingMessage.from}`
              );
              return res.status(200).send("OK");
            }

            console.log(`✅ Found lead: ${lead.firstName} ${lead.lastName}`);

            if (
              !incomingMessage.reaction.emoji ||
              incomingMessage.reaction.emoji.trim() === ""
            ) {
              console.log(`🗑️ Removing reaction from lead`);
              await storage.removeReaction(message.id, lead.id, "");
              console.log(`✅ Reaction removed from database`);
            } else {
              await storage.addReaction(message.id, {
                emoji: incomingMessage.reaction.emoji,
                userId: lead.id,
                userName: `${lead.firstName} ${lead.lastName}`,
              });
              console.log(`✅ Reaction saved to database`);
            }

            const updatedMessage = await storage.getMessage(message.id);

            broadcastUpdate({
              type: "message_reacted",
              messageId: message.id,
              reactions: updatedMessage?.reactions,
              conversationId: message.conversationId,
            });

            console.log(`✅ Reaction broadcasted via WebSocket`);
          } catch (error) {
            console.error("❌ Error processing reaction:", error);
          }

          return res.status(200).send("OK");
        }

        // ✅ Handle regular message
        console.log("📨 Processing regular message from lead");

        // Queue the message for processing
        await leadQualificationService.queueIncomingMessage(
          incomingMessage.from,
          incomingMessage.message,
          incomingMessage.timestamp,
          incomingMessage.phoneNumberId,
          incomingMessage.messageId
        );

        // Cancel pending follow-ups when lead replies
        try {
          const lead = await storage.getLeadByPhone(incomingMessage.from);

          if (lead) {
            // Check if there are any pending follow-ups
            const pendingFollowUps = await storage.getPendingFollowUpsByLead(
              lead.id
            );

            if (pendingFollowUps.length > 0) {
              console.log(
                `✅ Lead replied with pending follow-ups: ${lead.firstName} ${lead.lastName}`
              );
              console.log(
                `📋 Found ${pendingFollowUps.length} pending follow-ups to cancel`
              );

              // Cancel all pending follow-ups for this lead
              const { cancelPendingFollowUps } = await import(
                "./services/follow-up-worker"
              );
              await cancelPendingFollowUps(lead.id);

              console.log(
                `🚫 Cancelled ${pendingFollowUps.length} pending follow-ups for lead: ${lead.id}`
              );
            } else {
              console.log(
                `ℹ️ No pending follow-ups to cancel for lead: ${lead.id}`
              );
            }
          }
        } catch (error) {
          console.error("❌ Error cancelling follow-ups:", error);
        }

        // ✅ NEW: Find the lead and conversation to broadcast immediately
        try {
          const lead = await storage.getLeadByPhone(incomingMessage.from);

          if (lead) {
            console.log(`✅ Found lead: ${lead.firstName} ${lead.lastName}`);

            // Find or get the conversation
            const conversations = await storage.getConversations(
              lead.clientId,
              100
            );
            const conversation = conversations.find(
              (c) => c.leadId === lead.id
            );

            if (conversation) {
              console.log(`✅ Found conversation: ${conversation.id}`);

              // Broadcast new message event
              broadcastUpdate({
                type: "new_message",
                conversationId: conversation.id,
                leadId: lead.id,
                preview: incomingMessage.message.substring(0, 50),
              });

              console.log(`✅ New message broadcasted via WebSocket`);
            } else {
              console.log(`⚠️ No conversation found for lead ${lead.id}`);
            }
          } else {
            console.log(`⚠️ No lead found for phone: ${incomingMessage.from}`);
          }
        } catch (error) {
          console.error("❌ Error broadcasting new message:", error);
        }
      }

      res.status(200).send("OK");
    } catch (error) {
      console.error("WhatsApp webhook error:", error);
      res.status(500).json({ message: "Webhook processing failed" });
    }
  });

  // WhatsApp webhook verification
  app.get("/api/webhooks/whatsapp", (req, res) => {
    const verifyToken =
      process.env.WHATSAPP_VERIFY_TOKEN || "default_verify_token";
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    console.log("=== WEBHOOK VERIFICATION ===");
    console.log("Expected token:", verifyToken);
    console.log("Received token:", token);
    console.log("Mode:", mode);
    console.log("Challenge:", challenge);

    if (mode && token === verifyToken) {
      console.log("✅ Verification successful");
      res.status(200).send(challenge);
    } else {
      console.log("❌ Verification failed - token mismatch");
      res.status(403).send("Forbidden");
    }
  });

  // ======================= CLIENT ROUTES WITH AUTH ========================

  // Get clients - users see their own, super admin sees all
  app.get("/api/clients", requireAuth, async (req, res) => {
    try {
      const userId = req.query.userId as string;
      const requestUser = req.user!; // Guaranteed by requireAuth

      console.log("=== 🔍 CLIENTS API DEBUG ===");
    console.log("📧 User email:", requestUser?.email);
    console.log("🎭 User role:", requestUser?.role);
    console.log("🆔 Session user ID:", requestUser?.id);
    console.log("🔑 Query userId:", userId);
    console.log("🤝 Do they match?", userId === requestUser?.id);
    console.log("🍪 Has session?", !!req.session);
    console.log("🔐 Is authenticated?", req.isAuthenticated?.());

      // ✅ Safety check
    if (!requestUser || !requestUser.id) {
      console.error("❌ No authenticated user in session!");
      return res.status(401).json({
        message: "Not authenticated. Please log in.",
      });
    }

      // Super admin can see all clients
    if (requestUser.role === "super_admin") {
      const allClients = await storage.getAllClients();
      console.log("✅ Super admin: returning", allClients.length, "clients");
      return res.json(allClients);
    }

      // ✅ Use authenticated user ID if not provided
    const effectiveUserId = userId || requestUser.id;

    // Regular users can only see THEIR OWN clients
    if (effectiveUserId !== requestUser.id) {
      console.log("❌ ID MISMATCH!");
      console.log("   Requested:", effectiveUserId);
      console.log("   Authenticated:", requestUser.id);
      return res.status(403).json({
        message: "Access denied: You can only view your own clients",
      });
    }

      const clients = await storage.getClients(effectiveUserId);
    console.log("✅ Returning", clients.length, "clients for user:", requestUser.email);

      res.json(clients);
    } catch (error) {
      console.error("Error fetching clients:", error);
      res.status(500).json({ message: "Failed to fetch clients" });
    }
  });

  // Create client - only authenticated users (not super admin)
  app.post("/api/clients", requireAuth, async (req, res) => {
    try {
      const requestUser = req.user!; // Guaranteed by requireAuth

      // Super admin CANNOT create clients
      if (requestUser.role === "super_admin") {
        return res.status(403).json({
          message:
            "Super admins cannot create clients. Users manage their own clients.",
        });
      }

      // Always use authenticated user's ID
      const clientData = {
        ...req.body,
        userId: requestUser.id, // Force to authenticated user
      };

      console.log("✅ Creating client for user:", requestUser.email);
      const client = await storage.createClient(clientData);
      res.json(client);
    } catch (error) {
      console.error("Error creating client:", error);
      res.status(400).json({
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Update client
  app.patch("/api/clients/:clientId", requireAuth, async (req, res) => {
    try {
      const { clientId } = req.params;
      const requestUser = req.user!;

      // Get existing client to verify ownership
      const existingClient = await storage.getClient(clientId);
      if (!existingClient) {
        return res.status(404).json({ message: "Client not found" });
      }

      // Verify ownership (super admin can view but NOT edit)
      if (requestUser.role === "super_admin") {
        return res.status(403).json({
          message:
            "Super admins cannot edit clients. This is read-only access.",
        });
      }

      if (existingClient.userId !== requestUser.id) {
        return res.status(403).json({ message: "Access denied" });
      }

      // Update client
      const updatedClient = await storage.updateClient(clientId, req.body);

      console.log("✅ Client updated:", updatedClient.name);

      res.json(updatedClient);
    } catch (error) {
      console.error("Error updating client:", error);
      res.status(500).json({ message: "Failed to update client" });
    }
  });

  // Export clients to CSV
  app.get("/api/clients/export", requireAuth, async (req, res) => {
    try {
      const userId = req.query.userId as string;
      const requestUser = req.user!;

      // Verify ownership
      let clients;
      if (requestUser.role === "super_admin") {
        clients = await storage.getAllClientsWithUsers();
      } else {
        if (!userId || userId !== requestUser.id) {
          return res.status(403).json({ message: "Access denied" });
        }
        clients = await storage.getClients(userId);
      }

      // Build CSV
      const csvHeaders = [
        "Company Name",
        "Industry",
        "Website",
        "Email",
        "Phone",
        "WhatsApp Number",
        "Status",
        "Created Date",
      ].join(",");

      const csvRows = clients.map((client: any) => {
        const created = client.createdAt
          ? new Date(client.createdAt).toLocaleDateString()
          : "";

        return [
          `"${client.name || ""}"`,
          `"${client.industry || ""}"`,
          `"${client.website || ""}"`,
          `"${client.email || ""}"`,
          `"${client.phone || ""}"`,
          `"${client.whatsappNumber || ""}"`,
          `"${client.isActive ? "Active" : "Inactive"}"`,
          `"${created}"`,
        ].join(",");
      });

      const csv = [csvHeaders, ...csvRows].join("\n");

      // Set headers for download
      const filename = `clients-export-${
        new Date().toISOString().split("T")[0]
      }.csv`;
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );

      res.send(csv);
    } catch (error) {
      console.error("Error exporting clients:", error);
      res.status(500).json({ message: "Failed to export clients" });
    }
  });

  // Delete client
  app.delete("/api/clients/:clientId", requireAuth, async (req, res) => {
    try {
      const { clientId } = req.params;
      const requestUser = req.user!;

      // Get client to verify ownership
      const client = await storage.getClient(clientId);
      if (!client) {
        return res.status(404).json({ message: "Client not found" });
      }

      // Verify ownership (super admin cannot delete)
      if (requestUser.role === "super_admin") {
        return res.status(403).json({
          message: "Super admins cannot delete clients.",
        });
      }

      if (client.userId !== requestUser.id) {
        return res.status(403).json({ message: "Access denied" });
      }

      // Delete client (cascade)
      await storage.deleteClient(clientId);

      // Log activity
      await storage.logUserActivity(
        requestUser.id,
        "client_deleted",
        "client",
        {
          clientId,
          clientName: client.name,
        }
      );

      res.json({ success: true, message: "Client deleted successfully" });
    } catch (error: any) {
      console.error("Error deleting client:", error);
      res.status(500).json({
        message: error.message || "Failed to delete client",
      });
    }
  });

  // ============================ DASHBOARD ROUTES  ==============================

  // Dashboard data
  app.get("/api/dashboard/:clientId", requireAuth, async (req, res) => {
    try {
      const { clientId } = req.params;
      const requestUser = req.user!;

      // Verify access
      if (requestUser.role !== "super_admin") {
        const client = await storage.getClient(clientId);
        if (!client || client.userId !== requestUser.id) {
          console.error(
            `❌ [DASHBOARD] Access denied for user ${requestUser.id}`
          );
          return res.status(403).json({ message: "Access denied" });
        }
        console.log(`✅ [DASHBOARD] Client verified: ${client.name}`);
      }

      // ✅ FIXED: Renamed to avoid collision
      const rawLeads = await storage.getLeads(clientId, 1000);
      const rawConversations = await storage.getConversations(clientId, 1000);
      const rawBookings = await storage.getBookings(clientId);

      if (rawLeads.length > 0) {
        // ✅ FIXED: Check for null before creating Date
        if (rawLeads[0].createdAt) {
          const now = new Date();
          const thirtyDaysAgo = new Date(
            now.getTime() - 30 * 24 * 60 * 60 * 1000
          );
          const leadDate = new Date(rawLeads[0].createdAt);
          const isWithin30Days = leadDate >= thirtyDaysAgo;
        } else {
          console.warn(`  - ⚠️ First Lead has no createdAt date!`);
        }
      }
      console.log(`\n========================================\n`);

      // Fetch dashboard data with error handling
      const [kpis, conversations, hotLeads, recentActivity, leads, bookings] =
        await Promise.all([
          storage.getKPIs(clientId).catch((err) => {
            console.error("❌ [DASHBOARD] Error fetching KPIs:", err.message);
            return {
              totalLeads: 0,
              conversionRate: 0,
              avgResponseTime: 0,
              aiHandledPercentage: 0,
              totalLeadsChange: 0,
              conversionRateChange: 0,
              avgResponseTimeChange: 0,
              aiHandledPercentageChange: 0,
              convertedLeads: 0,
              aiAvgResponseTime: 0,
              humanAvgResponseTime: 0,
            };
          }),
          storage.getConversations(clientId, 50).catch((err) => {
            console.error(
              "❌ [DASHBOARD] Error fetching conversations:",
              err.message
            );
            return [];
          }),
          storage.getHotLeads(clientId).catch((err) => {
            console.error(
              "❌ [DASHBOARD] Error fetching hot leads:",
              err.message
            );
            return [];
          }),
          storage.getRecentActivity(clientId).catch((err) => {
            console.error(
              "❌ [DASHBOARD] Error fetching recent activity:",
              err.message
            );
            return [];
          }),
          storage.getLeads(clientId, 100).catch((err) => {
            console.error("❌ [DASHBOARD] Error fetching leads:", err.message);
            return [];
          }),
          storage.getBookings(clientId).catch((err) => {
            console.error(
              "❌ [DASHBOARD] Error fetching bookings:",
              err.message
            );
            return [];
          }),
        ]);

      const conversationMap = new Map(conversations.map((c) => [c.id, c]));
      hotLeads.forEach((hl) => {
        if (!conversationMap.has(hl.id)) {
          conversationMap.set(hl.id, hl);
        }
      });

      // ✅ FIXED: Different variable name
      const allConversations = Array.from(conversationMap.values());

      res.json({
        kpis,
        conversations: allConversations,
        hotLeads,
        recentActivity,
        leads,
        bookings,
      });
    } catch (error: any) {
      console.error("❌ [DASHBOARD] Fatal error:", error);
      console.error("Stack trace:", error.stack);
      res.status(500).json({
        error: error.message,
        details:
          process.env.NODE_ENV === "development" ? error.stack : undefined,
      });
    }
  });

  // =========================== ANALYTICS ROUTES =================================
  // Analytics data endpoint
  app.get("/api/analytics/:clientId", requireAuth, async (req, res) => {
    try {
      const { clientId } = req.params;
      const { timeRange = "30" } = req.query; // days
      const requestUser = req.user!;

      console.log(
        `📊 [ANALYTICS] Fetching for client: ${clientId}, range: ${timeRange} days`
      );

      // Verify access
      if (requestUser.role !== "super_admin") {
        const client = await storage.getClient(clientId);
        if (!client || client.userId !== requestUser.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const days = parseInt(timeRange as string, 10);
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      // Fetch all data
      const [leads, conversations, bookings] = await Promise.all([
        storage.getLeads(clientId, 1000),
        storage.getAllConversations(clientId),
        storage.getBookings(clientId),
      ]);

      // Filter by date range
      const filteredLeads = leads.filter(
        (l) => new Date(l.createdAt!) >= startDate
      );
      const filteredConversations = conversations.filter(
        (c) => new Date(c.createdAt!) >= startDate
      );
      const filteredBookings = bookings.filter(
        (b) => new Date(b.createdAt!) >= startDate
      );

      const confirmedMeetingsCount = filteredBookings.filter(
        (b) => b.status === "scheduled" || b.status === "confirmed"
      ).length;

      console.log(
        `📊 [ANALYTICS] Filtered data: ${filteredLeads.length} leads, ${filteredConversations.length} conversations`
      );

      // ===== 1. LEAD TREND (Daily) =====
      const leadTrendMap = new Map<string, number>();
      filteredLeads.forEach((lead) => {
        const dateKey = new Date(lead.createdAt!).toISOString().split("T")[0];
        leadTrendMap.set(dateKey, (leadTrendMap.get(dateKey) || 0) + 1);
      });

      const leadTrend = Array.from(leadTrendMap.entries())
        .map(([date, count]) => ({
          date,
          leads: count,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // ===== 2. RESPONSE TIME BY HOUR =====
      const responseTimeByHour = Array.from({ length: 24 }, (_, i) => ({
        hour: i,
        hourLabel:
          i === 0
            ? "12 AM"
            : i < 12
            ? `${i} AM`
            : i === 12
            ? "12 PM"
            : `${i - 12} PM`,
        totalTime: 0,
        count: 0,
        avgTime: 0,
      }));

      filteredLeads.forEach((lead) => {
        if (lead.responseTimeSeconds && lead.createdAt) {
          const hour = new Date(lead.createdAt).getHours();
          responseTimeByHour[hour].totalTime += lead.responseTimeSeconds;
          responseTimeByHour[hour].count += 1;
        }
      });

      responseTimeByHour.forEach((hourData) => {
        hourData.avgTime =
          hourData.count > 0
            ? Math.round(hourData.totalTime / hourData.count)
            : 0;
      });

      // ===== 3. LEAD TEMPERATURE DISTRIBUTION =====
      const temperatureMap = {
        hot: 0,
        warm: 0,
        cold: 0,
      };

      filteredLeads.forEach((lead) => {
        const temp = lead.temperature || "cold";
        if (temp in temperatureMap) {
          temperatureMap[temp as keyof typeof temperatureMap]++;
        }
      });

      const temperatureData = [
        { name: "Hot", value: temperatureMap.hot, color: "#ef4444" },
        { name: "Warm", value: temperatureMap.warm, color: "#f59e0b" },
        { name: "Cold", value: temperatureMap.cold, color: "#3b82f6" },
      ];

      // ===== 4. LEAD STATUS DISTRIBUTION =====
      const statusMap = new Map<string, number>();
      filteredLeads.forEach((lead) => {
        const status = lead.status || "new";
        statusMap.set(status, (statusMap.get(status) || 0) + 1);
      });

      const statusData = Array.from(statusMap.entries()).map(
        ([status, count]) => ({
          status,
          count,
          percentage: ((count / filteredLeads.length) * 100).toFixed(1),
        })
      );

      // ===== 5. AI PERFORMANCE METRICS =====
      // ✅ FIX: AI handled = conversations with NO human takeover
      const aiConversations = filteredConversations.filter(
        (c) => !c.humanTakeoverAt
      );

      // ✅ FIX: Human handled = conversations WITH human takeover
      const humanConversations = filteredConversations.filter(
        (c) => c.humanTakeoverAt
      );

      // ✅ FIX: AI response time = ALWAYS responseTimeSeconds (AI always responds first)
      const aiLeads = filteredLeads.filter((l) => l.responseTimeSeconds);

      // ✅ FIX: Human response time = only for conversations with takeover
      const humanLeads = filteredLeads.filter((l) => {
        const conv = filteredConversations.find((c) => c.leadId === l.id);
        return conv?.humanTakeoverAt;
      });

      // Calculate AI average response (all leads, since AI always responds first)
      const aiAvgResponse =
        aiLeads.length > 0
          ? aiLeads.reduce((sum, l) => sum + (l.responseTimeSeconds || 0), 0) /
            aiLeads.length
          : 0;

      // Calculate Human average response (time from lead creation to human takeover)
      // ✅ FIX: Calculate Human average response (time from takeover to FIRST human message)
      let humanAvgResponse = 0;
      if (humanLeads.length > 0) {
        let totalHumanTime = 0;
        let validCount = 0;

        for (const lead of humanLeads) {
          const conv = filteredConversations.find((c) => c.leadId === lead.id);
          if (!conv?.humanTakeoverAt) continue;

          // Get all messages for this conversation
          const convMessages = await storage.getMessages(conv.id);

          // Find first human message AFTER takeover
          const firstHumanMsg = convMessages.find(
            (m) =>
              m.sender === "human" &&
              m.sentAt &&
              new Date(m.sentAt) > new Date(conv.humanTakeoverAt!)
          );

          if (firstHumanMsg && firstHumanMsg.sentAt) {
            const takeoverTime = new Date(conv.humanTakeoverAt).getTime();
            const firstResponseTime = new Date(firstHumanMsg.sentAt).getTime();
            const timeInSeconds = (firstResponseTime - takeoverTime) / 1000;

            if (timeInSeconds > 0) {
              totalHumanTime += timeInSeconds;
              validCount++;
            }
          }
        }

        humanAvgResponse = validCount > 0 ? totalHumanTime / validCount : 0;
      }

      // AI Qualification Rate (leads with score >= 0.4)
      const qualifiedByAI = filteredLeads.filter(
        (l) => parseFloat(l.qualificationScore || "0") >= 0.4
      ).length;
      const aiQualificationRate =
        filteredLeads.length > 0
          ? (qualifiedByAI / filteredLeads.length) * 100
          : 0;

      // Handoff Rate (% of conversations where human took over)
      const handoffCount = filteredConversations.filter(
        (c) => c.humanTakeoverAt
      ).length;
      const handoffRate =
        filteredConversations.length > 0
          ? (handoffCount / filteredConversations.length) * 100
          : 0;

      const aiPerformance = {
        totalAiHandled: aiConversations.length,
        totalHumanHandled: humanConversations.length,
        aiPercentage:
          filteredConversations.length > 0
            ? (
                (aiConversations.length / filteredConversations.length) *
                100
              ).toFixed(1)
            : "0",
        aiAvgResponseTime: Math.round(aiAvgResponse),
        humanAvgResponseTime: Math.round(humanAvgResponse),
        aiQualificationRate: aiQualificationRate.toFixed(1),
        handoffRate: handoffRate.toFixed(1),
        aiSpeedAdvantage:
          humanAvgResponse > 0 && aiAvgResponse > 0
            ? `${(
                ((humanAvgResponse - aiAvgResponse) / humanAvgResponse) *
                100
              ).toFixed(0)}%`
            : "N/A",
      };

      // ===== 6. BOOKING CONVERSION TIMELINE =====
      const bookingTimeline = filteredBookings
        .map((booking) => {
          const lead = leads.find((l) => l.id === booking.leadId);
          if (!lead || !lead.createdAt) return null;

          const leadCreated = new Date(lead.createdAt).getTime();
          const bookingCreated = new Date(booking.createdAt!).getTime();
          const hoursToBook = (bookingCreated - leadCreated) / (1000 * 60 * 60);

          return {
            leadId: lead.id,
            leadName: `${lead.firstName} ${lead.lastName}`,
            hoursToBook: Math.round(hoursToBook * 10) / 10,
            bookingDate: booking.createdAt,
          };
        })
        .filter(Boolean);

      const avgTimeToBook =
        bookingTimeline.length > 0
          ? bookingTimeline.reduce((sum, b) => sum + (b?.hoursToBook || 0), 0) /
            bookingTimeline.length
          : 0;

      // ===== 7. CONVERSION FUNNEL DATA =====
      // Stage 1: All Leads
      const totalLeadsCount = filteredLeads.length;

      // Stage 2: Qualified Leads (score >= 0.7)
      const qualifiedLeadsCount = filteredLeads.filter(
        (l) => parseFloat(l.qualificationScore || "0") >= 0.7
      ).length;

      // Stage 3: Meetings (scheduled or confirmed bookings)
      const meetingsCount = filteredBookings.filter(
        (b) => b.status === "scheduled" || b.status === "confirmed"
      ).length;

      // Stage 4: Proposals (pending or proposed bookings - awaiting approval)
      const proposalsCount = filteredBookings.filter(
        (b) => b.status === "pending_approval"
      ).length;

      // Stage 5: Closed (completed bookings)
      const closedCount = filteredBookings.filter(
        (b) => b.status === "completed"
      ).length;

      const conversionFunnel = {
        leads: {
          count: totalLeadsCount,
          percentage: 100,
        },
        qualified: {
          count: qualifiedLeadsCount,
          percentage:
            totalLeadsCount > 0
              ? parseFloat(
                  ((qualifiedLeadsCount / totalLeadsCount) * 100).toFixed(1)
                )
              : 0,
        },
        meetings: {
          count: meetingsCount,
          percentage:
            totalLeadsCount > 0
              ? parseFloat(((meetingsCount / totalLeadsCount) * 100).toFixed(1))
              : 0,
        },
        proposals: {
          count: proposalsCount,
          percentage:
            totalLeadsCount > 0
              ? parseFloat(
                  ((proposalsCount / totalLeadsCount) * 100).toFixed(1)
                )
              : 0,
        },
        closed: {
          count: closedCount,
          percentage:
            totalLeadsCount > 0
              ? parseFloat(((closedCount / totalLeadsCount) * 100).toFixed(1))
              : 0,
        },
      };

      console.log(`📊 [ANALYTICS] Conversion Funnel:`, conversionFunnel);

      console.log(`✅ [ANALYTICS] Data prepared successfully`);

      res.json({
        timeRange: days,
        summary: {
          totalLeads: filteredLeads.length,
          totalConversations: filteredConversations.length,
          totalBookings: confirmedMeetingsCount,
          conversionRate:
            filteredLeads.length > 0
              ? ((confirmedMeetingsCount / filteredLeads.length) * 100).toFixed(
                  1
                )
              : "0",
          avgTimeToBook: avgTimeToBook.toFixed(1),
        },
        leadTrend,
        responseTimeByHour: responseTimeByHour,
        temperatureData,
        statusData,
        aiPerformance,
        bookingTimeline: bookingTimeline.slice(0, 10),
        conversionFunnel,
      });
    } catch (error: any) {
      console.error("❌ [ANALYTICS] Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ✅ NEW: Per-day analytics endpoint
  app.get("/api/analytics/per-day/:clientId", async (req, res) => {
    try {
      const { clientId } = req.params;
      const timezone = (req.query.timezone as string) || "America/Vancouver";

      console.log(
        `📊 [API] Fetching per-day analytics for client: ${clientId}, timezone: ${timezone}`
      );

      // Verify client exists and user has access
      const client = await storage.getClient(clientId);
      if (!client) {
        return res.status(404).send("Client not found");
      }

      // For non-super-admin users, verify they own this client
      if (req.user?.role !== "super_admin" && client.userId !== req.user?.id) {
        return res.status(403).send("Access denied");
      }

      const perDayData = await storage.getPerDayResponseTimes(
        clientId,
        timezone
      );

      res.json({
        success: true,
        data: perDayData,
        timezone,
      });
    } catch (error: any) {
      console.error("❌ [API] Error fetching per-day analytics:", error);
      res.status(500).json({
        error: "Failed to fetch per-day analytics",
        message: error.message,
      });
    }
  });

  // =========================== CONVERSATION ROUTES  =====================================

  // Conversations
  app.get("/api/conversations/:clientId", requireAuth, async (req, res) => {
    try {
      const { clientId } = req.params;
      const requestUser = req.user!;

      // Verify ownership
      if (requestUser.role !== "super_admin") {
        const client = await storage.getClient(clientId);
        if (!client || client.userId !== requestUser.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const conversations = await storage.getActiveConversations(clientId);
      res.json(conversations);
    } catch (error) {
      console.error("Error fetching conversations:", error);
      res.status(500).json({ message: "Failed to fetch conversations" });
    }
  });
  // Get messages in a conversation
  app.get("/api/conversations/:conversationId/messages", async (req, res) => {
    try {
      const { conversationId } = req.params;
      const messages = await storage.getMessages(conversationId);
      res.json(messages);
    } catch (error) {
      console.error("Error fetching messages:", error);
      res.status(500).json({ message: "Failed to fetch messages" });
    }
  });

  // Mark conversation as read
  app.post("/api/conversations/:id/read", async (req, res) => {
    try {
      const { id } = req.params;
      await storage.markConversationAsRead(id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Mark messages as read
  app.post(
    "/api/conversations/:conversationId/messages/read",
    async (req, res) => {
      try {
        const { conversationId } = req.params;
        const { messageIds } = req.body;

        if (!messageIds || !Array.isArray(messageIds)) {
          return res.status(400).json({ error: "messageIds array required" });
        }

        console.log(
          `📖 Marking ${messageIds.length} messages as read in conversation ${conversationId}`
        );

        // ✅ NEW: For each message, if it's from a lead and has WhatsApp ID, mark it as read in WhatsApp
        for (const messageId of messageIds) {
          const message = await storage.getMessage(messageId);

          if (message && message.sender === "lead") {
            const metadata = message.metadata as {
              whatsappMessageId?: string;
            } | null;

            if (metadata?.whatsappMessageId) {
              console.log(
                `📬 Marking WhatsApp message as read: ${metadata.whatsappMessageId}`
              );

              // Call WhatsApp API to mark as read
              await whatsappService.markMessageAsRead(
                metadata.whatsappMessageId
              );
            }
          }
        }

        // Mark messages as read in database
        await storage.markMessagesAsRead(messageIds);

        // Also mark conversation as read
        await storage.markConversationAsRead(conversationId);

        res.json({ success: true });
      } catch (error: any) {
        console.error("Error marking messages as read:", error);
        res.status(500).json({ error: error.message });
      }
    }
  );

  // Take over conversation
  app.post("/api/conversations/:conversationId/takeover", async (req, res) => {
    try {
      const { conversationId } = req.params;

      const conversation = await storage.updateConversation(conversationId, {
        isAiHandled: false,
        humanTakeoverAt: new Date(),
      });

      // Get lead details for broadcast
      const lead = await storage.getLead(conversation.leadId);

      // Broadcast update
      broadcastUpdate({
        type: "conversation_updated",
        conversation: {
          ...conversation,
          lead,
        },
      });

      res.json(conversation);
    } catch (error) {
      console.error("Error taking over conversation:", error);
      res.status(500).json({ message: "Failed to take over conversation" });
    }
  });

  // Send message in conversation
  app.post("/api/conversations/:conversationId/messages", async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { content, channel } = req.body;

      const conversation = await storage.getConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      const lead = await storage.getLead(conversation.leadId);
      if (!lead) {
        return res.status(404).json({ message: "Lead not found" });
      }

      // ✅ NEW: Track response time if this is first human response
      const messages = await storage.getMessages(conversationId);
      const firstResponse = messages.filter(
        (m) => m.sender === "ai" || m.sender === "human"
      )[0];

      if (!firstResponse) {
        // This is the first response - track it
        const firstLeadMessage = messages
          .filter((m) => m.sender === "lead" && m.sentAt !== null) // ✅ Filter out null sentAt
          .sort((a, b) => {
            const timeA = new Date(a.sentAt!).getTime();
            const timeB = new Date(b.sentAt!).getTime();
            return timeA - timeB;
          })[0];

        if (firstLeadMessage && firstLeadMessage.sentAt) {
          const leadMessageTime = new Date(firstLeadMessage.sentAt);
          const responseTime = new Date();
          const responseTimeSeconds = Math.round(
            (responseTime.getTime() - leadMessageTime.getTime()) / 1000
          );

          console.log(`⏱️ HUMAN Response time: ${responseTimeSeconds}s`);

          await storage.updateLead(lead.id, {
            responseTimeSeconds,
          });
        }
      }

      let whatsappMessageId = null;

      // Send message via appropriate channel
      if (channel === "whatsapp" && lead.phone) {
        console.log("📤 Sending WhatsApp message...");

        // ✅ Get the response to capture message ID
        const waResponse = await fetch(
          `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${
                process.env.WHATSAPP_ACCESS_TOKEN ||
                process.env.META_ACCESS_TOKEN
              }`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: lead.phone.replace(/\D/g, ""),
              type: "text",
              text: {
                body: content,
              },
            }),
          }
        );

        const waData = await waResponse.json();

        if (waResponse.ok && waData.messages?.[0]?.id) {
          whatsappMessageId = waData.messages[0].id;
          console.log("✅ WhatsApp message sent, ID:", whatsappMessageId);
        } else {
          console.error("❌ WhatsApp send failed:", waData);
        }
      }

      // Record message
      const message = await storage.createMessage({
        conversationId,
        content,
        sender: "human",
        channel,
        sentAt: new Date(),
        deliveredAt: new Date(),
        metadata: whatsappMessageId ? { whatsappMessageId } : undefined,
      });

      console.log("✅ Message saved with metadata:", message.metadata);

      // Update conversation last message time
      await storage.updateConversation(conversationId, {
        lastMessageAt: new Date(),
      });

      // Broadcast new message
      broadcastUpdate({
        type: "new_message",
        conversationId,
        message,
      });

      res.json(message);
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({ message: "Failed to send message" });
    }
  });

  // ✅ Rate limiting cache
  const markAsReadCache = new Map<string, number>(); // conversationId -> lastMarkedTimestamp

  // Cleanup old cache entries every 5 minutes
  setInterval(() => {
    const now = Date.now();
    markAsReadCache.forEach((timestamp, key) => {
      if (now - timestamp > 300000) {
        markAsReadCache.delete(key);
      }
    });
  }, 300000);

  // Mark messages as read
  app.post(
    "/api/conversations/:conversationId/messages/read",
    async (req, res) => {
      try {
        const { conversationId } = req.params;
        const { messageIds } = req.body;
        const now = Date.now();

        // ✅ Rate limit: Don't allow marking same conversation within 2 seconds
        const lastMarked = markAsReadCache.get(conversationId);
        if (lastMarked && now - lastMarked < 2000) {
          console.log(
            `⏭️ [RATE LIMIT] Skipping mark-as-read for ${conversationId} (last marked ${
              now - lastMarked
            }ms ago)`
          );
          return res.json({
            success: true,
            message: "Already marked recently",
            skipped: true,
          });
        }

        if (!messageIds || !Array.isArray(messageIds)) {
          return res.status(400).json({ error: "messageIds array required" });
        }

        console.log(
          `📖 Marking ${messageIds.length} messages as read in conversation ${conversationId}`
        );

        // Update cache BEFORE processing (prevent race conditions)
        markAsReadCache.set(conversationId, now);

        // Mark messages as read in database
        await storage.markMessagesAsRead(messageIds);

        // ✅ Mark on WhatsApp (with deduplication)
        const markedWhatsAppIds = new Set<string>();

        for (const messageId of messageIds) {
          const message = await storage.getMessage(messageId);

          if (message && message.sender === "lead") {
            const metadata = message.metadata as {
              whatsappMessageId?: string;
            } | null;

            if (metadata?.whatsappMessageId) {
              // ✅ Deduplicate: Don't mark same WhatsApp ID multiple times
              if (markedWhatsAppIds.has(metadata.whatsappMessageId)) {
                console.log(
                  `⏭️ WhatsApp message already marked: ${metadata.whatsappMessageId}`
                );
                continue;
              }

              console.log(
                `📬 Marking WhatsApp message as read: ${metadata.whatsappMessageId}`
              );

              try {
                await whatsappService.markMessageAsRead(
                  metadata.whatsappMessageId
                );
                markedWhatsAppIds.add(metadata.whatsappMessageId);
              } catch (whatsappError) {
                console.error(
                  `❌ Failed to mark WhatsApp message as read:`,
                  whatsappError
                );
                // Don't fail the whole request if WhatsApp marking fails
              }
            }
          }
        }

        // Mark conversation as read
        await storage.markConversationAsRead(conversationId);

        console.log(
          `✅ Marked ${messageIds.length} messages as read (${markedWhatsAppIds.size} WhatsApp)`
        );

        res.json({
          success: true,
          markedCount: messageIds.length,
          whatsappMarkedCount: markedWhatsAppIds.size,
        });
      } catch (error: any) {
        console.error("❌ Error marking messages as read:", error);
        res.status(500).json({ error: error.message });
      }
    }
  );

  // Typing indicator endpoint - Internal only (WebSocket broadcast)
  app.post("/api/conversations/:conversationId/typing", async (req, res) => {
    try {
      const { conversationId } = req.params;
      const { isTyping } = req.body;

      const conversation = await storage.getConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ message: "Conversation not found" });
      }

      // ✅ Only broadcast to other agents via WebSocket
      // Note: WhatsApp Business API doesn't support sending typing indicators to users
      broadcastUpdate({
        type: "typing_indicator",
        conversationId,
        isTyping,
        sender: "human",
        userId: req.user?.id, // Track which agent is typing
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error broadcasting typing indicator:", error);
      res.status(500).json({ message: "Failed to broadcast typing indicator" });
    }
  });

  // ==================== MESSAGE REACTION ROUTES ====================

  // Add reaction to message
  app.post("/api/messages/:messageId/react", async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const { messageId } = req.params;
      const { emoji } = req.body;

      if (!emoji) {
        return res.status(400).json({ error: "Emoji is required" });
      }

      console.log(`😊 User reacting to message ${messageId} with ${emoji}`);

      // Get message to find conversation
      const message = await storage.getMessage(messageId);
      if (!message) {
        return res.status(404).json({ error: "Message not found" });
      }

      // ✅ ADD: Debug the message
      console.log(`📋 Message details:`, {
        id: message.id,
        sender: message.sender,
        content: message.content.substring(0, 50) + "...",
        metadata: message.metadata,
      });

      // Get conversation and lead details
      const conversation = await storage.getConversation(
        message.conversationId
      );
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const lead = await storage.getLead(conversation.leadId);
      if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
      }

      console.log(`👤 Lead details:`, {
        id: lead.id,
        name: `${lead.firstName} ${lead.lastName}`,
        phone: lead.phone,
      });

      // Add reaction to database
      await storage.addReaction(messageId, {
        emoji,
        userId: req.user.id,
        userName: `${req.user.firstName} ${req.user.lastName}`,
      });

      console.log(`✅ Reaction saved to database`);

      // ✅ Type assert metadata
      const metadata = message.metadata as {
        whatsappMessageId?: string;
      } | null;

      // ✅ ADD: Debug condition checks
      console.log(`🔍 Checking WhatsApp send conditions:`);
      console.log(
        `  - message.sender === "lead": ${message.sender === "lead"}`
      );
      console.log(`  - metadata exists: ${!!metadata}`);
      console.log(
        `  - metadata.whatsappMessageId: ${metadata?.whatsappMessageId}`
      );
      console.log(`  - lead.phone exists: ${!!lead.phone}`);

      // ✅ Send reaction to WhatsApp if message was from lead
      if (
        message.sender === "lead" &&
        metadata?.whatsappMessageId &&
        lead.phone
      ) {
        console.log(`📤 Sending reaction to WhatsApp...`);
        console.log(`  - WhatsApp Message ID: ${metadata.whatsappMessageId}`);
        console.log(`  - Lead Phone: ${lead.phone}`);
        console.log(`  - Emoji: ${emoji}`);

        const sent = await whatsappService.sendReaction(
          lead.phone,
          metadata.whatsappMessageId,
          emoji
        );

        if (sent) {
          console.log(`✅ Reaction sent to WhatsApp successfully`);
        } else {
          console.log(`⚠️ Failed to send reaction to WhatsApp`);
        }
      } else {
        console.log(`⚠️ NOT sending reaction to WhatsApp because:`);
        if (message.sender !== "lead") {
          console.log(
            `   ❌ Message is not from lead (sender: ${message.sender})`
          );
        }
        if (!metadata?.whatsappMessageId) {
          console.log(`   ❌ No WhatsApp message ID in metadata`);
        }
        if (!lead.phone) {
          console.log(`   ❌ Lead has no phone number`);
        }
      }

      // Get updated message with reactions
      const updatedMessage = await storage.getMessage(messageId);

      // Broadcast to WebSocket
      broadcastUpdate({
        type: "message_reacted",
        messageId,
        reactions: updatedMessage?.reactions,
        conversationId: message.conversationId,
      });

      res.json({ success: true, reactions: updatedMessage?.reactions });
    } catch (error) {
      console.error("Error adding reaction:", error);
      res.status(500).json({ error: "Failed to add reaction" });
    }
  });

  // Remove reaction from message
  app.delete("/api/messages/:messageId/react", async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    try {
      const { messageId } = req.params;
      const { emoji } = req.body;

      if (!emoji) {
        return res.status(400).json({ error: "Emoji is required" });
      }

      // Get message to find conversation
      const message = await storage.getMessage(messageId);
      if (!message) {
        return res.status(404).json({ error: "Message not found" });
      }

      // Get conversation and lead details
      const conversation = await storage.getConversation(
        message.conversationId
      );
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const lead = await storage.getLead(conversation.leadId);
      if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
      }

      // Remove reaction from database
      await storage.removeReaction(messageId, req.user.id, emoji);

      console.log(`✅ Removed reaction from database`);

      // ✅ FIX: Send removal to WhatsApp
      const metadata = message.metadata as {
        whatsappMessageId?: string;
      } | null;

      if (
        message.sender === "lead" &&
        metadata?.whatsappMessageId &&
        lead.phone
      ) {
        console.log(`📤 Removing reaction from WhatsApp...`);

        // ✅ Send empty emoji to remove reaction
        const removed = await whatsappService.sendReaction(
          lead.phone,
          metadata.whatsappMessageId,
          "" // Empty string removes the reaction
        );

        if (removed) {
          console.log(`✅ Reaction removed from WhatsApp successfully`);
        } else {
          console.log(`⚠️ Failed to remove reaction from WhatsApp`);
        }
      }

      // Get updated message with reactions
      const updatedMessage = await storage.getMessage(messageId);

      // Broadcast to WebSocket
      broadcastUpdate({
        type: "message_reacted",
        messageId,
        reactions: updatedMessage?.reactions,
        conversationId: message.conversationId,
      });

      res.json({ success: true, reactions: updatedMessage?.reactions });
    } catch (error) {
      console.error("Error removing reaction:", error);
      res.status(500).json({ error: "Failed to remove reaction" });
    }
  });

  // ==================== QUICKREPLIES/TEMPLATES ROUTES  ==========================

  // Quick Reply Templates Routes
  app.get("/api/quick-replies/:clientId", async (req, res) => {
    try {
      const { clientId } = req.params;
      const templates = await storage.getQuickReplyTemplates(clientId);
      res.json(templates);
    } catch (error) {
      console.error("Error fetching templates:", error);
      res.status(500).json({ message: "Failed to fetch templates" });
    }
  });

  app.post("/api/quick-replies", async (req, res) => {
    try {
      const template = await storage.createQuickReplyTemplate(req.body);
      res.json(template);
    } catch (error) {
      console.error("Error creating template:", error);
      res.status(500).json({ message: "Failed to create template" });
    }
  });

  app.patch("/api/quick-replies/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const template = await storage.updateQuickReplyTemplate(id, req.body);
      res.json(template);
    } catch (error) {
      console.error("Error updating template:", error);
      res.status(500).json({ message: "Failed to update template" });
    }
  });

  app.delete("/api/quick-replies/:id", async (req, res) => {
    try {
      const { id } = req.params;
      await storage.deleteQuickReplyTemplate(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting template:", error);
      res.status(500).json({ message: "Failed to delete template" });
    }
  });

  app.post("/api/quick-replies/:id/use", async (req, res) => {
    try {
      const { id } = req.params;
      await storage.incrementTemplateUsage(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error incrementing usage:", error);
      res.status(500).json({ message: "Failed to track usage" });
    }
  });

   // ======================== VSL HELPER FUNCTION =====================================
  
  async function generateVideoInBackground(
    vslId: string,
    script: string,
    title: string,
    clientId: string,
    niche: string,
    targetDuration: string,
    subtitleType: string
  ) {
    try {
      console.log(
        `🎥 Starting background video generation for VSL: ${vslId} (${targetDuration})`
      );

      const result = await vslGenerator.generateVSL({
        vslId,
        script,
        title,
        clientId,
        niche,
        targetDuration,
        subtitles: subtitleType as "none" | "traditional" | "karaoke",
      });

      await storage.updateVSL(vslId, {
        videoUrl: result.videoUrl,
        thumbnailUrl: result.thumbnailUrl,
        duration: result.duration,
        cloudinaryVideoId: result.cloudinaryPublicIds?.video,
        cloudinaryThumbnailId: result.cloudinaryPublicIds?.thumbnail,
      });

      console.log(
        `✅ Video generation complete for VSL: ${vslId} (actual duration: ${result.duration}s)`
      );
    } catch (error) {
      console.error(`❌ Video generation failed for VSL: ${vslId}`, error);
      await storage.updateVSL(vslId, { isActive: false });
    }
  }

 
    // ======================== VIDEO SALES LETTER ROUTES =====================================

  // ✅ ANALYTICS ROUTES FIRST (most specific paths)
  
  app.post("/api/vsls/:vslId/track-play", async (req, res) => {
    try {
      const { vslId } = req.params;
      const { sessionId } = req.body;

      if (!sessionId) {
        return res.status(400).json({ message: "Session ID required" });
      }

      console.log(`📊 [VSL] Tracking play for VSL: ${vslId}, Session: ${sessionId}`);

      const ipAddress = req.ip || (req.headers["x-forwarded-for"] as string);
      const userAgent = req.headers["user-agent"];

      await storage.trackVSLPlay({
        vslId,
        sessionId,
        ipAddress,
        userAgent,
      });

      console.log(`✅ [VSL] Play tracked successfully`);
      res.json({ success: true });
    } catch (error: any) {
      console.error("❌ [VSL] Error tracking play:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/vsls/:vslId/track-progress", async (req, res) => {
    try {
      const { sessionId, watchTime, completionPercentage, completed } = req.body;

      if (!sessionId) {
        return res.status(400).json({ message: "Session ID required" });
      }

      console.log(`📊 [VSL] Tracking progress: ${completionPercentage}% completed`);

      await storage.trackVSLProgress(
        sessionId,
        watchTime,
        completionPercentage,
        completed
      );

      console.log(`✅ [VSL] Progress tracked successfully`);
      res.json({ success: true });
    } catch (error: any) {
      console.error("❌ [VSL] Error tracking progress:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/vsls/:vslId/analytics", async (req, res) => {
    try {
      const { vslId } = req.params;

      console.log(`📊 [VSL] Fetching analytics for: ${vslId}`);

      const analytics = await storage.getVSLAnalytics(vslId);

      console.log(`✅ [VSL] Analytics fetched:`, analytics);
      res.json(analytics);
    } catch (error: any) {
      console.error("❌ [VSL] Error fetching analytics:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/vsls/:vslId/view", async (req, res) => {
    try {
      const { vslId } = req.params;
      await storage.incrementVSLViews(vslId);
      res.json({ success: true });
    } catch (error: any) {
      console.error("❌ [VSL] Error tracking view:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ✅ CRUD ROUTES (less specific)

  app.post("/api/vsls", requireAuth, async (req, res) => {
    try {
      const {
        title,
        niche,
        clientId,
        targetDuration,
        subtitleType,
        targetAudience,
        painPoints,
        solution,
        proofElements,
      } = req.body;

      const requestUser = req.user!;

      // Verify ownership
      if (requestUser.role !== "super_admin") {
        const client = await storage.getClient(clientId);
        if (!client || client.userId !== requestUser.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      // Validate and normalize
      const validDurations = ["30s", "1min", "2min", "3min", "5min"] as const;
      const normalizedDuration = validDurations.includes(targetDuration)
        ? targetDuration
        : "2min";

      const validSubtitleTypes = ["none", "traditional", "karaoke"] as const;
      const normalizedSubtitleType = validSubtitleTypes.includes(subtitleType)
        ? subtitleType
        : "none";

      console.log("🎬 Creating new VSL:", {
        title,
        niche,
        clientId,
        targetDuration: normalizedDuration,
      });

      if (!title || !niche || !clientId) {
        return res.status(400).json({
          message: "Missing required fields: title, niche, clientId",
        });
      }

      // Generate script
      console.log(`📝 Generating ${normalizedDuration} VSL script...`);

      const script = await generateVSLScript(niche, {
        targetAudience: targetAudience || `${niche} business owners`,
        painPoints: painPoints || `Common challenges in ${niche}`,
        solution: solution || "AI-powered lead generation system",
        proofElements: proofElements || "Proven results and case studies",
        duration: normalizedDuration,
      });

      const wordCount = script.split(/\s+/).filter((w) => w.length > 0).length;
      console.log("✅ Script generated:", script.substring(0, 100) + "...");
      console.log(
        `📊 Script length: ${wordCount} words for ${normalizedDuration}`
      );

      // Create VSL record
      const vsl = await storage.createVSL({
        clientId,
        title,
        script,
        targetDuration: normalizedDuration,
        subtitleType: normalizedSubtitleType,
        isActive: true,
      });

      console.log("✅ VSL record created:", vsl.id);

      // Start video generation in background
      generateVideoInBackground(
        vsl.id,
        script,
        title,
        clientId,
        niche,
        normalizedDuration,
        normalizedSubtitleType
      );

      res.json({
        success: true,
        vsl,
        message: `VSL creation started. ${normalizedDuration} video will be ready in 5-10 minutes.`,
      });
    } catch (error: any) {
      console.error("❌ Error creating VSL:", error);
      res.status(500).json({
        message: "Failed to create VSL",
        error: error.message,
      });
    }
  });

  app.patch("/api/vsls/:vslId", requireAuth, async (req, res) => {
    try {
      const { vslId } = req.params;
      const updateData = req.body;

      console.log(`📝 Updating VSL: ${vslId}`);

      const updatedVSL = await storage.updateVSL(vslId, updateData);
      res.json(updatedVSL);
    } catch (error: any) {
      console.error("❌ Error updating VSL:", error);
      res.status(500).json({
        message: "Failed to update VSL",
        error: error.message,
      });
    }
  });

  app.delete("/api/vsls/:vslId", requireAuth, async (req, res) => {
    try {
      const { vslId } = req.params;

      console.log(`🗑️ Deleting VSL: ${vslId}`);

      const vsl = await storage.getVSL(vslId);
      if (!vsl) {
        return res.status(404).json({ message: "VSL not found" });
      }

      // Delete from Cloudinary
      if (vsl.cloudinaryVideoId) {
        try {
          await cloudinaryService.deleteResource(vsl.cloudinaryVideoId, "video");
          console.log("✅ Video deleted from Cloudinary");
        } catch (error) {
          console.error("⚠️ Failed to delete video:", error);
        }
      }

      if (vsl.cloudinaryThumbnailId) {
        try {
          await cloudinaryService.deleteResource(
            vsl.cloudinaryThumbnailId,
            "image"
          );
          console.log("✅ Thumbnail deleted from Cloudinary");
        } catch (error) {
          console.error("⚠️ Failed to delete thumbnail:", error);
        }
      }

      await storage.deleteVSL(vslId);
      res.json({ success: true, message: "VSL deleted successfully" });
    } catch (error: any) {
      console.error("❌ Error deleting VSL:", error);
      res.status(500).json({
        message: "Failed to delete VSL",
        error: error.message,
      });
    }
  });

  // ✅ GET ROUTE LAST (most general pattern)
  
  app.get("/api/vsls/:clientId", requireAuth, async (req, res) => {
    try {
      const { clientId } = req.params;
      const requestUser = req.user!;

      console.log("📋 Fetching VSLs for client:", clientId);

      // Verify ownership
      if (requestUser.role !== "super_admin") {
        const client = await storage.getClient(clientId);
        if (!client || client.userId !== requestUser.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const vsls = await storage.getVSLsByClient(clientId);
      res.json(vsls);
    } catch (error: any) {
      console.error("❌ Error fetching VSLs:", error);
      res.status(500).json({
        message: "Failed to fetch VSLs",
        error: error.message,
      });
    }
  });


  // ======================= FOLLOW-UPS ROUTES ==============================================

  // Get all sequences for a client
  app.get(
    "/api/follow-ups/sequences/:clientId",
    requireAuth,
    async (req, res) => {
      try {
        const { clientId } = req.params;
        const requestUser = req.user!;

        // Verify ownership
        if (requestUser.role !== "super_admin") {
          const client = await storage.getClient(clientId);
          if (!client || client.userId !== requestUser.id) {
            return res.status(403).json({ message: "Access denied" });
          }
        }

        const sequences = await storage.getFollowUpSequences(clientId);

        // Get steps for each sequence
        const sequencesWithSteps = await Promise.all(
          sequences.map(async (seq) => ({
            ...seq,
            steps: await storage.getFollowUpSteps(seq.id),
          }))
        );

        res.json(sequencesWithSteps);
      } catch (error) {
        console.error("Error fetching sequences:", error);
        res.status(500).json({ message: "Failed to fetch sequences" });
      }
    }
  );

  // Create a new sequence
  app.post("/api/follow-ups/sequences", requireAuth, async (req, res) => {
    try {
      const requestUser = req.user!;
      const { clientId, name, description, triggerType, channel, steps } =
        req.body;

      // Verify ownership
      if (requestUser.role !== "super_admin") {
        const client = await storage.getClient(clientId);
        if (!client || client.userId !== requestUser.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      console.log("📋 Creating follow-up sequence:", name);

      // Create sequence
      const sequence = await storage.createFollowUpSequence({
        clientId,
        name,
        description,
        triggerType,
        channel: channel || "whatsapp",
        steps: steps?.length || 0,
        status: "active",
      });

      // Create steps
      if (steps && steps.length > 0) {
        for (const step of steps) {
          await storage.createFollowUpStep({
            sequenceId: sequence.id,
            stepNumber: step.stepNumber,
            delayMinutes: step.delayMinutes,
            content: step.content,
            channel: step.channel || channel || "whatsapp",
          });
        }
      }

      console.log("✅ Sequence created:", sequence.id);

      // Return with steps
      const sequenceWithSteps = {
        ...sequence,
        steps: await storage.getFollowUpSteps(sequence.id),
      };

      res.json(sequenceWithSteps);
    } catch (error) {
      console.error("Error creating sequence:", error);
      res.status(500).json({ message: "Failed to create sequence" });
    }
  });

  // Update sequence status (activate/pause)
  app.patch(
    "/api/follow-ups/sequences/:sequenceId",
    requireAuth,
    async (req, res) => {
      try {
        const { sequenceId } = req.params;
        const { status } = req.body;

        console.log(`📝 Updating sequence ${sequenceId} status to ${status}`);

        const updated = await storage.updateFollowUpSequence(sequenceId, {
          status,
        });

        res.json(updated);
      } catch (error) {
        console.error("Error updating sequence:", error);
        res.status(500).json({ message: "Failed to update sequence" });
      }
    }
  );

  // Delete sequence
  app.delete(
    "/api/follow-ups/sequences/:sequenceId",
    requireAuth,
    async (req, res) => {
      try {
        const { sequenceId } = req.params;

        console.log(`🗑️ Deleting sequence: ${sequenceId}`);

        await storage.deleteFollowUpSequence(sequenceId);

        res.json({ success: true });
      } catch (error) {
        console.error("Error deleting sequence:", error);
        res.status(500).json({ message: "Failed to delete sequence" });
      }
    }
  );

  // Get all follow-ups for a client (with lead info)
  app.get("/api/follow-ups/:clientId", requireAuth, async (req, res) => {
    try {
      const { clientId } = req.params;
      const { status } = req.query;
      const requestUser = req.user!;

      // Verify ownership
      if (requestUser.role !== "super_admin") {
        const client = await storage.getClient(clientId);
        if (!client || client.userId !== requestUser.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const followUps = await storage.getFollowUpsByClient(
        clientId,
        status as string | undefined
      );

      // Enrich with lead data
      const enrichedFollowUps = await Promise.all(
        followUps.map(async (fu) => {
          const lead = await storage.getLead(fu.leadId);
          const sequence = fu.sequenceId
            ? await storage.getFollowUpSequence(fu.sequenceId)
            : null;

          return {
            ...fu,
            leadName: lead ? `${lead.firstName} ${lead.lastName}` : "Unknown",
            leadCompany: lead?.company,
            sequenceName: sequence?.name,
          };
        })
      );

      res.json(enrichedFollowUps);
    } catch (error) {
      console.error("Error fetching follow-ups:", error);
      res.status(500).json({ message: "Failed to fetch follow-ups" });
    }
  });

  // Get pending follow-ups for a client
  app.get(
    "/api/follow-ups/:clientId/pending",
    requireAuth,
    async (req, res) => {
      try {
        const { clientId } = req.params;
        const requestUser = req.user!;

        // Verify ownership
        if (requestUser.role !== "super_admin") {
          const client = await storage.getClient(clientId);
          if (!client || client.userId !== requestUser.id) {
            return res.status(403).json({ message: "Access denied" });
          }
        }

        const pendingFollowUps = await storage.getPendingFollowUpsByClient(
          clientId
        );

        // Enrich with lead data
        const enriched = await Promise.all(
          pendingFollowUps.map(async (fu) => {
            const lead = await storage.getLead(fu.leadId);
            return {
              ...fu,
              leadName: lead ? `${lead.firstName} ${lead.lastName}` : "Unknown",
              leadCompany: lead?.company,
            };
          })
        );

        res.json(enriched);
      } catch (error) {
        console.error("Error fetching pending follow-ups:", error);
        res.status(500).json({ message: "Failed to fetch pending follow-ups" });
      }
    }
  );

  // Schedule a follow-up sequence for a lead
  app.post("/api/follow-ups/schedule", requireAuth, async (req, res) => {
    try {
      const { leadId, sequenceId, conversationId } = req.body;

      console.log(`📅 Scheduling follow-up sequence for lead: ${leadId}`);

      const scheduledFollowUps = await storage.scheduleFollowUpSequence(
        leadId,
        sequenceId,
        conversationId
      );

      console.log(`✅ Scheduled ${scheduledFollowUps.length} follow-ups`);

      res.json({
        success: true,
        count: scheduledFollowUps.length,
        followUps: scheduledFollowUps,
      });
    } catch (error: any) {
      console.error("Error scheduling follow-ups:", error);
      res.status(500).json({
        message: "Failed to schedule follow-ups",
        error: error.message,
      });
    }
  });

  // Cancel a specific follow-up
  app.delete("/api/follow-ups/:followUpId", requireAuth, async (req, res) => {
    try {
      const { followUpId } = req.params;

      console.log(`🚫 Cancelling follow-up: ${followUpId}`);

      await storage.cancelFollowUp(followUpId);

      res.json({ success: true });
    } catch (error) {
      console.error("Error cancelling follow-up:", error);
      res.status(500).json({ message: "Failed to cancel follow-up" });
    }
  });

  // Cancel all pending follow-ups for a lead
  app.post(
    "/api/follow-ups/cancel-lead/:leadId",
    requireAuth,
    async (req, res) => {
      try {
        const { leadId } = req.params;

        console.log(`🚫 Cancelling all follow-ups for lead: ${leadId}`);

        // Import the worker function
        const { cancelPendingFollowUps } = await import(
          "./services/follow-up-worker"
        );
        await cancelPendingFollowUps(leadId);

        res.json({ success: true });
      } catch (error) {
        console.error("Error cancelling follow-ups:", error);
        res.status(500).json({ message: "Failed to cancel follow-ups" });
      }
    }
  );

  // Get follow-up analytics/stats
  app.get("/api/follow-ups/:clientId/stats", requireAuth, async (req, res) => {
    try {
      const { clientId } = req.params;
      const requestUser = req.user!;

      // Verify ownership
      if (requestUser.role !== "super_admin") {
        const client = await storage.getClient(clientId);
        if (!client || client.userId !== requestUser.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const allFollowUps = await storage.getFollowUpsByClient(clientId);

      const stats = {
        total: allFollowUps.length,
        pending: allFollowUps.filter((f) => f.status === "pending").length,
        sent: allFollowUps.filter((f) => f.status === "sent").length,
        failed: allFollowUps.filter((f) => f.status === "failed").length,
        cancelled: allFollowUps.filter((f) => f.status === "cancelled").length,
      };

      res.json(stats);
    } catch (error) {
      console.error("Error fetching follow-up stats:", error);
      res.status(500).json({ message: "Failed to fetch stats" });
    }
  });

  // Send follow-up immediately
  app.post("/api/follow-ups/:id/send-now", async (req, res) => {
    try {
      const { id } = req.params;

      // Get the follow-up
      const followUp = await storage.getFollowUpById(id);

      if (!followUp) {
        return res.status(404).json({ message: "Follow-up not found" });
      }

      // Get the lead
      const lead = await storage.getLead(followUp.leadId);

      if (!lead || !lead.phone) {
        return res
          .status(400)
          .json({ message: "Lead not found or has no phone" });
      }

      // Send the message via WhatsApp
      await whatsappService.sendTextMessage(lead.phone, followUp.content);

      // Update follow-up status to sent
      await storage.updateFollowUp(id, {
        status: "sent",
        sentAt: new Date(),
      });

      res.json({ success: true, message: "Follow-up sent successfully" });
    } catch (error) {
      console.error("Error sending follow-up now:", error);
      res.status(500).json({ message: "Failed to send follow-up" });
    }
  });

  // Cancel/skip follow-up
  app.post("/api/follow-ups/:id/cancel", async (req, res) => {
    try {
      const { id } = req.params;

      // Update follow-up status to cancelled
      await storage.updateFollowUp(id, {
        status: "cancelled",
        errorMessage: "Manually skipped by user",
      });

      res.json({ success: true, message: "Follow-up cancelled successfully" });
    } catch (error) {
      console.error("Error cancelling follow-up:", error);
      res.status(500).json({ message: "Failed to cancel follow-up" });
    }
  });

  // ======================= BOOKINGS ROUTES  ==============================================

  // Bookings
  app.post("/api/bookings", async (req, res) => {
    try {
      const bookingData = insertBookingSchema.parse(req.body);
      const booking = await storage.createBooking(bookingData);

      // Update lead status to converted
      await storage.updateLead(booking.leadId, {
        status: "converted",
      });

      res.json(booking);
    } catch (error) {
      console.error("Error creating booking:", error);
      res.status(400).json({
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Update booking status
  app.patch("/api/bookings/:bookingId", async (req, res) => {
    try {
      const { bookingId } = req.params;
      const { status, notes } = req.body;

      const booking = await storage.updateBooking(bookingId, {
        status,
        notes,
      });

      res.json(booking);
    } catch (error) {
      console.error("Error updating booking:", error);
      res.status(500).json({ message: "Failed to update booking" });
    }
  });

  // Create booking with calendar invite
  app.post("/api/bookings/schedule", async (req, res) => {
    try {
      const {
        leadId,
        clientId,
        scheduledFor, // From frontend
        duration = 60,
        meetingType = "consultation",
        location = "Office",
        notes,
      } = req.body;

      console.log("📅 Creating booking:", {
        leadId,
        scheduledFor,
        meetingType,
      });

      // Get lead
      const lead = await storage.getLead(leadId);
      if (!lead) {
        return res.status(404).json({ message: "Lead not found" });
      }

      // Get client
      const client = await storage.getClient(clientId);
      if (!client) {
        return res.status(404).json({ message: "Client not found" });
      }

      const scheduledDate = new Date(scheduledFor);

      // Check for conflicts with existing bookings
      const existingBookings = await storage.getBookings(clientId);
      const scheduledEnd = new Date(scheduledDate.getTime() + duration * 60000);

      const conflict = hasBookingConflict(
        scheduledDate,
        scheduledEnd,
        existingBookings
      );

      if (conflict.hasConflict && conflict.conflictingBooking) {
        const conflictStart = new Date(
          conflict.conflictingBooking.scheduledFor
        );
        const conflictEnd = new Date(
          conflictStart.getTime() + conflict.conflictingBooking.duration * 60000
        );

        return res.status(409).json({
          error: "Booking conflict detected",
          message: `There is already a meeting scheduled from ${conflictStart.toLocaleTimeString(
            "en-US",
            { hour: "2-digit", minute: "2-digit" }
          )} to ${conflictEnd.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
          })}`,
          conflictingBooking: {
            id: conflict.conflictingBooking.id,
            title: conflict.conflictingBooking.title,
            attendeeName: conflict.conflictingBooking.attendeeName,
            scheduledFor: conflict.conflictingBooking.scheduledFor,
            duration: conflict.conflictingBooking.duration,
          },
        });
      }

      // Create booking
      const booking = await storage.createBooking({
        leadId,
        clientId,
        title: `${
          meetingType === "site-visit" ? "Site Visit" : "Consultation"
        } - ${lead.firstName} ${lead.lastName}`,
        description: notes || `${meetingType} with ${client.name}`,
        location,
        scheduledAt: scheduledDate, // Your existing field
        scheduledFor: scheduledDate, // New field
        duration,
        status: "scheduled",
        attendeeEmail: lead.email,
        attendeeName: `${lead.firstName} ${lead.lastName}`,
        attendeePhone: lead.phone,
        meetingType,
        notes,
      });

      console.log("✅ Booking created:", booking.id);

      // Save booking notification as a message in the conversation
      try {
        console.log("🔍 Looking for conversation for leadId:", leadId);

        const conversations = await storage.getConversations(clientId, 100);
        console.log(
          `📊 Found ${conversations.length} conversations for clientId ${clientId}`
        );

        const conversation = conversations.find((c) => c.leadId === leadId);

        if (!conversation) {
          console.error("❌ No conversation found for this lead!");
          console.log(
            "Available leadIds:",
            conversations.map((c) => c.leadId)
          );
        } else {
          console.log("✅ Found conversation:", conversation.id);

          const messageContent =
            `📅 Meeting Scheduled!\n\n` +
            `Type: ${
              meetingType === "site-visit" ? "Site Visit" : "Consultation"
            }\n` +
            `Date: ${scheduledDate.toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
              timeZone: "America/Vancouver",
            })}\n` +
            `Time: ${scheduledDate.toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "America/Vancouver",
            })}\n` +
            `Duration: ${duration} minutes\n` +
            `Location: ${location}\n` +
            (notes ? `\nNotes: ${notes}` : "");

          const savedMessage = await storage.createMessage({
            conversationId: conversation.id,
            sender: "human",
            content: messageContent,
            channel: "whatsapp",
            isStatusMessage: true,
            sentAt: new Date(),
            deliveredAt: new Date(),
          });

          console.log("✅ Booking message saved:", savedMessage.id);

          // Broadcast the new message
          broadcastUpdate({
            type: "new_message",
            conversationId: conversation.id,
            message: savedMessage,
          });

          console.log("✅ Broadcast sent to WebSocket clients");
        }
      } catch (error) {
        console.error("❌ Failed to save booking message:", error);
      }

      // Calculate end time
      const startTime = scheduledDate;
      const endTime = new Date(startTime.getTime() + duration * 60000);

      // Send email with .ics if email exists
      if (lead.email) {
        const icsContent = emailService.generateICS({
          title: booking.title,
          description: booking.description || "",
          location: booking.location || "TBD",
          startTime,
          endTime,
          organizerEmail: process.env.EMAIL_USER || "noreply@aileadsystem.com",
          organizerName: client.name,
          attendeeEmail: lead.email,
          attendeeName: `${lead.firstName} ${lead.lastName}`,
        });

        const emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color: #2563eb;">Meeting Confirmed! 🎉</h2>
          <p>Hi ${lead.firstName},</p>
          <p>Your ${
            meetingType === "site-visit" ? "site visit" : "consultation"
          } has been scheduled.</p>
          
          <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">📅 Meeting Details</h3>
            <p><strong>Date:</strong> ${startTime.toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
              year: "numeric",
              timeZone: "America/Vancouver",
            })}</p>
            <p><strong>Time:</strong> ${startTime.toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "America/Vancouver",
            })}</p>
            <p><strong>Duration:</strong> ${duration} minutes</p>
            <p><strong>Location:</strong> ${location}</p>
          </div>
          
          <p>The meeting has been added to your calendar. See you then!</p>
          
          <p style="margin-top: 30px;">Best regards,<br>${client.name}</p>
        </div>
      `;

        await emailService.sendCalendarInvite({
          to: lead.email,
          toName: `${lead.firstName} ${lead.lastName}`,
          subject: `Meeting Confirmed - ${startTime.toLocaleDateString()}`,
          htmlBody: emailBody,
          icsContent,
          icsFilename: "meeting.ics",
        });
      }

      // Send WhatsApp confirmation
      if (lead.phone) {
        const whatsappMsg = `✅ Meeting Confirmed!

📅 ${startTime.toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          timeZone: "America/Vancouver",
        })}
🕐 ${startTime.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/Vancouver",
        })}
⏱️ ${duration} minutes
📍 ${location}

Check your email for the calendar invite. See you then!`;

        await whatsappService.sendTextMessage(lead.phone, whatsappMsg);
      }

      // Update lead status
      await storage.updateLead(leadId, { status: "contacted" });

      res.json({ success: true, booking });
    } catch (error) {
      console.error("❌ Error creating booking:", error);
      res.status(500).json({ message: "Failed to create booking" });
    }
  });

  // Reschedule booking
  app.patch("/api/bookings/:bookingId/reschedule", async (req, res) => {
    try {
      const { bookingId } = req.params;
      const { scheduledFor, duration, notes } = req.body;

      console.log("📅 Rescheduling booking:", bookingId);

      // Get existing booking
      const existingBooking = await storage.getBooking(bookingId);
      if (!existingBooking) {
        return res.status(404).json({ error: "Booking not found" });
      }

      // Get lead details
      const lead = await storage.getLead(existingBooking.leadId);
      if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
      }

      // Get client details
      const client = await storage.getClient(existingBooking.clientId);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }

      const newScheduledDate = new Date(scheduledFor);

      // Check for conflicts with existing bookings
      const existingBookings = await storage.getBookings(
        existingBooking.clientId
      );
      const scheduledEnd = new Date(
        newScheduledDate.getTime() +
          (duration || existingBooking.duration) * 60000
      );

      const conflict = hasBookingConflict(
        newScheduledDate,
        scheduledEnd,
        existingBookings,
        bookingId // Exclude current booking from conflict check
      );

      if (conflict.hasConflict && conflict.conflictingBooking) {
        const conflictStart = new Date(
          conflict.conflictingBooking.scheduledFor
        );
        const conflictEnd = new Date(
          conflictStart.getTime() + conflict.conflictingBooking.duration * 60000
        );

        return res.status(409).json({
          error: "Booking conflict detected",
          message: `There is already a meeting scheduled from ${conflictStart.toLocaleTimeString(
            "en-US",
            { hour: "2-digit", minute: "2-digit" }
          )} to ${conflictEnd.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
          })}`,
          conflictingBooking: {
            id: conflict.conflictingBooking.id,
            title: conflict.conflictingBooking.title,
            attendeeName: conflict.conflictingBooking.attendeeName,
            scheduledFor: conflict.conflictingBooking.scheduledFor,
            duration: conflict.conflictingBooking.duration,
          },
        });
      }

      // Update booking
      const updatedBooking = await storage.updateBooking(bookingId, {
        scheduledFor: newScheduledDate,
        scheduledAt: newScheduledDate,
        duration: duration || existingBooking.duration,
        notes: notes !== undefined ? notes : existingBooking.notes,
      });

      console.log("✅ Booking rescheduled:", updatedBooking.id);

      // Format date/time for notifications
      const formattedDate = newScheduledDate.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      const formattedTime = newScheduledDate.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });

      // Send updated email notification
      if (lead.email) {
        const startTime = newScheduledDate;
        const endTime = new Date(
          startTime.getTime() + (duration || existingBooking.duration) * 60000
        );

        const icsContent = emailService.generateICS({
          title: updatedBooking.title,
          description: updatedBooking.description || "",
          location: updatedBooking.location || "TBD",
          startTime,
          endTime,
          organizerEmail: process.env.EMAIL_USER || "noreply@aileadsystem.com",
          organizerName: client.name,
          attendeeEmail: lead.email,
          attendeeName: `${lead.firstName} ${lead.lastName}`,
        });

        const emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color: #f59e0b;">⚠️ Meeting Rescheduled</h2>
          <p>Hi ${lead.firstName},</p>
          <p>Your meeting has been rescheduled to a new time.</p>
          
          <div style="background: #fef3c7; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f59e0b;">
            <h3 style="margin-top: 0; color: #92400e;">📅 New Meeting Details</h3>
            <p><strong>Date:</strong> ${formattedDate}</p>
            <p><strong>Time:</strong> ${formattedTime}</p>
            <p><strong>Duration:</strong> ${
              duration || existingBooking.duration
            } minutes</p>
            <p><strong>Location:</strong> ${
              updatedBooking.location || "TBD"
            }</p>
          </div>
          
          <p>The updated meeting has been added to your calendar.</p>
          
          <p style="margin-top: 30px;">Best regards,<br>${client.name}</p>
        </div>
      `;

        await emailService.sendCalendarInvite({
          to: lead.email,
          toName: `${lead.firstName} ${lead.lastName}`,
          subject: `Meeting Rescheduled - ${formattedDate}`,
          htmlBody: emailBody,
          icsContent,
          icsFilename: "meeting-updated.ics",
        });

        console.log("✅ Reschedule email sent");
      }

      // Send WhatsApp notification
      if (lead.phone) {
        const whatsappMsg = `⚠️ Meeting Rescheduled

Hi ${lead.firstName}! Your meeting has been moved to a new time:

📅 ${formattedDate}
🕐 ${formattedTime}
⏱️ ${duration || existingBooking.duration} minutes
📍 ${updatedBooking.location || "TBD"}

Check your email for the updated calendar invite. See you then!`;

        await whatsappService.sendTextMessage(lead.phone, whatsappMsg);
        console.log("✅ Reschedule WhatsApp sent");
      }

      // Add message to conversation
      try {
        const conversations = await storage.getConversations(
          existingBooking.clientId,
          100
        );
        const conversation = conversations.find(
          (c) => c.leadId === existingBooking.leadId
        );

        if (conversation) {
          const messageContent =
            `🔄 Meeting Rescheduled\n\n` +
            `New Date: ${formattedDate}\n` +
            `New Time: ${formattedTime}\n` +
            `Duration: ${duration || existingBooking.duration} minutes\n` +
            `Location: ${updatedBooking.location || "TBD"}\n` +
            (notes ? `\nNotes: ${notes}` : "");

          await storage.createMessage({
            conversationId: conversation.id,
            sender: "human",
            content: messageContent,
            channel: "whatsapp",
            isStatusMessage: true,
            sentAt: new Date(),
            deliveredAt: new Date(),
          });

          console.log("✅ Reschedule message added to conversation");

          broadcastUpdate({
            type: "new_message",
            conversationId: conversation.id,
            message: messageContent,
          });
        }
      } catch (error) {
        console.error("⚠️ Failed to add reschedule message:", error);
      }

      // Broadcast booking update
      broadcastUpdate({
        type: "booking_updated",
        booking: updatedBooking,
      });

      res.json({ success: true, booking: updatedBooking });
    } catch (error: any) {
      console.error("❌ Error rescheduling booking:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Edit booking details (location, duration, notes, type)
  app.patch("/api/bookings/:bookingId/edit", async (req, res) => {
    try {
      const { bookingId } = req.params;
      const { duration, location, notes, meetingType } = req.body;

      console.log("✏️ Editing booking details:", bookingId);

      // Get existing booking
      const existingBooking = await storage.getBooking(bookingId);
      if (!existingBooking) {
        return res.status(404).json({ error: "Booking not found" });
      }

      // Get lead details
      const lead = await storage.getLead(existingBooking.leadId);
      if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
      }

      // If duration changed, check for conflicts
      if (duration && duration !== existingBooking.duration) {
        const existingBookings = await storage.getBookings(
          existingBooking.clientId
        );
        const scheduledStart = new Date(existingBooking.scheduledFor);
        const newEnd = new Date(scheduledStart.getTime() + duration * 60000);

        const conflict = hasBookingConflict(
          scheduledStart,
          newEnd,
          existingBookings,
          bookingId // Exclude current booking
        );

        if (conflict.hasConflict && conflict.conflictingBooking) {
          const conflictStart = new Date(
            conflict.conflictingBooking.scheduledFor
          );
          const conflictEnd = new Date(
            conflictStart.getTime() +
              conflict.conflictingBooking.duration * 60000
          );

          return res.status(409).json({
            error: "Booking conflict detected",
            message: `The new duration creates a conflict with a meeting from ${conflictStart.toLocaleTimeString(
              "en-US",
              { hour: "2-digit", minute: "2-digit" }
            )} to ${conflictEnd.toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
            })}`,
            conflictingBooking: {
              id: conflict.conflictingBooking.id,
              title: conflict.conflictingBooking.title,
              attendeeName: conflict.conflictingBooking.attendeeName,
              scheduledFor: conflict.conflictingBooking.scheduledFor,
              duration: conflict.conflictingBooking.duration,
            },
          });
        }
      }

      // Update booking
      const updatedBooking = await storage.updateBooking(bookingId, {
        duration: duration || existingBooking.duration,
        location: location || existingBooking.location,
        notes: notes !== undefined ? notes : existingBooking.notes,
        meetingType: meetingType || existingBooking.meetingType,
      });

      console.log("✅ Booking details updated:", updatedBooking.id);

      // Add message to conversation
      try {
        const conversations = await storage.getConversations(
          existingBooking.clientId,
          100
        );
        const conversation = conversations.find(
          (c) => c.leadId === existingBooking.leadId
        );

        if (conversation) {
          const scheduledDate = new Date(existingBooking.scheduledFor);
          const formattedDate = scheduledDate.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          });
          const formattedTime = scheduledDate.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
          });

          const changes = [];
          if (duration && duration !== existingBooking.duration) {
            changes.push(
              `Duration: ${existingBooking.duration} min → ${duration} min`
            );
          }
          if (location && location !== existingBooking.location) {
            changes.push(`Location: ${existingBooking.location} → ${location}`);
          }
          if (meetingType && meetingType !== existingBooking.meetingType) {
            changes.push(
              `Type: ${existingBooking.meetingType} → ${meetingType}`
            );
          }

          const messageContent =
            `📝 Meeting Details Updated\n\n` +
            `Meeting: ${existingBooking.title}\n` +
            `Date: ${formattedDate} at ${formattedTime}\n\n` +
            `Changes:\n${changes.join("\n")}`;

          await storage.createMessage({
            conversationId: conversation.id,
            sender: "human",
            content: messageContent,
            channel: "whatsapp",
            isStatusMessage: true,
            sentAt: new Date(),
            deliveredAt: new Date(),
          });

          console.log("✅ Details update message added to conversation");

          broadcastUpdate({
            type: "new_message",
            conversationId: conversation.id,
            message: messageContent,
          });
        }
      } catch (error) {
        console.error("⚠️ Failed to add update message:", error);
      }

      // Broadcast booking update
      broadcastUpdate({
        type: "booking_updated",
        booking: updatedBooking,
      });

      res.json({ success: true, booking: updatedBooking });
    } catch (error: any) {
      console.error("❌ Error updating booking details:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Cancel booking
  app.patch("/api/bookings/:bookingId/cancel", async (req, res) => {
    try {
      const { bookingId } = req.params;
      const { reason } = req.body;

      console.log("❌ Cancelling booking:", bookingId);

      // Get existing booking
      const existingBooking = await storage.getBooking(bookingId);
      if (!existingBooking) {
        return res.status(404).json({ error: "Booking not found" });
      }

      // Get lead details
      const lead = await storage.getLead(existingBooking.leadId);
      if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
      }

      // Get client details
      const client = await storage.getClient(existingBooking.clientId);
      if (!client) {
        return res.status(404).json({ error: "Client not found" });
      }

      // Update booking status to cancelled
      const updatedBooking = await storage.updateBooking(bookingId, {
        status: "cancelled",
        notes: reason ? `Cancelled: ${reason}` : existingBooking.notes,
      });

      console.log("✅ Booking cancelled:", updatedBooking.id);

      // Format date/time for notifications
      const scheduledDate = new Date(existingBooking.scheduledFor);
      const formattedDate = scheduledDate.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      const formattedTime = scheduledDate.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });

      // Send cancellation email
      if (lead.email) {
        const emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color: #dc2626;">❌ Meeting Cancelled</h2>
          <p>Hi ${lead.firstName},</p>
          <p>We regret to inform you that your scheduled meeting has been cancelled.</p>
          
          <div style="background: #fee2e2; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc2626;">
            <h3 style="margin-top: 0; color: #7f1d1d;">📅 Cancelled Meeting Details</h3>
            <p><strong>Meeting:</strong> ${existingBooking.title}</p>
            <p><strong>Originally Scheduled:</strong> ${formattedDate} at ${formattedTime}</p>
            <p><strong>Duration:</strong> ${
              existingBooking.duration
            } minutes</p>
            <p><strong>Location:</strong> ${
              existingBooking.location || "TBD"
            }</p>
            ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}
          </div>
          
          <p>If you would like to reschedule, please contact us and we'll be happy to find a new time that works for you.</p>
          
          <p style="margin-top: 30px;">We apologize for any inconvenience.</p>
          <p>Best regards,<br>${client.name}</p>
        </div>
      `;

        await emailService.sendCalendarInvite({
          to: lead.email,
          toName: `${lead.firstName} ${lead.lastName}`,
          subject: `Meeting Cancelled - ${existingBooking.title}`,
          htmlBody: emailBody,
          icsContent: "", // No calendar invite for cancellation
          icsFilename: "",
        });

        console.log("✅ Cancellation email sent");
      }

      // Send WhatsApp notification
      if (lead.phone) {
        const whatsappMsg = `❌ Meeting Cancelled

Hi ${lead.firstName}, your scheduled meeting has been cancelled.

📅 ${formattedDate}
🕐 ${formattedTime}
📍 ${existingBooking.location || "TBD"}
${reason ? `\n❓ Reason: ${reason}` : ""}

If you'd like to reschedule, please let us know. We apologize for any inconvenience.`;

        await whatsappService.sendTextMessage(lead.phone, whatsappMsg);
        console.log("✅ Cancellation WhatsApp sent");
      }

      // Add message to conversation
      try {
        const conversations = await storage.getConversations(
          existingBooking.clientId,
          100
        );
        const conversation = conversations.find(
          (c) => c.leadId === existingBooking.leadId
        );

        if (conversation) {
          const messageContent =
            `❌ Meeting Cancelled\n\n` +
            `Meeting: ${existingBooking.title}\n` +
            `Was scheduled for: ${formattedDate} at ${formattedTime}\n` +
            `Duration: ${existingBooking.duration} minutes\n` +
            `Location: ${existingBooking.location || "TBD"}\n` +
            (reason ? `\nReason: ${reason}` : "");

          await storage.createMessage({
            conversationId: conversation.id,
            sender: "human",
            content: messageContent,
            channel: "whatsapp",
            isStatusMessage: true,
            sentAt: new Date(),
            deliveredAt: new Date(),
          });

          console.log("✅ Cancellation message added to conversation");

          broadcastUpdate({
            type: "new_message",
            conversationId: conversation.id,
            message: messageContent,
          });
        }
      } catch (error) {
        console.error("⚠️ Failed to add cancellation message:", error);
      }

      // Broadcast booking update
      broadcastUpdate({
        type: "booking_updated",
        booking: updatedBooking,
      });

      res.json({ success: true, booking: updatedBooking });
    } catch (error: any) {
      console.error("❌ Error cancelling booking:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Update booking status (mark as completed/no-show)
  app.patch("/api/bookings/:bookingId/status", async (req, res) => {
    try {
      const { bookingId } = req.params;
      const { status, notes } = req.body;

      console.log("📊 Updating booking status:", bookingId, "to", status);

      // Validate status
      const validStatuses = ["scheduled", "completed", "no-show", "cancelled"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      // Get existing booking
      const existingBooking = await storage.getBooking(bookingId);
      if (!existingBooking) {
        return res.status(404).json({ error: "Booking not found" });
      }

      // Get lead details
      const lead = await storage.getLead(existingBooking.leadId);
      if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
      }

      // Update booking status
      const updatedBooking = await storage.updateBooking(bookingId, {
        status,
        notes: notes || existingBooking.notes,
      });

      console.log("✅ Booking status updated:", updatedBooking.id, status);

      // Add message to conversation
      try {
        const conversations = await storage.getConversations(
          existingBooking.clientId,
          100
        );
        const conversation = conversations.find(
          (c) => c.leadId === existingBooking.leadId
        );

        if (conversation) {
          const scheduledDate = new Date(existingBooking.scheduledFor);
          const formattedDate = scheduledDate.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          });
          const formattedTime = scheduledDate.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
          });

          let messageContent = "";
          let statusEmoji = "";

          switch (status) {
            case "completed":
              statusEmoji = "✅";
              messageContent =
                `✅ Meeting Completed\n\n` +
                `Meeting: ${existingBooking.title}\n` +
                `Date: ${formattedDate} at ${formattedTime}\n` +
                `Duration: ${existingBooking.duration} minutes\n` +
                `Status: Successfully completed`;
              break;
            case "no-show":
              statusEmoji = "❌";
              messageContent =
                `❌ No-Show Recorded\n\n` +
                `Meeting: ${existingBooking.title}\n` +
                `Date: ${formattedDate} at ${formattedTime}\n` +
                `Status: Lead did not attend`;
              break;
            case "scheduled":
              statusEmoji = "📅";
              messageContent =
                `📅 Meeting Status Updated\n\n` +
                `Meeting: ${existingBooking.title}\n` +
                `Date: ${formattedDate} at ${formattedTime}\n` +
                `Status: Rescheduled/Reactivated`;
              break;
          }

          if (messageContent) {
            await storage.createMessage({
              conversationId: conversation.id,
              sender: "human",
              content: messageContent,
              channel: "whatsapp",
              isStatusMessage: true,
              sentAt: new Date(),
              deliveredAt: new Date(),
            });

            console.log("✅ Status update message added to conversation");

            broadcastUpdate({
              type: "new_message",
              conversationId: conversation.id,
              message: messageContent,
            });
          }
        }
      } catch (error) {
        console.error("⚠️ Failed to add status message:", error);
      }

      // Broadcast booking update
      broadcastUpdate({
        type: "booking_updated",
        booking: updatedBooking,
      });

      res.json({ success: true, booking: updatedBooking });
    } catch (error: any) {
      console.error("❌ Error updating booking status:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get bookings for client
  app.get("/api/bookings/:clientId", requireAuth, async (req, res) => {
    try {
      const { clientId } = req.params;
      const requestUser = req.user!;

      // Verify ownership
      if (requestUser.role !== "super_admin") {
        const client = await storage.getClient(clientId);
        if (!client || client.userId !== requestUser.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const bookings = await storage.getBookings(clientId);
      res.json(bookings);
    } catch (error) {
      console.error("Error fetching bookings:", error);
      res.status(500).json({ message: "Failed to fetch bookings" });
    }
  });

  // Test reminder endpoint (REMOVE IN PRODUCTION)
  app.post("/api/bookings/:bookingId/test-reminder", async (req, res) => {
    try {
      const { bookingId } = req.params;
      const { timeframe } = req.body; // "24h" or "1h"

      const booking = await storage.getBooking(bookingId);
      if (!booking) {
        return res.status(404).json({ error: "Booking not found" });
      }

      // Dynamically import the service
      const { sendMeetingReminder } = await import(
        "./services/reminder-service"
      );
      const result = await sendMeetingReminder(
        booking,
        timeframe || "24h",
        broadcastUpdate
      );

      res.json({ success: true, result });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Approve pending booking (agent one-click)
  app.post(
    "/api/bookings/:bookingId/approve",
    requireAuth,
    async (req, res) => {
      try {
        const { bookingId } = req.params;

        console.log("✅ Agent approving booking:", bookingId);

        const booking = await storage.getBooking(bookingId);
        if (!booking) {
          return res.status(404).json({ error: "Booking not found" });
        }

        if (booking.status !== "pending_approval") {
          return res.status(400).json({ error: "Booking is not pending" });
        }

        const lead = await storage.getLead(booking.leadId);
        const client = await storage.getClient(booking.clientId);

        if (!lead || !client) {
          return res.status(404).json({ error: "Lead or client not found" });
        }

        // Approve booking
        const updatedBooking = await storage.approveBooking(
          bookingId,
          req.user!.id
        );

        console.log("✅ Booking approved, sending confirmations...");

        const startTime = new Date(booking.scheduledFor);
        const formattedDate = startTime.toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
          timeZone: "America/Vancouver",
        });
        const formattedTime = startTime.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/Vancouver",
        });

        // ✅ NEW: Add approval message to conversation FIRST
        try {
          const conversations = await storage.getConversations(
            booking.clientId,
            100
          );
          const conversation = conversations.find(
            (c) => c.leadId === booking.leadId
          );

          if (conversation) {
            const approvalMessage = await storage.createMessage({
              conversationId: conversation.id,
              sender: "human",
              content: `✅ Meeting Approved & Confirmed

📅 ${formattedDate}
🕐 ${formattedTime}
⏱️ ${booking.duration} minutes
📍 ${booking.location || "TBD"}

Calendar invite sent via email and WhatsApp.`,
              channel: "whatsapp",
              isStatusMessage: true,
              sentAt: new Date(),
              deliveredAt: new Date(),
            });

            console.log("✅ Approval message added to conversation");

            // Broadcast immediately so agent sees it
            broadcastUpdate({
              type: "new_message",
              conversationId: conversation.id,
              message: approvalMessage,
            });
          }
        } catch (error) {
          console.error("⚠️ Failed to add approval message:", error);
        }

        // Send email with calendar invite
        if (lead.email) {
          const endTime = new Date(
            startTime.getTime() + booking.duration! * 60000
          );

          const icsContent = emailService.generateICS({
            title: booking.title,
            description: booking.notes || `Meeting with ${client.name}`,
            location: booking.location || "TBD",
            startTime,
            endTime,
            organizerEmail:
              process.env.EMAIL_USER || "noreply@aileadsystem.com",
            organizerName: client.name,
            attendeeEmail: lead.email,
            attendeeName: `${lead.firstName} ${lead.lastName}`,
          });

          const emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color: #2563eb;">✅ Meeting Confirmed!</h2>
          <p>Hi ${lead.firstName},</p>
          <p>Your meeting has been confirmed.</p>
          
          <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">📅 Meeting Details</h3>
            <p><strong>Date:</strong> ${formattedDate}</p>
            <p><strong>Time:</strong> ${formattedTime}</p>
            <p><strong>Duration:</strong> ${booking.duration} minutes</p>
            <p><strong>Location:</strong> ${booking.location || "TBD"}</p>
          </div>
          
          <p>The meeting has been added to your calendar. See you then!</p>
          
          <p style="margin-top: 30px;">Best regards,<br>${client.name}</p>
        </div>
      `;

          await emailService.sendCalendarInvite({
            to: lead.email,
            toName: `${lead.firstName} ${lead.lastName}`,
            subject: `Meeting Confirmed - ${formattedDate}`,
            htmlBody: emailBody,
            icsContent,
            icsFilename: "meeting.ics",
          });

          console.log("✅ Confirmation email sent");
        }

        // Send WhatsApp confirmation
        if (lead.phone) {
          const whatsappMsg = `✅ Meeting Confirmed!

📅 ${formattedDate}
🕐 ${formattedTime}
⏱️ ${booking.duration} minutes
📍 ${booking.location || "TBD"}

Check your email for the calendar invite. See you then!`;

          await whatsappService.sendTextMessage(lead.phone, whatsappMsg);
          console.log("✅ Confirmation WhatsApp sent");
        }

        // Broadcast booking approval
        broadcastUpdate({
          type: "booking_approved",
          bookingId: booking.id,
          booking: updatedBooking,
        });

        res.json({ success: true, booking: updatedBooking });
      } catch (error: any) {
        console.error("❌ Error approving booking:", error);
        res.status(500).json({ error: error.message });
      }
    }
  );

  // Decline pending booking
  app.post(
    "/api/bookings/:bookingId/decline",
    requireAuth,
    async (req, res) => {
      try {
        const { bookingId } = req.params;
        const { reason } = req.body;

        console.log("❌ Agent declining booking:", bookingId);

        const booking = await storage.getBooking(bookingId);
        if (!booking) {
          return res.status(404).json({ error: "Booking not found" });
        }

        const lead = await storage.getLead(booking.leadId);
        const client = await storage.getClient(booking.clientId);

        if (!lead || !client) {
          return res.status(404).json({ error: "Lead or client not found" });
        }

        // Reject booking in database
        await storage.rejectBooking(bookingId, reason);

        console.log("✅ Booking declined in database");

        const startTime = new Date(booking.scheduledFor);
        const formattedDate = startTime.toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
        });
        const formattedTime = startTime.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        });

        // ✅ NEW: Add decline message to conversation
        try {
          const conversations = await storage.getConversations(
            booking.clientId,
            100
          );
          const conversation = conversations.find(
            (c) => c.leadId === booking.leadId
          );

          if (conversation) {
            const declineMessage = await storage.createMessage({
              conversationId: conversation.id,
              sender: "human",
              content: `❌ Booking Request Declined

The proposed meeting for:
📅 ${formattedDate} at ${formattedTime}

Could not be scheduled at this time.${reason ? `\n\nReason: ${reason}` : ""}

Please suggest alternative times that work for you.`,
              channel: "whatsapp",
              isStatusMessage: true,
              sentAt: new Date(),
              deliveredAt: new Date(),
            });

            console.log("✅ Decline message added to conversation");

            // Broadcast immediately
            broadcastUpdate({
              type: "new_message",
              conversationId: conversation.id,
              message: declineMessage,
            });
          }
        } catch (error) {
          console.error("⚠️ Failed to add decline message:", error);
        }

        // ✅ NEW: Send WhatsApp notification to lead
        if (lead.phone) {
          const whatsappMsg = `Hi ${lead.firstName},

Unfortunately, we're unable to confirm the meeting for ${formattedDate} at ${formattedTime}.${
            reason ? `\n\n${reason}` : ""
          }

Could you suggest some alternative times that work for you? We'd love to find a time that suits your schedule.`;

          await whatsappService.sendTextMessage(lead.phone, whatsappMsg);
          console.log("✅ Decline WhatsApp sent to lead");
        }

        // ✅ NEW: Send email notification
        if (lead.email) {
          const emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color: #dc2626;">Unable to Confirm Meeting</h2>
          <p>Hi ${lead.firstName},</p>
          <p>Unfortunately, we're unable to confirm the meeting at the requested time.</p>
          
          <div style="background: #fee2e2; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc2626;">
            <h3 style="margin-top: 0; color: #7f1d1d;">📅 Requested Time</h3>
            <p><strong>Date:</strong> ${formattedDate}</p>
            <p><strong>Time:</strong> ${formattedTime}</p>
            ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}
          </div>
          
          <p>Please reply with some alternative times that work for you, and we'll do our best to accommodate your schedule.</p>
          
          <p style="margin-top: 30px;">Best regards,<br>${client.name}</p>
        </div>
      `;

          await emailService.sendCalendarInvite({
            to: lead.email,
            toName: `${lead.firstName} ${lead.lastName}`,
            subject: `Meeting Request - Alternative Time Needed`,
            htmlBody: emailBody,
            icsContent: "",
            icsFilename: "",
          });

          console.log("✅ Decline email sent");
        }

        // Broadcast booking decline
        broadcastUpdate({
          type: "booking_declined",
          bookingId: booking.id,
        });

        res.json({ success: true });
      } catch (error: any) {
        console.error("❌ Error declining booking:", error);
        res.status(500).json({ error: error.message });
      }
    }
  );

  // Get pending bookings
  app.get("/api/bookings/:clientId/pending", requireAuth, async (req, res) => {
    try {
      const { clientId } = req.params;
      const pendingBookings = await storage.getPendingBookings(clientId);
      res.json(pendingBookings);
    } catch (error: any) {
      console.error("❌ Error fetching pending bookings:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Export bookings to CSV
  app.get("/api/bookings/:clientId/export", requireAuth, async (req, res) => {
    try {
      const { clientId } = req.params;
      const requestUser = req.user!;

      // Verify ownership
      if (requestUser.role !== "super_admin") {
        const client = await storage.getClient(clientId);
        if (!client || client.userId !== requestUser.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const bookings = await storage.getBookings(clientId);

      // Build CSV
      const csvHeaders = [
        "Title",
        "Attendee Name",
        "Email",
        "Phone",
        "Date",
        "Time",
        "Duration (min)",
        "Location",
        "Meeting Type",
        "Status",
        "Notes",
        "Created Date",
      ].join(",");

      const csvRows = bookings.map((booking) => {
        const scheduledDate = new Date(booking.scheduledFor);
        const dateStr = scheduledDate.toLocaleDateString("en-US", {
          timeZone: "America/Vancouver",
        });
        const timeStr = scheduledDate.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/Vancouver",
        });
        const createdDate = booking.createdAt
          ? new Date(booking.createdAt).toLocaleDateString()
          : "";

        return [
          `"${booking.title || ""}"`,
          `"${booking.attendeeName || ""}"`,
          `"${booking.attendeeEmail || ""}"`,
          `"${booking.attendeePhone || ""}"`,
          `"${dateStr}"`,
          `"${timeStr}"`,
          `"${booking.duration || 60}"`,
          `"${booking.location || ""}"`,
          `"${booking.meetingType || "consultation"}"`,
          `"${booking.status || "scheduled"}"`,
          `"${(booking.notes || "").replace(/"/g, '""')}"`,
          `"${createdDate}"`,
        ].join(",");
      });

      const csv = [csvHeaders, ...csvRows].join("\n");

      // Set headers for download
      const filename = `bookings-export-${
        new Date().toISOString().split("T")[0]
      }.csv`;
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );

      res.send(csv);
    } catch (error) {
      console.error("Error exporting bookings:", error);
      res.status(500).json({ message: "Failed to export bookings" });
    }
  });

  // =========================== USER TRIAL MANAGEMENT ROUTES  ====================================

  // Get user trial status
  app.get("/api/user/trial-status", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id; // ✅ Use authenticated user
      const status = await storage.getUserTrialStatus(userId);
      res.json(status);
    } catch (error) {
      console.error("Error fetching trial status:", error);
      res.status(500).json({ message: "Failed to fetch trial status" });
    }
  });

  // Activate trial
  app.post("/api/user/activate-trial", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id; // ✅ Use authenticated user

      console.log("🎉 Activating trial for user:", userId);

      // Check if trial already activated
      const currentStatus = await storage.getUserTrialStatus(userId);
      if (currentStatus?.hasUnlockedTrial) {
        return res.status(400).json({
          message: "Trial has already been activated for this account",
        });
      }

      // Activate trial
      const result = await storage.activateUserTrial(userId);

      // Log the activation
      await storage.logUserActivity(userId, "trial_activated", "trial", {
        trialDays: 14,
        source: "trial-unlock-page",
      });

      console.log("✅ Trial activated successfully for user:", userId);

      res.json(result);
    } catch (error) {
      console.error("Error activating trial:", error);
      res.status(500).json({ message: "Failed to activate trial" });
    }
  });

  // ============================== SUPER ADMIN ROUTES  ===============================

  // Super admin dashboard
  app.get("/api/super-admin/dashboard", requireSuperAdmin, async (req, res) => {
    try {
      const dashboard = await storage.getSuperAdminDashboard();
      res.json(dashboard);
    } catch (error) {
      console.error("Error fetching super admin dashboard:", error);
      res.status(500).json({ message: "Failed to fetch dashboard data" });
    }
  });

  // Super admin: View all clients (read-only)
  // Super admin: View all clients (read-only)
  app.get("/api/super-admin/clients", requireSuperAdmin, async (req, res) => {
    try {
      const allClients = await storage.getAllClientsWithUsers();
      res.json(allClients);
    } catch (error) {
      console.error("Error fetching all clients:", error);
      res.status(500).json({ message: "Failed to fetch clients" });
    }
  });

  // Super admin: Get all users
  app.get("/api/super-admin/users", requireSuperAdmin, async (req, res) => {
    try {
      const { search, status } = req.query;
      const users = await storage.getAllUsersForAdmin(
        search as string,
        status as string
      );
      res.json(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // Create user (super admin only)
  // Super admin: Create user
  app.post("/api/super-admin/users", requireSuperAdmin, async (req, res) => {
    try {
      const { email, firstName, lastName, role, subscriptionType, password } =
        req.body;

      console.log("👤 Creating new user:", email);

      // Check if user already exists
      const existingUser = await storage.getUserByEmail(email);
      if (existingUser) {
        return res
          .status(400)
          .json({ message: "User with this email already exists" });
      }

      // Hash password
      const tempPassword = password || "Welcome123!";
      const passwordHash = await bcrypt.hash(tempPassword, 10);

      // Create user
      const user = await storage.createUser({
        email,
        firstName,
        lastName,
        role: role || "user",
        subscriptionType: subscriptionType || "trial",
        passwordHash,
        isActive: true,
      });

      console.log("✅ User created:", user.id);

      res.json({
        ...user,
        temporaryPassword: tempPassword,
      });
    } catch (error) {
      console.error("❌ Error creating user:", error);
      res.status(500).json({ message: "Failed to create user" });
    }
  });

  app.get("/api/super-admin/activities", async (req, res) => {
    try {
      const activities = await storage.getRecentActivities();
      res.json(activities);
    } catch (error) {
      console.error("Error fetching activities:", error);
      res.status(500).json({ message: "Failed to fetch activities" });
    }
  });

  app.get("/api/super-admin/metrics", async (req, res) => {
    try {
      const metrics = await storage.recordSystemMetrics();
      res.json(metrics);
    } catch (error) {
      console.error("Error recording metrics:", error);
      res.status(500).json({ message: "Failed to record metrics" });
    }
  });

  // ==================== EMAIL VERIFICATION ROUTES ====================

  // Resend verification email
  app.post("/api/auth/resend-verification", async (req, res) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }

      console.log("📧 Resending verification email to:", email);

      // Get user
      const user = await storage.getUserByEmail(email);
      if (!user) {
        // Don't reveal if user exists or not (security)
        return res.json({
          success: true,
          message: "If an account exists, verification email has been sent",
        });
      }

      // Check if already verified
      if (user.emailVerified) {
        return res.status(400).json({
          message: "Email is already verified",
        });
      }

      // Send verification email
      const { sendVerificationEmail } = await import(
        "./services/email-verification"
      );
      await sendVerificationEmail(user.email!, user.id, user.firstName!);

      res.json({
        success: true,
        message: "Verification email sent successfully",
      });
    } catch (error) {
      console.error("Error resending verification:", error);
      res.status(500).json({ message: "Failed to send verification email" });
    }
  });

  // Verify email with token
  app.get("/api/auth/verify/:token", async (req, res) => {
    try {
      const { token } = req.params;

      console.log("🔍 Verifying email token");

      // Verify and decode token
      const { verifyToken } = await import("./services/email-verification");
      const decoded = verifyToken(token);

      if (decoded.type !== "email_verification") {
        return res.status(400).json({ message: "Invalid token type" });
      }

      // Get user
      const user = await storage.getUserById(decoded.userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Check if already verified
      if (user.emailVerified) {
        return res.json({
          success: true,
          message: "Email already verified",
          alreadyVerified: true,
        });
      }

      // Verify email
      await storage.verifyUserEmail(user.id);

      console.log(`✅ Email verified for user: ${user.email}`);

      res.json({
        success: true,
        message: "Email verified successfully! You can now log in.",
      });
    } catch (error: any) {
      console.error("Email verification error:", error);

      if (error.message === "Invalid or expired token") {
        return res.status(400).json({
          message: "Verification link is invalid or has expired",
          expired: true,
        });
      }

      res.status(500).json({ message: "Email verification failed" });
    }
  });

  // ==================== USER PROFILE & SETTINGS ROUTES ====================
  // Update user profile
  app.patch("/api/user/profile", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { firstName, lastName, phone, bio } = req.body;

      console.log("📝 Updating profile for user:", userId);

      // Update user
      const updatedUser = await storage.updateUser(userId, {
        firstName,
        lastName,
        phone,
        // bio can be stored in a separate preferences table or ignored for now
        updatedAt: new Date(),
      });

      // Log activity
      await storage.logUserActivity(userId, "profile_updated", "user", {
        fields: Object.keys(req.body),
      });

      console.log("✅ Profile updated successfully");
      res.json({
        success: true,
        user: {
          id: updatedUser.id,
          email: updatedUser.email,
          firstName: updatedUser.firstName,
          lastName: updatedUser.lastName,
          phone: updatedUser.phone,
        },
      });
    } catch (error: any) {
      console.error("❌ Error updating profile:", error);
      res.status(500).json({
        message: error.message || "Failed to update profile",
      });
    }
  });

  // Change password (secure with bcrypt)
  app.post("/api/user/change-password", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { currentPassword, newPassword } = req.body;

      console.log("🔐 Password change requested for user:", userId);

      // Validate input
      if (!currentPassword || !newPassword) {
        return res.status(400).json({
          message: "Current password and new password are required",
        });
      }

      // ✅ SECURITY: Validate new password strength
      if (newPassword.length < 8) {
        return res.status(400).json({
          message: "Password must be at least 8 characters long",
        });
      }

      if (!/[A-Z]/.test(newPassword)) {
        return res.status(400).json({
          message: "Password must contain at least one uppercase letter",
        });
      }

      if (!/[a-z]/.test(newPassword)) {
        return res.status(400).json({
          message: "Password must contain at least one lowercase letter",
        });
      }

      if (!/[0-9]/.test(newPassword)) {
        return res.status(400).json({
          message: "Password must contain at least one number",
        });
      }

      if (!/[!@#$%^&*(),.?":{}|<>]/.test(newPassword)) {
        return res.status(400).json({
          message: "Password must contain at least one special character",
        });
      }

      // Get user from database
      const user = await storage.getUserById(userId);
      if (!user || !user.passwordHash) {
        return res.status(404).json({ message: "User not found" });
      }

      // ✅ SECURITY: Verify current password
      const isCurrentPasswordValid = await bcrypt.compare(
        currentPassword,
        user.passwordHash
      );

      if (!isCurrentPasswordValid) {
        console.log("❌ Current password is incorrect");
        // Log failed attempt
        await storage.logUserActivity(
          userId,
          "password_change_failed",
          "security",
          {
            reason: "incorrect_current_password",
            timestamp: new Date().toISOString(),
          }
        );
        return res.status(401).json({
          message: "Current password is incorrect",
        });
      }

      // ✅ SECURITY: Check if new password is different from current
      const isSameAsOld = await bcrypt.compare(newPassword, user.passwordHash);
      if (isSameAsOld) {
        return res.status(400).json({
          message: "New password must be different from current password",
        });
      }

      // ✅ SECURITY: Hash new password with bcrypt (salt rounds: 12 for security)
      const newPasswordHash = await bcrypt.hash(newPassword, 12);

      // Update password
      await storage.updateUser(userId, {
        passwordHash: newPasswordHash,
        updatedAt: new Date(),
      });

      // Log successful password change
      await storage.logUserActivity(userId, "password_changed", "security", {
        timestamp: new Date().toISOString(),
      });

      console.log("✅ Password changed successfully");
      res.json({
        success: true,
        message: "Password changed successfully",
      });
    } catch (error: any) {
      console.error("❌ Error changing password:", error);
      res.status(500).json({
        message: error.message || "Failed to change password",
      });
    }
  });

  // Update user preferences
  app.patch("/api/user/preferences", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const {
        emailNotifications,
        whatsappNotifications,
        leadNotifications,
        bookingNotifications,
        weeklyReports,
        timezone,
        language,
      } = req.body;

      console.log("⚙️ Updating preferences for user:", userId);
      console.log("📊 Notification preferences:", {
        emailNotifications,
        whatsappNotifications,
        leadNotifications,
        bookingNotifications,
        weeklyReports,
      });

      // Get current user
      const user = await storage.getUserById(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // ✅ FIX: Update notification preferences in dedicated columns
      const updateData: any = {
        updatedAt: new Date(),
      };

      // Update notification columns (if provided)
      if (emailNotifications !== undefined) {
        updateData.emailNotifications = emailNotifications;
      }
      if (whatsappNotifications !== undefined) {
        updateData.whatsappNotifications = whatsappNotifications;
      }
      if (leadNotifications !== undefined) {
        updateData.leadNotifications = leadNotifications;
      }
      if (bookingNotifications !== undefined) {
        updateData.bookingNotifications = bookingNotifications;
      }
      if (weeklyReports !== undefined) {
        updateData.weeklyReports = weeklyReports;
      }

      // ✅ ALSO: Update settings JSONB for regional preferences
      if (timezone || language) {
        const currentSettings = (user.settings as any) || {};
        updateData.settings = {
          ...currentSettings,
          regional: {
            timezone: timezone || currentSettings.regional?.timezone,
            language: language || currentSettings.regional?.language,
          },
          updatedAt: new Date().toISOString(),
        };
      }

      // Update user
      await storage.updateUser(userId, updateData);

      // Log activity
      await storage.logUserActivity(userId, "preferences_updated", "user", {
        preferencesChanged: Object.keys(req.body),
      });

      console.log("✅ Preferences updated successfully");
      console.log("📊 Updated values:", updateData);

      res.json({
        success: true,
        message: "Preferences updated successfully",
      });
    } catch (error: any) {
      console.error("❌ Error updating preferences:", error);
      res.status(500).json({
        message: error.message || "Failed to update preferences",
      });
    }
  });

  app.get("/api/user/activity", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { type, startDate, endDate } = req.query;

      console.log(
        `[API] Fetching activity log for user: ${userId} with filters:`,
        { type, startDate, endDate }
      );

      const filters = {
        type: type as string | undefined,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
      };

      // Validate dates
      if (filters.startDate && isNaN(filters.startDate.getTime())) {
        filters.startDate = undefined;
      }
      if (filters.endDate && isNaN(filters.endDate.getTime())) {
        filters.endDate = undefined;
      }

      // ✅ THIS IS THE FIX: Pass the 'filters' object as the second argument
      const activities = await storage.getUserActivityLog(userId, filters);

      res.json({ activities });
    } catch (error) {
      console.error("❌ Error fetching user activity:", error);
      res.status(500).json({ message: "Failed to fetch user activity log" });
    }
  });

  // ==================== ACCOUNT DELETION ROUTE ====================
  app.post("/api/user/delete-account", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { password, twoFactorCode } = req.body;

      console.log(`🗑️ [DELETE ACCOUNT] Request received for user: ${userId}`);

      // Get user from database
      const user = await storage.getUserById(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      console.log(`🔍 [DELETE ACCOUNT] User info:`, {
        email: user.email,
        hasPassword: !!user.passwordHash,
        oauthProvider: user.oauthProvider,
        googleId: user.googleId,
      });

      // ✅ IMPROVED: Determine authentication method
      const isOAuthOnly =
        !user.passwordHash && (user.oauthProvider || user.googleId);
      const hasPassword = !!user.passwordHash;

      console.log(`🔐 [DELETE ACCOUNT] Auth type:`, {
        isOAuthOnly,
        hasPassword,
        requiresPassword: hasPassword,
      });

      // ✅ SECURITY CHECK 1: Verify password (if account has one)
      if (hasPassword) {
        if (!password) {
          return res.status(400).json({
            message: "Password is required to delete your account",
          });
        }

        console.log(`🔐 [DELETE ACCOUNT] Verifying password...`);

        const isPasswordValid = await bcrypt.compare(
          password,
          user.passwordHash!
        );

        if (!isPasswordValid) {
          console.log(
            `❌ [DELETE ACCOUNT] Invalid password for user: ${userId}`
          );

          // Log failed attempt
          await storage.logUserActivity(
            userId,
            "account_deletion_failed",
            "security",
            {
              reason: "incorrect_password",
              timestamp: new Date().toISOString(),
            }
          );

          return res.status(401).json({
            message: "Incorrect password",
          });
        }

        console.log(`✅ [DELETE ACCOUNT] Password verified`);
      } else if (isOAuthOnly) {
        // ✅ OAuth-only account: No password to verify
        console.log(
          `✅ [DELETE ACCOUNT] OAuth-only account, skipping password check`
        );

        // For extra security, you could require them to re-authenticate via OAuth
        // But for now, we'll allow deletion with just checkbox + 2FA (if enabled)
      } else {
        // Account has neither password nor OAuth? This shouldn't happen
        console.error(
          `⚠️ [DELETE ACCOUNT] Account has no authentication method`
        );
        return res.status(500).json({
          message: "Account authentication error. Please contact support.",
        });
      }

      // ✅ SECURITY CHECK 2: Verify 2FA if enabled
      if (user.twoFactorEnabled) {
        if (!twoFactorCode) {
          return res.status(400).json({
            message: "Two-factor authentication code is required",
            requires2FA: true,
          });
        }

        const { verify2FACode, decrypt2FASecret } = await import(
          "./services/2fa-service"
        );

        console.log(`🔐 [DELETE ACCOUNT] Decrypting 2FA secret...`);
        const decryptedSecret = decrypt2FASecret(user.twoFactorSecret!);

        console.log(`🔍 [DELETE ACCOUNT] Verifying 2FA code...`);
        const isValidCode = verify2FACode(decryptedSecret, twoFactorCode);

        if (!isValidCode) {
          console.log(
            `❌ [DELETE ACCOUNT] Invalid 2FA code for user: ${userId}`
          );

          await storage.logUserActivity(
            userId,
            "account_deletion_failed",
            "security",
            {
              reason: "incorrect_2fa_code",
              timestamp: new Date().toISOString(),
            }
          );

          return res.status(401).json({
            message: "Invalid two-factor authentication code",
          });
        }

        console.log(`✅ [DELETE ACCOUNT] 2FA verified`);
      }

      // ✅ STEP 1: Cancel active Stripe subscription
      try {
        console.log(`💳 [DELETE ACCOUNT] Checking for active subscription...`);

        const [subscription] = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.userId, userId))
          .orderBy(desc(subscriptions.createdAt))
          .limit(1);

        if (
          subscription &&
          subscription.stripeSubscriptionId &&
          subscription.status === "active"
        ) {
          console.log(
            `💳 [DELETE ACCOUNT] Canceling Stripe subscription: ${subscription.stripeSubscriptionId}`
          );

          const stripe = (await import("stripe")).default;
          const stripeClient = new stripe(process.env.STRIPE_SECRET_KEY!);

          await stripeClient.subscriptions.cancel(
            subscription.stripeSubscriptionId
          );

          console.log(`✅ [DELETE ACCOUNT] Stripe subscription canceled`);
        } else {
          console.log(`ℹ️ [DELETE ACCOUNT] No active subscription to cancel`);
        }
      } catch (stripeError) {
        console.error(
          `⚠️ [DELETE ACCOUNT] Stripe cancellation error:`,
          stripeError
        );
      }

      // ✅ STEP 2: Send deletion confirmation email BEFORE deleting
      try {
        await emailService.sendAccountDeletionEmail({
          to: user.email!,
          toName: user.firstName || "User",
        });
        console.log(`✅ [DELETE ACCOUNT] Deletion email sent`);
      } catch (emailError) {
        console.error(`⚠️ [DELETE ACCOUNT] Email sending error:`, emailError);
      }

      // ✅ STEP 3: Log the deletion BEFORE actually deleting
      await storage.logUserActivity(userId, "account_deleted", "user", {
        email: user.email,
        deletedAt: new Date().toISOString(),
        authMethod: isOAuthOnly
          ? "oauth_only"
          : hasPassword
          ? "password"
          : "unknown",
        had2FA: user.twoFactorEnabled,
        hadSubscription: !!user.stripeCustomerId,
      });

      // ✅ STEP 4: Cascade delete all user data
      await storage.deleteUserAccount(userId);

      // ✅ STEP 5: Destroy session
      req.session.destroy((err) => {
        if (err) {
          console.error("Session destruction error:", err);
        }
      });

      console.log(
        `🎯 [DELETE ACCOUNT] Account successfully deleted for user: ${userId}`
      );

      res.json({
        success: true,
        message: "Your account has been permanently deleted",
      });
    } catch (error: any) {
      console.error(`❌ [DELETE ACCOUNT] Error:`, error);
      res.status(500).json({
        message:
          error.message || "Failed to delete account. Please contact support.",
      });
    }
  });

  // ==================== PASSWORD RESET ROUTES ====================

  // Request password reset
  app.post("/api/auth/forgot-password", async (req, res) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }

      console.log("🔐 Password reset requested for:", email);

      // Get user
      const user = await storage.getUserByEmail(email);
      if (!user) {
        // Don't reveal if user exists or not (security)
        return res.json({
          success: true,
          message: "If an account exists, password reset email has been sent",
        });
      }

      // Generate reset token
      const { generatePasswordResetToken, sendPasswordResetEmail } =
        await import("./services/email-verification");
      const token = generatePasswordResetToken(user.id, user.email!);

      // Save token to database with 1 hour expiry
      const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await storage.updatePasswordResetToken(user.id, token, expiry);

      // Send reset email
      await sendPasswordResetEmail(user.email!, user.id, user.firstName!);

      console.log(`✅ Password reset email sent to: ${email}`);

      res.json({
        success: true,
        message: "Password reset email sent successfully",
      });
    } catch (error) {
      console.error("Password reset request error:", error);
      res.status(500).json({ message: "Failed to process password reset" });
    }
  });

  // Reset password with token
  app.post("/api/auth/reset-password/:token", async (req, res) => {
    try {
      const { token } = req.params;
      const { password } = req.body;

      if (!password) {
        return res.status(400).json({ message: "Password is required" });
      }

      if (password.length < 8) {
        return res
          .status(400)
          .json({ message: "Password must be at least 8 characters" });
      }

      console.log("🔐 Resetting password with token");

      // Verify token
      const { verifyToken } = await import("./services/email-verification");
      const decoded = verifyToken(token);

      if (decoded.type !== "password_reset") {
        return res.status(400).json({ message: "Invalid token type" });
      }

      // Get user by reset token (double-check it's in database)
      const user = await storage.getUserByResetToken(token);
      if (!user) {
        return res.status(400).json({
          message: "Invalid or expired reset token",
        });
      }

      // Check token expiry
      if (user.passwordResetExpiry && user.passwordResetExpiry < new Date()) {
        return res.status(400).json({
          message: "Reset token has expired. Please request a new one.",
          expired: true,
        });
      }

      // Hash new password
      const newPasswordHash = await bcrypt.hash(password, 10);

      // Update password
      await storage.resetUserPassword(user.id, newPasswordHash);

      console.log(`✅ Password reset successful for user: ${user.email}`);

      res.json({
        success: true,
        message: "Password reset successfully! You can now log in.",
      });
    } catch (error: any) {
      console.error("Password reset error:", error);

      if (error.message === "Invalid or expired token") {
        return res.status(400).json({
          message: "Reset link is invalid or has expired",
          expired: true,
        });
      }

      res.status(500).json({ message: "Password reset failed" });
    }
  });

  // ==================== SET PASSWORD (OAuth Users) ====================

  app.post("/api/user/set-password", requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { newPassword } = req.body;

      console.log(`🔐 [SET PASSWORD] Request for user: ${userId}`);

      // Get user
      const user = await storage.getUserById(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Check if user already has password

      if (user.passwordHash) {
        console.log(`❌ [SET PASSWORD] User already has password`);
        return res.status(400).json({
          message: "Password already set. Use 'Change Password' instead",
        });
      }

      // Validate password
      if (!newPassword) {
        return res.status(400).json({ message: "New password is required" });
      }

      if (newPassword.length < 8) {
        return res.status(400).json({
          message: "Password must be at least 8 characters long",
        });
      }

      // Password strength validation
      if (!/[A-Z]/.test(newPassword)) {
        return res.status(400).json({
          message: "Password must contain at least one uppercase letter",
        });
      }

      if (!/[a-z]/.test(newPassword)) {
        return res.status(400).json({
          message: "Password must contain at least one lowercase letter",
        });
      }

      if (!/[0-9]/.test(newPassword)) {
        return res.status(400).json({
          message: "Password must contain at least one number",
        });
      }

      if (!/[!@#$%^&*(),.?":{}|<>]/.test(newPassword)) {
        return res.status(400).json({
          message: "Password must contain at least one special character",
        });
      }

      console.log(`✅ [SET PASSWORD] Password validation passed`);

      // Hash and set password
      const passwordHash = await bcrypt.hash(newPassword, 10);

      await db
        .update(users)
        .set({
          passwordHash,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      // Log the action
      await storage.logUserActivity(userId, "password_set", "security", {
        timestamp: new Date().toISOString(),
        accountType: user.oauthProvider || "unknown",
      });

      console.log(
        `✅ [SET PASSWORD] Password set successfully for user: ${userId}`
      );

      res.json({
        success: true,
        message:
          "Password set successfully. You can now login with your email and password.",
      });
    } catch (error: any) {
      console.error("❌ [SET PASSWORD] Error:", error);
      res.status(500).json({
        message: error.message || "Failed to set password",
      });
    }
  });

  // ==================== PROFILE PICTURE ROUTES ====================

// Configure multer for memory storage
const profilePictureStorage = multer.memoryStorage();
const profilePictureUpload = multer({
  storage: profilePictureStorage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

// 📤 Upload/Update Profile Picture
app.post(
  "/api/user/profile-picture",
  requireAuth,
  profilePictureUpload.single("profileImage"),
  async (req, res) => {
    try {
      const userId = req.user!.id;

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      console.log("📤 [PROFILE PICTURE] Upload started for user:", userId);
      console.log("  File size:", req.file.size, "bytes");
      console.log("  File type:", req.file.mimetype);

      // Get current user
      const [currentUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, userId));

      if (!currentUser) {
        return res.status(404).json({ error: "User not found" });
      }

      // Delete old Cloudinary image if exists
      if (
        currentUser.profileImageUrl &&
        currentUser.profileImageUrl.includes("cloudinary.com")
      ) {
        try {
          const urlParts = currentUser.profileImageUrl.split("/");
          const publicIdWithExt = urlParts[urlParts.length - 1];
          const publicId = `profile-pictures/${publicIdWithExt.split(".")[0]}`;
          await cloudinary.uploader.destroy(publicId);
          console.log("🗑️ Old image deleted:", publicId);
        } catch (deleteError) {
          console.warn("⚠️ Failed to delete old image:", deleteError);
        }
      }

      // Upload to Cloudinary
      const uploadPromise = new Promise<any>((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: "profile-pictures",
            transformation: [
              { width: 400, height: 400, crop: "fill", gravity: "face" },
              { quality: "auto" },
              { fetch_format: "auto" },
            ],
            public_id: `user_${userId}_${Date.now()}`,
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(req.file!.buffer);
      });

      const uploadResult = await uploadPromise;

      console.log("✅ Image uploaded to Cloudinary:", uploadResult.secure_url);

      // Update database
      const [updatedUser] = await db
        .update(users)
        .set({
          profileImageUrl: uploadResult.secure_url,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
        .returning();

      console.log("✅ Database updated with new profile picture");

      res.json({
        success: true,
        profileImageUrl: updatedUser.profileImageUrl,
        message: "Profile picture updated successfully",
      });
    } catch (error: any) {
      console.error("❌ [PROFILE PICTURE] Upload error:", error);
      res.status(500).json({
        error: "Failed to upload profile picture",
        details: error.message,
      });
    }
  }
);

// 🗑️ Delete Profile Picture
app.delete("/api/user/profile-picture", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;

    console.log("🗑️ [PROFILE PICTURE] Delete started for user:", userId);

    // Get current user
    const [currentUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId));

    if (!currentUser) {
      return res.status(404).json({ error: "User not found" });
    }

    // Delete from Cloudinary if it's a Cloudinary image
    if (
      currentUser.profileImageUrl &&
      currentUser.profileImageUrl.includes("cloudinary.com")
    ) {
      try {
        const urlParts = currentUser.profileImageUrl.split("/");
        const publicIdWithExt = urlParts[urlParts.length - 1];
        const publicId = `profile-pictures/${publicIdWithExt.split(".")[0]}`;
        await cloudinary.uploader.destroy(publicId);
        console.log("✅ Cloudinary image deleted:", publicId);
      } catch (deleteError) {
        console.warn("⚠️ Failed to delete from Cloudinary:", deleteError);
      }
    }

    // Update database
    await db
      .update(users)
      .set({
        profileImageUrl: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    console.log("✅ Profile picture removed from database");

    res.json({
      success: true,
      message: "Profile picture removed successfully",
    });
  } catch (error: any) {
    console.error("❌ [PROFILE PICTURE] Delete error:", error);
    res.status(500).json({
      error: "Failed to remove profile picture",
      details: error.message,
    });
  }
});

  // ================================= ADVANCED ROUTES  ===============================

  // Mount advanced routes
  app.use("/api", advancedRoutes);

  // ========================= SYSTEM HEALTH ROUTES  =============================

  // System health endpoint
app.get("/api/health", async (req, res) => {
  try {
    const { getSystemHealth } = await import("./services/health-monitor");
    const health = await getSystemHealth();

    const response = {
      whatsapp: health.whatsapp.status,
      ai: health.ai.status,
      vsl: health.vsl.status,
      uptime: health.uptime,
      timestamp: health.timestamp,
    };

    res.json(response);
  } catch (error: any) {
    console.error("❌ Health check error:", error);
    res.status(500).json({ 
      message: "Health check failed",
      timestamp: new Date().toISOString(),
    });
  }
});
  // ==================== AI HEALTH & RETRY ROUTES ====================

  // Get AI health status
  app.get("/api/ai/health", requireAuth, async (req, res) => {
    try {
      const { getClaudeAPIHealth } = await import("./services/claude");
      const { aiHealthMonitor } = await import("./services/ai-health-monitor");

      const health = getClaudeAPIHealth();
      const metrics = aiHealthMonitor.getMetrics();
      const successRate = aiHealthMonitor.getSuccessRate();

      res.json({
        status: health.status,
        isHealthy: health.isHealthy,
        consecutive529Errors: health.consecutive529Errors,
        metrics: {
          totalRequests: metrics.totalRequests,
          successfulRequests: metrics.successfulRequests,
          failedRequests: metrics.failedRequests,
          successRate: successRate.toFixed(2) + "%",
          avgResponseTime: Math.round(metrics.avgResponseTime) + "ms",
        },
        lastChecked: metrics.timestamp,
      });
    } catch (error: any) {
      console.error("Error fetching AI health:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get failed messages stats for a client
  app.get(
    "/api/ai/failed-messages/:clientId",
    requireAuth,
    async (req, res) => {
      try {
        const { clientId } = req.params;
        const requestUser = req.user!;

        // Verify ownership
        if (requestUser.role !== "super_admin") {
          const client = await storage.getClient(clientId);
          if (!client || client.userId !== requestUser.id) {
            return res.status(403).json({ message: "Access denied" });
          }
        }

        const stats = await storage.getFailedMessagesStats(clientId);
        res.json(stats);
      } catch (error: any) {
        console.error("Error fetching failed messages stats:", error);
        res.status(500).json({ error: error.message });
      }
    }
  );

  // Manually retry a failed message
  app.post("/api/ai/retry/:messageId", requireAuth, async (req, res) => {
    try {
      const { messageId } = req.params;

      console.log(`🔄 Manual retry requested for message: ${messageId}`);

      // Get the failed message
      const failedMessages = await storage.getPendingFailedMessages(1000);
      const failedMessage = failedMessages.find((m) => m.id === messageId);

      if (!failedMessage) {
        return res.status(404).json({ message: "Failed message not found" });
      }

      // Verify user owns this client
      const requestUser = req.user!;
      if (requestUser.role !== "super_admin") {
        const client = await storage.getClient(failedMessage.clientId);
        if (!client || client.userId !== requestUser.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      // Queue for immediate retry
      await storage.updateFailedMessage(messageId, {
        retryAfter: new Date(), // Now
        status: "pending",
      });

      console.log(`✅ Message ${messageId} queued for immediate retry`);

      res.json({
        success: true,
        message: "Message queued for retry",
      });
    } catch (error: any) {
      console.error("Error manually retrying message:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get retry worker stats
  app.get("/api/ai/retry-stats", requireSuperAdmin, async (req, res) => {
    try {
      const { aiRetryWorker } = await import("./services/ai-retry-worker");
      const stats = await aiRetryWorker.getStats();
      res.json(stats);
    } catch (error: any) {
      console.error("Error fetching retry stats:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // ========================= START FOLLOW-UP CRON  =============================

  
  // Start follow-up worker
  const { startFollowUpCron, setBroadcastFunction: setFollowUpBroadcast } =
    await import("./services/follow-up-worker");

  setFollowUpBroadcast(broadcastUpdate);
  startFollowUpCron();

  console.log("🚀 Follow-up cron job started");

  // ✅ NEW: Start AI retry worker
  const { aiRetryWorker } = await import("./services/ai-retry-worker");
  aiRetryWorker.setBroadcastFunction(broadcastUpdate);

  // ✅ NEW: Start AI health monitor
  const { aiHealthMonitor } = await import("./services/ai-health-monitor");
  aiHealthMonitor.setBroadcastFunction(broadcastUpdate);

  console.log("✅ AI retry worker and health monitor connected to WebSocket");

  // ========================= START REMINDER CRON  ============================
  setBroadcastFunction(broadcastUpdate);
  startReminderCron();

  // After your other routes
  // app.use(vslapp);
  return httpServer;
}

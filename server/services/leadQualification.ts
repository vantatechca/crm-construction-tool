// server/services/leadQualification.ts
// ✅ ALL QA FIXES INTEGRATED: Spam Termination, Booking Flow, Meeting Timing

import { messageQueue } from "./messageQueue";
import { storage } from "../storage";
import {
  qualifyLead,
  generateAIResponse,
  detectTimeChange,
  detectBookingIntent,
  extractLeadDetails,
  extractConversationContext,
  detectBookingState,
  detectRefusal,
} from "./claude";
import { whatsappService } from "./whatsapp";
import { WebSocketServer } from "ws";
import type { InsertBooking } from "../../shared/schema";
import { notificationService } from "./notification-sevice";

// ✅ Constants
const BOOKING_CONFIDENCE_THRESHOLD = 0.8;
const BOOKING_INTEREST_THRESHOLD = 0.5;

// ✅ Booking detail validation interface
interface BookingDetails {
  hasDate: boolean;
  hasTime: boolean;
  hasAddress: boolean;
  hasName: boolean;
  hasEmail: boolean;
  missingDetails: string[];
}

// ✅ IMPROVED: Better time normalization (from claude.ts)
function normalizeTimeString(timeStr: string): string {
  if (!timeStr) {
    console.log("⚠️ No time provided, defaulting to 10:00 AM");
    return "10:00 AM";
  }

  const upperTime = timeStr.toUpperCase().trim();
  console.log(`🕐 Normalizing time: "${timeStr}" → "${upperTime}"`);

  const match = upperTime.match(/(\d{1,2})(?::(\d{2}))?\s*([AP]M)?/);

  if (!match) {
    console.warn(
      `⚠️ Could not parse time "${timeStr}", using default 10:00 AM`
    );
    return "10:00 AM";
  }

  let hours = parseInt(match[1]);
  const minutes = match[2] || "00";
  let period = match[3];

  console.log(
    `🕐 Parsed components: hours=${hours}, minutes=${minutes}, period=${period}`
  );

  if (!period) {
    console.log(`🕐 No AM/PM found, treating as 24-hour format`);
    if (hours >= 12) {
      period = "PM";
      if (hours > 12) hours -= 12;
    } else {
      period = "AM";
      if (hours === 0) hours = 12;
    }
    console.log(`🕐 Converted to 12-hour: ${hours} ${period}`);
  }

  if (hours < 1 || hours > 12) {
    console.warn(
      `⚠️ Invalid hour "${hours}" after conversion, using default 10:00 AM`
    );
    return "10:00 AM";
  }

  const normalized = `${hours}:${minutes} ${period}`;
  console.log(`✅ Normalized time result: "${normalized}"`);

  return normalized;
}

// ✅ Robust date parser with TIMEZONE-AWARE handling
function parseDateFromNaturalLanguage(
  dateStr: string,
  timeStr: string
): Date | null {
  const now = new Date();
  const currentYear = now.getFullYear();

  const normalizedTime = timeStr ? normalizeTimeString(timeStr) : "10:00 AM";

  console.log(`📅 Parsing date: "${dateStr}" with time: "${normalizedTime}"`);

  const timeMatch = normalizedTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!timeMatch) {
    console.error(`❌ Invalid time format: "${normalizedTime}"`);
    return null;
  }

  let hours = parseInt(timeMatch[1]);
  const minutes = parseInt(timeMatch[2]);
  const period = timeMatch[3].toUpperCase();

  if (period === "PM" && hours !== 12) hours += 12;
  if (period === "AM" && hours === 12) hours = 0;

  console.log(
    `⏰ Parsed time: ${hours}:${String(minutes).padStart(2, "0")} (24h format)`
  );

  const lowerDate = dateStr.toLowerCase().trim();
  const dayNames = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];

  // Handle relative dates
  if (lowerDate === "today") {
    const targetDate = new Date(now);
    const year = targetDate.getFullYear();
    const month = String(targetDate.getMonth() + 1).padStart(2, "0");
    const day = String(targetDate.getDate()).padStart(2, "0");
    const hourStr = String(hours).padStart(2, "0");
    const minStr = String(minutes).padStart(2, "0");
    const pacificDateString = `${year}-${month}-${day}T${hourStr}:${minStr}:00-08:00`;
    const pacificDate = new Date(pacificDateString);
    console.log(`✅ "Today" parsed: ${pacificDate.toISOString()}`);
    return pacificDate;
  }

  if (lowerDate === "tomorrow") {
    const targetDate = new Date(now);
    targetDate.setDate(now.getDate() + 1);
    const year = targetDate.getFullYear();
    const month = String(targetDate.getMonth() + 1).padStart(2, "0");
    const day = String(targetDate.getDate()).padStart(2, "0");
    const hourStr = String(hours).padStart(2, "0");
    const minStr = String(minutes).padStart(2, "0");
    const pacificDateString = `${year}-${month}-${day}T${hourStr}:${minStr}:00-08:00`;
    const pacificDate = new Date(pacificDateString);
    console.log(`✅ "Tomorrow" parsed: ${pacificDate.toISOString()}`);
    return pacificDate;
  }

  // Handle "next [DayName]" and "this [DayName]"
  const nextDayPattern =
    /^(next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
  const nextDayMatch = lowerDate.match(nextDayPattern);

  if (nextDayMatch) {
    console.log(`🔍 Parsing "${lowerDate}" with pattern "next/this [Day]"`);
    const modifier = nextDayMatch[1].toLowerCase();
    const dayName = nextDayMatch[2].toLowerCase();
    console.log(`   Modifier: "${modifier}", Day: "${dayName}"`);

    const targetDayIndex = dayNames.indexOf(dayName);
    const currentDay = now.getDay();
    let daysUntil = targetDayIndex - currentDay;

    if (modifier === "next") {
      if (daysUntil <= 0) {
        daysUntil += 7;
      } else {
        daysUntil += 7;
      }
    } else {
      if (daysUntil < 0) {
        daysUntil += 7;
      }
    }

    const targetDate = new Date(now);
    targetDate.setDate(now.getDate() + daysUntil);
    const year = targetDate.getFullYear();
    const month = String(targetDate.getMonth() + 1).padStart(2, "0");
    const day = String(targetDate.getDate()).padStart(2, "0");
    const hourStr = String(hours).padStart(2, "0");
    const minStr = String(minutes).padStart(2, "0");
    const pacificDateString = `${year}-${month}-${day}T${hourStr}:${minStr}:00-08:00`;
    const pacificDate = new Date(pacificDateString);
    console.log(`✅ "${lowerDate}" parsed: ${pacificDate.toISOString()}`);
    return pacificDate;
  }

  // Handle day names (Monday, Tuesday, etc)
  if (dayNames.includes(lowerDate)) {
    const targetDay = dayNames.indexOf(lowerDate);
    const currentDay = now.getDay();
    let daysUntil = targetDay - currentDay;
    if (daysUntil <= 0) {
      daysUntil += 7;
    }

    const targetDate = new Date(now);
    targetDate.setDate(now.getDate() + daysUntil);
    const year = targetDate.getFullYear();
    const month = String(targetDate.getMonth() + 1).padStart(2, "0");
    const day = String(targetDate.getDate()).padStart(2, "0");
    const hourStr = String(hours).padStart(2, "0");
    const minStr = String(minutes).padStart(2, "0");
    const pacificDateString = `${year}-${month}-${day}T${hourStr}:${minStr}:00-08:00`;
    const pacificDate = new Date(pacificDateString);
    console.log(`✅ Day name parsed: ${pacificDate.toISOString()}`);
    return pacificDate;
  }

  // Handle full date strings with explicit month parsing
  const monthNames = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const monthAbbr = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];

  let month = -1;
  let day = -1;

  const datePattern = /(\w+)\s+(\d{1,2})|(\d{1,2})\s+(\w+)/i;
  const match = dateStr.match(datePattern);

  if (match) {
    const monthStr = (match[1] || match[4]).toLowerCase();
    day = parseInt(match[2] || match[3]);

    month = monthNames.indexOf(monthStr);
    if (month === -1) {
      month = monthAbbr.indexOf(monthStr);
    }

    if (month !== -1 && day > 0 && day <= 31) {
      const dateString = `${currentYear}-${String(month + 1).padStart(
        2,
        "0"
      )}-${String(day).padStart(2, "0")}T${String(hours).padStart(
        2,
        "0"
      )}:${String(minutes).padStart(2, "0")}:00-08:00`;
      console.log(`📅 Creating date string: ${dateString}`);
      const targetDate = new Date(dateString);
      console.log(`✅ Explicit date created: ${targetDate.toISOString()}`);

      if (targetDate < now) {
        console.warn(`⚠️ Date is in the past, trying next year...`);
        const nextYearDateString = `${currentYear + 1}-${String(
          month + 1
        ).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(
          hours
        ).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00-08:00`;
        return new Date(nextYearDateString);
      }

      return targetDate;
    }
  }

  return null;
}

// ✅ Smart day suggestions
function getSmartDaySuggestions(): string {
  const now = new Date();
  const currentDay = now.getDay();
  const currentHour = now.getHours();
  const dayNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  const startDay = currentHour >= 15 ? currentDay + 1 : currentDay;
  const suggestions: string[] = [];

  for (let i = startDay; i < startDay + 7 && suggestions.length < 3; i++) {
    const dayIndex = i % 7;
    if (dayIndex === 0 || dayIndex === 6) continue;

    const daysAway = i - currentDay;
    if (daysAway === 0) {
      suggestions.push("today");
    } else if (daysAway === 1) {
      suggestions.push("tomorrow");
    } else if (daysAway <= 7) {
      suggestions.push(`this ${dayNames[dayIndex]}`);
    } else {
      suggestions.push(`next ${dayNames[dayIndex]}`);
    }
  }

  if (suggestions.length >= 2) {
    return `${suggestions[0]} or ${suggestions[1]}`;
  } else if (suggestions.length === 1) {
    return suggestions[0];
  } else {
    return "this week";
  }
}

// ✅ NEW: Validate booking details
function validateBookingDetails(bookingIntent: any, lead: any): BookingDetails {
  const missing: string[] = [];

  const hasDate = !!bookingIntent.proposedDateTime?.date;
  const hasTime = !!bookingIntent.proposedDateTime?.time;

  if (!hasDate)
    missing.push("specific date (e.g., November 15 or next Monday)");
  if (!hasTime) missing.push("time (e.g., 2 PM or 14:00)");

  const location = bookingIntent.location || "";
  const addressKeywords = [
    "st",
    "ave",
    "rd",
    "blvd",
    "drive",
    "way",
    "lane",
    "court",
    "place",
    "street",
    "avenue",
    "road",
    "boulevard",
    "cres",
    "crescent",
    "pkwy",
    "parkway",
    "circle",
    "terrace",
    "plaza",
    "square",
  ];

  const hasAddress =
    location.length > 15 &&
    (addressKeywords.some((keyword) =>
      location.toLowerCase().includes(keyword)
    ) ||
      location.includes(",") ||
      /[A-Z]\d[A-Z]\s?\d[A-Z]\d/i.test(location) ||
      /\d{5}(-\d{4})?/.test(location) ||
      /RR\d+/i.test(location));

  if (!hasAddress) {
    missing.push("specific address (street, city) for the site visit");
  }

  const hasName =
    lead.firstName &&
    lead.firstName !== lead.phone &&
    !lead.firstName.startsWith("639") &&
    !lead.firstName.startsWith("+") &&
    !lead.firstName.toLowerCase().includes("unknown") &&
    lead.firstName.length > 2;

  if (!hasName) {
    missing.push("your full name");
  }

  const hasEmail =
    lead.email &&
    !lead.email.includes("whatsapp_") &&
    !lead.email.includes("@temp.com") &&
    lead.email.includes("@") &&
    lead.email.includes(".");

  if (!hasEmail) {
    missing.push("email address for the calendar invite");
  }

  return {
    hasDate,
    hasTime,
    hasAddress,
    hasName,
    hasEmail,
    missingDetails: missing,
  };
}

export class LeadQualificationService {
  private wss: WebSocketServer | null = null;

  setWebSocketServer(wss: WebSocketServer) {
    this.wss = wss;
  }

  private async trackResponseTime(
    conversationId: string,
    leadId: string,
    sender: "ai" | "human"
  ): Promise<void> {
    try {
      const messages = await storage.getMessages(conversationId);

      const firstLeadMessage = messages
        .filter((m) => m.sender === "lead" && m.sentAt !== null)
        .sort((a, b) => {
          const timeA = new Date(a.sentAt!).getTime();
          const timeB = new Date(b.sentAt!).getTime();
          return timeA - timeB;
        })[0];

      const firstResponse = messages
        .filter(
          (m) =>
            (m.sender === "ai" || m.sender === "human") &&
            m.sentAt !== null &&
            !m.isStatusMessage
        )
        .sort((a, b) => {
          const timeA = new Date(a.sentAt!).getTime();
          const timeB = new Date(b.sentAt!).getTime();
          return timeA - timeB;
        })[0];

      if (firstLeadMessage && !firstResponse) {
        const sentAt = firstLeadMessage.sentAt;
        if (!sentAt) {
          console.log("⚠️ First lead message has no sentAt timestamp");
          return;
        }

        const leadMessageTime = new Date(sentAt);
        const responseTime = new Date();
        const responseTimeSeconds = Math.round(
          (responseTime.getTime() - leadMessageTime.getTime()) / 1000
        );

        if (responseTimeSeconds < 0) {
          console.warn(
            `⚠️ Negative response time detected: ${responseTimeSeconds}s - skipping`
          );
          return;
        }

        if (responseTimeSeconds > 86400) {
          console.warn(
            `⚠️ Unusually long response time: ${responseTimeSeconds}s (${(
              responseTimeSeconds / 3600
            ).toFixed(1)} hours)`
          );
        }

        console.log(
          `⏱️ ${sender.toUpperCase()} Response time: ${responseTimeSeconds}s (${(
            responseTimeSeconds / 60
          ).toFixed(1)} min)`
        );

        await storage.updateLead(leadId, {
          responseTimeSeconds,
        });

        console.log(`✅ Response time saved to lead ${leadId}`);
      }
    } catch (error) {
      console.error("❌ Error tracking response time:", error);
    }
  }

  async processNewLead(leadId: string): Promise<void> {
    try {
      const lead = await storage.getLead(leadId);
      if (!lead) throw new Error("Lead not found");

      const client = await storage.getClient(lead.clientId);
      if (!client) throw new Error("Client not found");

      const conversation = await storage.createConversation({
        leadId: lead.id,
        clientId: lead.clientId,
        channel: "whatsapp",
        status: "active",
        isAiHandled: true,
        qualificationScore: "0.0",
      });

      if (lead.phone && lead.auditResults) {
        const auditData = lead.auditResults as any;
        const success = await whatsappService.sendAuditResult(
          lead.phone,
          lead.firstName || "there",
          auditData.type || "audit",
          auditData.topFinding || "Key opportunities identified",
          `https://app.example.com/audit/${lead.id}`
        );

        const createdAt = lead.createdAt
          ? new Date(lead.createdAt).getTime()
          : Date.now();
        const responseTime = Math.floor((Date.now() - createdAt) / 1000);

        await storage.updateLead(lead.id, {
          responseTimeSeconds: responseTime,
        });

        await storage.createMessage({
          conversationId: conversation.id,
          content: `Audit result sent via WhatsApp`,
          sender: "ai",
          channel: "whatsapp",
          sentAt: new Date(),
        });

        this.broadcastUpdate({
          type: "new_conversation",
          conversation: {
            ...conversation,
            lead,
          },
        });
      }
    } catch (error) {
      console.error("Error processing new lead:", error);
    }
  }

  async queueIncomingMessage(
    from: string,
    message: string,
    timestamp: number,
    phoneNumberId?: string,
    messageId?: string
  ): Promise<void> {
    console.log(`📨 Queueing message from ${from}, messageId: ${messageId}`);
    await messageQueue.enqueueMessage(
      from,
      message,
      timestamp,
      this.handleIncomingMessage.bind(this),
      phoneNumberId,
      messageId
    );
  }

  private async handleIncomingMessage(
    from: string,
    message: string,
    timestamp: number,
    phoneNumberId?: string,
    messageId?: string
  ): Promise<void> {
    try {
      // ✅ Prevent duplicate message processing
      if (messageId) {
        const existingMessage = await storage.getMessageByWhatsAppId(messageId);
        if (existingMessage) {
          console.log(`⚠️ Message ${messageId} already processed, skipping`);
          return;
        }
      }

      console.log("=== INCOMING MESSAGE ===");
      console.log("From:", from);
      console.log("Message:", message);
      console.log("Phone Number ID:", phoneNumberId);
      console.log("WhatsApp Message ID:", messageId);

      // Resolve the destination tenant before using the sender's phone number.
      // Existing leads may have been created under a different client.
      const targetClientForMessage = phoneNumberId
        ? await storage.getClientByWhatsAppPhoneNumberId(phoneNumberId)
        : undefined;

      // Step 1: Find or create lead
      let lead = await storage.getLeadByPhone(from);

      if (
        lead &&
        targetClientForMessage &&
        lead.clientId !== targetClientForMessage.id
      ) {
        const previousClientId = lead.clientId;
        console.log(
          `Moving lead ${lead.id} from client ${previousClientId} to WhatsApp client ${targetClientForMessage.id}`
        );

        const previousConversations = await storage.getAllConversations(
          previousClientId
        );
        for (const previousConversation of previousConversations) {
          if (previousConversation.leadId === lead.id) {
            await storage.updateConversation(previousConversation.id, {
              clientId: targetClientForMessage.id,
            });
          }
        }

        lead = await storage.updateLead(lead.id, {
          clientId: targetClientForMessage.id,
        });
      }

      if (!lead) {
        console.log("📝 Unknown number - creating new lead automatically");
        const allUsers = await storage.getAllUsersForAdmin();
        let targetClient = null;

        if (phoneNumberId) {
          console.log(
            `🔍 Looking for client with Phone number ID: ${phoneNumberId}`
          );
          for (const user of allUsers) {
            if (user.role === "super_admin") continue;
            const userClients = await storage.getClients(user.id);
            const matchedClient = userClients.find(
              (c) => c.isActive && c.whatsappPhoneNumberId === phoneNumberId
            );
            if (matchedClient) {
              targetClient = matchedClient;
              console.log(
                `✅ Found client with WhatsApp number: ${matchedClient.name} (${matchedClient.whatsappNumber})`
              );
              break;
            }
          }
        }

        if (!targetClient) {
          console.log(
            "⚠️ No client matched WhatsApp number, using first active client"
          );
          for (const user of allUsers) {
            if (user.role === "super_admin") continue;
            const userClients = await storage.getClients(user.id);
            const firstWithWhatsApp = userClients.find(
              (c) => c.isActive && (c.whatsappPhoneNumberId || c.whatsappNumber)
            );
            if (firstWithWhatsApp) {
              targetClient = firstWithWhatsApp;
              console.log(
                `✅ Using fallback client: ${firstWithWhatsApp.name}`
              );
              break;
            }
          }
        }

        if (!targetClient) {
          console.error("❌ No active clients found");
          return;
        }

        console.log(`Assigning to client: ${targetClient.name}`);
        lead = await storage.createLead({
          clientId: targetClient.id,
          firstName: from,
          lastName: "",
          email: `whatsapp_${from.replace(/\+/g, "")}@temp.com`,
          phone: from,
          company: "Unknown",
          source: "whatsapp-inbound",
          status: "new",
          auditResults: {
            type: "inbound-message",
            wins: ["Reached out via WhatsApp"],
            risks: [],
            timeline: "Unknown",
            estimatedROI: "Unknown",
            score: 50,
            topFinding: "Inbound WhatsApp contact",
          },
          qualificationScore: "0.0",
        });

        console.log("✅ New lead created:", lead.id);
      } else {
        console.log("✅ Existing lead found:", lead.firstName, lead.lastName);
      }

      // Step 2: Find or create conversation
      const allConversations = await storage.getAllConversations(lead.clientId);
      let conversation = allConversations.find(
        (c: any) => c.leadId === lead!.id
      );

      if (!conversation) {
        const newConv = await storage.createConversation({
          leadId: lead.id,
          clientId: lead.clientId,
          channel: "whatsapp",
          status: "active",
          isAiHandled: true,
          qualificationScore: "0.0",
          lastMessageAt: new Date(),
        });
        conversation = { ...newConv, lead } as any;
        console.log("✅ New conversation created:", conversation?.id);
      } else if (conversation.status === "closed") {
        console.log(
          "🔄 Reopening previously closed conversation:",
          conversation.id
        );
        await storage.updateConversation(conversation.id, {
          status: "active",
          isAiHandled: false,
          lastMessageAt: new Date(),
          reopenedAt: new Date(),
        } as any);

        if (lead.status === "spam") {
          const existingTags = Array.isArray(lead.tags) ? lead.tags : [];
          await storage.updateLead(lead.id, {
            status: "not-a-lead",
            tags: [
              ...existingTags.filter((t: string) => t !== "terminated"),
              "reopened",
            ],
          });
        }

        console.log("✅ Conversation reopened - flagged for human review");
        this.broadcastUpdate({
          type: "conversation_reopened",
          conversationId: conversation.id,
          lead: await storage.getLead(lead.id),
          message: "Previously terminated conversation has new activity",
        });
      } else {
        console.log("✅ Existing active conversation found:", conversation.id);
      }

      if (!conversation) {
        console.error("Failed to create conversation");
        return;
      }

      // Step 3: Record incoming message
      const savedMessage = await storage.createMessage({
        conversationId: conversation.id,
        content: message,
        sender: "lead",
        channel: "whatsapp",
        sentAt: new Date(timestamp * 1000),
        deliveredAt: new Date(),
        metadata: messageId ? { whatsappMessageId: messageId } : undefined,
      });

      console.log(
        `✅ Incoming message saved with metadata:`,
        savedMessage.metadata
      );

      await storage.markPreviousMessagesAsRead(conversation.id);
      await storage.incrementUnreadCount(conversation.id);
      await storage.updateConversation(conversation.id, {
        lastMessageAt: savedMessage.sentAt || new Date(),
      });

      // ✅ IMPORTANT: Broadcast lead message IMMEDIATELY before AI processing
      this.broadcastUpdate({
        type: "new_message",
        conversationId: conversation.id,
        message: {
          content: message,
          sender: "lead",
          sentAt: savedMessage.sentAt,
          id: savedMessage.id,
        },
      });

      // ✅ Small delay to ensure UI receives lead message first
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Step 4: AI Processing
      if (conversation.isAiHandled) {
        console.log("🤖 AI is handling - processing message...");

        this.broadcastUpdate({
          type: "typing_indicator",
          conversationId: conversation.id,
          isTyping: true,
          sender: "ai",
        });

        try {
          const messages = await storage.getMessages(conversation.id);

          // ============================================
          // ✅ STEP 1: QUALIFY LEAD & CHECK FOR SPAM
          // ============================================
          const qualification = await qualifyLead(lead, messages);
          console.log("AI Qualification:", qualification);

          // ============================================
          // ✅ FIX #2: SPAM TERMINATION
          // ============================================
          if (
            qualification.nextAction === "mark_as_not_a_lead" ||
            qualification.score < 0.1
          ) {
            console.log("🚫 Non-construction inquiry detected");

            const freshMessages = await storage.getMessages(conversation.id);

            const redirectCount = freshMessages.filter(
              (msg) =>
                msg.sender === "ai" &&
                (msg.content.toLowerCase().includes("construction company") ||
                  msg.content.toLowerCase().includes("building projects") ||
                  msg.content.toLowerCase().includes("wrong business") ||
                  msg.content.toLowerCase().includes("construction services"))
            ).length;

            console.log(`🔢 Redirect count: ${redirectCount}`);

            await storage.updateLead(lead.id, {
              status: "not-a-lead",
              qualificationScore: qualification.score.toString(),
              temperature: "cold",
              tags: ["not-construction", "irrelevant"],
            });

            // ✅ TERMINATE IMMEDIATELY after 2nd redirect
            if (redirectCount >= 2) {
              console.log(
                "⛔ Max redirects reached (2 total) - terminating conversation"
              );

              await storage.updateConversation(conversation.id, {
                qualificationScore: qualification.score.toString(),
                lastMessageAt: new Date(),
                isAiHandled: false,
                status: "closed",
              });

              await storage.updateLead(lead.id, {
                status: "spam",
                tags: [
                  "not-construction",
                  "irrelevant",
                  "terminated",
                  "wrong-number",
                ],
              });

              const updatedLead = await storage.getLead(lead.id);
              this.broadcastUpdate({
                type: "lead_updated",
                lead: updatedLead,
                conversationId: conversation.id,
              });

              const client = await storage.getClient(lead.clientId);
              const finalMessage = `Final notice: This is ${
                client?.name || "a construction company"
              }. We only handle construction and building projects. This conversation will not receive further responses.`;

              this.broadcastUpdate({
                type: "typing_indicator",
                conversationId: conversation.id,
                isTyping: false,
                sender: "ai",
              });

              const terminateResult = await whatsappService.sendTextMessage(
                from,
                finalMessage
              );

              await storage.createMessage({
                conversationId: conversation.id,
                content: finalMessage,
                sender: "ai",
                channel: "whatsapp",
                sentAt: new Date(),
                deliveredAt: new Date(),
                metadata: terminateResult.messageId
                  ? { whatsappMessageId: terminateResult.messageId }
                  : undefined,
              });

              console.log(
                "✅ Conversation terminated, no further AI responses"
              );
              return;
            }

            // First redirect - send warning
            const updatedLead = await storage.getLead(lead.id);
            this.broadcastUpdate({
              type: "lead_updated",
              lead: updatedLead,
              conversationId: conversation.id,
            });

            const client = await storage.getClient(lead.clientId);
            const aiResponse = await generateAIResponse(messages, lead, client);

            this.broadcastUpdate({
              type: "typing_indicator",
              conversationId: conversation.id,
              isTyping: false,
              sender: "ai",
            });

            const redirectResult = await whatsappService.sendTextMessage(
              from,
              aiResponse
            );

            await storage.createMessage({
              conversationId: conversation.id,
              content: aiResponse,
              sender: "ai",
              channel: "whatsapp",
              sentAt: new Date(),
              deliveredAt: new Date(),
              metadata: redirectResult.messageId
                ? { whatsappMessageId: redirectResult.messageId }
                : undefined,
            });

            this.broadcastUpdate({
              type: "new_message",
              conversationId: conversation.id,
              message: { content: aiResponse, sender: "ai" },
            });

            return; // Stop processing
          }

          // ============================================
          // ✅ STEP 2: UPDATE TEMPERATURE & LEAD STATUS
          // ============================================
          let temperature: "hot" | "warm" | "cold";
          if (qualification.score >= 0.7) {
            temperature = "hot";
          } else if (qualification.score >= 0.25) {
            temperature = "warm";
          } else {
            temperature = "cold";
          }

          await storage.updateConversation(conversation.id, {
            qualificationScore: qualification.score.toString(),
            lastMessageAt: new Date(),
          });

          await storage.updateLead(lead.id, {
            qualificationScore: qualification.score.toString(),
            temperature: temperature,
            status: qualification.score >= 0.7 ? "qualified" : lead.status,
          });

          console.log(`🌡️ Temperature: ${temperature}`);

          const updatedLead = await storage.getLead(lead.id);
          this.broadcastUpdate({
            type: "lead_updated",
            lead: updatedLead,
            conversationId: conversation.id,
          });

          // ============================================
          // 🆕 STEP 3: CHECK FOR ULTRA-HOT LEAD FIRST (PRIORITY!)
          // ============================================
          console.log(
            "🔍 Step 3: Checking for ultra-hot lead (PRIORITY CHECK)..."
          );

          const leadMessages = messages.filter((m: any) => m.sender === "lead");
          const leadMessageCount = leadMessages.length;

          // Detect hot signals
          const hasUrgency =
            /\b(asap|urgent|immediately|right away|as soon as possible|emergency|critical|right now)\b/i.test(
              leadMessages.map((m: any) => m.content).join(" ")
            ) ||
            /\b(today|tomorrow|this week|next week)\b/i.test(
              leadMessages.map((m: any) => m.content).join(" ")
            );

          const hasDecisionMaker =
            /\b(i'm the|i am the|ceo|owner|president|director|founder|i decide|my company|my business|i run)\b/i.test(
              leadMessages.map((m: any) => m.content).join(" ")
            );

          const hasMeetingRequest = leadMessages.some((m: any) =>
            /\b(can we (meet|discuss|talk)|let's meet|need to meet|want to meet|should we meet|schedule|book|appointment|site visit)\b/i.test(
              m.content
            )
          );

          const hotSignals = [
            hasUrgency,
            hasDecisionMaker,
            hasMeetingRequest,
          ].filter(Boolean).length;

          console.log(`🔥 Ultra-Hot Lead Analysis:`);
          console.log(`   Score: ${qualification.score.toFixed(2)}`);
          console.log(`   Signals: ${hotSignals}/3`);
          console.log(`   - Urgency: ${hasUrgency}`);
          console.log(`   - Decision Maker: ${hasDecisionMaker}`);
          console.log(`   - Meeting Request: ${hasMeetingRequest}`);
          console.log(`   - Message Count: ${leadMessageCount}`);

          const isUltraHot =
            (qualification.score >= 0.88 && hotSignals >= 2) ||
            (qualification.score >= 0.85 &&
              hotSignals >= 2 &&
              leadMessageCount >= 3);

          console.log(`🔥 Ultra-Hot Decision Logic:`);
          console.log(
            `   Path 1 (Extreme): ${
              qualification.score >= 0.88 && hotSignals >= 2
            } (score ${qualification.score.toFixed(
              2
            )} >= 0.88, signals ${hotSignals} >= 2)`
          );
          console.log(
            `   Path 2 (Conservative): ${
              qualification.score >= 0.85 &&
              hotSignals >= 2 &&
              leadMessageCount >= 3
            } (score ${qualification.score.toFixed(
              2
            )} >= 0.85, signals ${hotSignals} >= 2, messages ${leadMessageCount} >= 3)`
          );
          console.log(`   Final: isUltraHot = ${isUltraHot}`);

          if (isUltraHot) {
            console.log(
              `🔥🔥 ULTRA-HOT LEAD CONFIRMED - Triggering immediate handoff`
            );
            console.log(`   Bypassing booking flow for human attention`);

            // ============================================
            // ✅ NEW: EXTRACT LEAD DETAILS IMMEDIATELY (CRITICAL FIX!)
            // ============================================
            console.log(
              `\n📋 ========== EXTRACTING ULTRA-HOT LEAD DETAILS ==========`
            );
            console.log(
              `   Current lead name: ${lead.firstName} ${lead.lastName}`
            );
            console.log(`   Current lead email: ${lead.email}`);

            const extractedDetails = await extractLeadDetails(messages);
            console.log(`📋 Extraction Result:`, extractedDetails);

            if (extractedDetails.confidence > 0.7) {
              const updates: any = {};

              // ✅ Extract name (only if current name is placeholder)
              if (
                extractedDetails.name &&
                (lead.firstName === lead.phone ||
                  lead.firstName!.startsWith("639") ||
                  lead.firstName!.startsWith("+") ||
                  lead.firstName === "Unknown" ||
                  lead.firstName === from)
              ) {
                const nameParts = extractedDetails.name.split(" ");
                updates.firstName = nameParts[0];
                updates.lastName = nameParts.slice(1).join(" ") || "";
                console.log(`   ✅ Extracted name: ${extractedDetails.name}`);
                console.log(`      → firstName: ${updates.firstName}`);
                console.log(`      → lastName: ${updates.lastName}`);
              } else {
                console.log(
                  `   ⚠️ Name not extracted (current name is valid or no name found)`
                );
              }

              // ✅ Extract email (only if current email is placeholder)
              if (
                extractedDetails.email &&
                (lead.email!.includes("whatsapp_") ||
                  lead.email!.includes("@temp.com"))
              ) {
                updates.email = extractedDetails.email;
                console.log(`   ✅ Extracted email: ${extractedDetails.email}`);
              } else {
                console.log(
                  `   ⚠️ Email not extracted (current email is valid or no email found)`
                );
              }

              // ✅ Extract company from conversation
              const companyMatch = leadMessages
                .map((m: any) => m.content)
                .join(" ")
                .match(
                  /\b(CEO|owner|president|director|founder)\s+(?:of|at)\s+([A-Z][a-zA-Z0-9\s&]+)/i
                );

              if (
                companyMatch &&
                companyMatch[2] &&
                lead.company === "Unknown"
              ) {
                updates.company = companyMatch[2].trim();
                console.log(`   ✅ Extracted company: ${updates.company}`);
              }

              // ✅ Apply updates to database
              if (Object.keys(updates).length > 0) {
                console.log(`\n💾 Updating lead ${lead.id} with:`, updates);
                await storage.updateLead(lead.id, updates);

                // ✅ CRITICAL: Reload lead from database to get updated values
                lead = (await storage.getLead(lead.id))!;

                console.log(`   ✅ Lead updated successfully!`);
                console.log(`   New name: ${lead.firstName} ${lead.lastName}`);
                console.log(`   New email: ${lead.email}`);
                console.log(`   New company: ${lead.company}`);
              } else {
                console.log(
                  `   ℹ️ No updates needed (all details already present)`
                );
              }
            } else {
              console.log(
                `   ⚠️ Extraction confidence too low (${extractedDetails.confidence.toFixed(
                  2
                )}), skipping update`
              );
            }

            console.log(
              `==========================================================\n`
            );

            // ============================================
            // NOW PROCEED WITH HANDOFF (with updated lead details)
            // ============================================

            await storage.updateConversation(conversation.id, {
              isAiHandled: false,
              humanTakeoverAt: new Date(),
            });

            // 🆕 DEBUG: Verify update was saved
            const freshConversation = await storage.getConversation(
              conversation.id
            );
            console.log(`✅ DB Update Confirmed:`, {
              conversationId: conversation.id,
              isAiHandled: freshConversation?.isAiHandled,
              humanTakeoverAt: freshConversation?.humanTakeoverAt,
            });

            // ✅ Get FRESH updated lead for broadcasts and notifications
            const updatedLead = await storage.getLead(lead.id);

            // Event 1: Hot lead alert
            this.broadcastUpdate({
              type: "hot_lead_alert",
              conversationId: conversation.id,
              conversation: {
                id: conversation.id,
                isAiHandled: false,
                humanTakeoverAt: new Date(),
                leadId: lead.id,
                clientId: lead.clientId,
                lead: updatedLead, // ✅ Use fresh updated lead
                qualificationScore: qualification.score.toString(),
              },
              qualification,
            });

            console.log(
              `📡 Broadcasted hot_lead_alert for conversation ${conversation.id}`
            );

            // Event 2: Explicit conversation update
            this.broadcastUpdate({
              type: "conversation_updated",
              conversationId: conversation.id,
              updates: {
                isAiHandled: false,
                humanTakeoverAt: new Date(),
              },
            });

            console.log(
              `📡 Broadcasted conversation_updated for conversation ${conversation.id}`
            );

            // Event 3: Lead updated (for sidebar sync)
            this.broadcastUpdate({
              type: "lead_updated",
              conversationId: conversation.id,
              lead: updatedLead, // ✅ Use fresh updated lead
            });

            console.log(
              `📡 Broadcasted lead_updated for conversation ${conversation.id}`
            );

            // ✅ NOW SEND NOTIFICATION (with updated lead details)
            console.log(
              `\n📧 ========== SENDING HOT LEAD NOTIFICATION ==========`
            );

            const client = await storage.getClient(lead.clientId);
            console.log(
              `   Client found: ${client ? client.name : "NOT FOUND"}`
            );
            console.log(`   Client userId: ${client?.userId || "MISSING"}`);

            if (!client) {
              console.error(
                `❌ CRITICAL: Client not found for clientId: ${lead.clientId}`
              );
              console.error(`   Cannot send notification without client!`);
            } else if (!client.userId) {
              console.error(
                `❌ CRITICAL: Client ${client.name} has no userId!`
              );
              console.error(`   Client data:`, JSON.stringify(client, null, 2));
            } else {
              console.log(
                `✅ Client and userId confirmed - proceeding with notification`
              );
              console.log(
                `   Calling notificationService.sendHotLeadAlert()...`
              );

              try {
                await notificationService.sendHotLeadAlert({
                  userId: client.userId,
                  lead: {
                    id: updatedLead?.id || lead.id,
                    firstName: updatedLead?.firstName || lead.firstName || "", // ✅ Will now have "Michael"
                    lastName: updatedLead?.lastName || lead.lastName || "", // ✅ Will now have "Chen"
                    email: updatedLead?.email || lead.email || "",
                    phone: updatedLead?.phone || lead.phone || "",
                    company: updatedLead?.company || lead.company || "", // ✅ Will now have "TechCorp"
                    qualificationScore:
                      updatedLead?.qualificationScore || "0.8",
                    temperature: updatedLead?.temperature || "hot",
                  },
                  conversation: {
                    id: conversation.id,
                    qualificationScore: qualification.score.toString(),
                  },
                  qualification: {
                    score: qualification.score,
                    reasoning: qualification.reasoning,
                  },
                });

                console.log(`✅ Hot lead notification sent successfully!`);
              } catch (notificationError: any) {
                console.error(`❌ NOTIFICATION FAILED:`, notificationError);
                console.error(`   Error message:`, notificationError.message);
                console.error(`   Error stack:`, notificationError.stack);
              }
            }

            console.log(`================================================\n`);

            const handoffMessage =
              "Thanks for sharing those details! You've been identified as a priority lead. One of our senior team members will reach out to you shortly to discuss your project in detail. 🏗️";

            this.broadcastUpdate({
              type: "typing_indicator",
              conversationId: conversation.id,
              isTyping: false,
              sender: "ai",
            });

            await new Promise((resolve) => setTimeout(resolve, 200));

            const handoffResult = await whatsappService.sendTextMessage(
              from,
              handoffMessage
            );

            const handoffMsg = await storage.createMessage({
              conversationId: conversation.id,
              content: handoffMessage,
              sender: "ai",
              channel: "whatsapp",
              sentAt: new Date(),
              deliveredAt: new Date(),
              metadata: handoffResult.messageId
                ? { whatsappMessageId: handoffResult.messageId }
                : undefined,
            });

            this.broadcastUpdate({
              type: "new_message",
              conversationId: conversation.id,
              message: {
                content: handoffMessage,
                sender: "ai",
                sentAt: handoffMsg.sentAt,
                id: handoffMsg.id,
              },
            });

            console.log(
              "✅ Ultra-hot lead handed off to human - STOPPING ALL AI PROCESSING"
            );
            return; // ✅ CRITICAL: Stop all further processing
          }

          // ============================================
          // ✅ STEP 4: CHECK BOOKING INTENT FIRST (Only if NOT ultra-hot)
          // ============================================
          console.log("🔍 Step 4: Checking booking intent (PRIORITY)...");
          console.log("=".repeat(60));
          const freshMessages = await storage.getMessages(conversation.id);
          const bookingIntent = await detectBookingIntent(freshMessages, lead);

          console.log("=".repeat(60));
          console.log("📅 BOOKING INTENT DETECTION RESULT:");
          console.log("=".repeat(60));
          console.log("✓ Wants to book:", bookingIntent.wantsToBook);
          console.log("✓ Is confirmed:", bookingIntent.isConfirmed);
          console.log("✓ Confidence:", bookingIntent.confidence);
          console.log(
            "✓ Proposed date:",
            bookingIntent.proposedDateTime?.date || "NOT SET"
          );
          console.log(
            "✓ Proposed time:",
            bookingIntent.proposedDateTime?.time || "NOT SET"
          );
          console.log("✓ Location:", bookingIntent.location || "NOT SET");
          console.log("=".repeat(60));

          // ============================================
          // 🆕 STEP 4.5: SAFETY NET - Check Booking State
          // ============================================
          console.log(
            "🔍 Step 4.5: Safety net - checking booking state from context..."
          );

          const context = extractConversationContext(freshMessages);
          const bookingStateFromContext = detectBookingState(
            freshMessages,
            context
          );

          console.log(
            `📋 Booking State from Context: ${bookingStateFromContext.state}`
          );
          console.log(
            `📋 Collected Info:`,
            bookingStateFromContext.collectedInfo
          );

          // ✅ SAFETY NET: If we have ALL details, create booking even if detectBookingIntent is conservative
          if (bookingStateFromContext.state === "ready_to_book") {
            console.log(
              "🎯 SAFETY NET TRIGGERED: All booking details present, forcing booking creation"
            );

            // Override booking intent to force creation
            bookingIntent.wantsToBook = true;
            bookingIntent.isConfirmed = true;
            bookingIntent.confidence = 0.95;

            // Use values from bookingStateFromContext
            if (
              !bookingIntent.proposedDateTime?.date ||
              !bookingIntent.proposedDateTime?.time
            ) {
              bookingIntent.proposedDateTime = {
                date:
                  bookingStateFromContext.collectedInfo.date ||
                  bookingIntent.proposedDateTime?.date,
                time:
                  bookingStateFromContext.collectedInfo.time ||
                  bookingIntent.proposedDateTime?.time,
                isFlexible: false,
              };
            }

            // Extract location from messages if not set
            if (!bookingIntent.location || bookingIntent.location === "TBD") {
              const extractedDetails = await extractLeadDetails(freshMessages);
              if (
                extractedDetails.address &&
                extractedDetails.confidence > 0.7
              ) {
                bookingIntent.location = extractedDetails.address;
                console.log(
                  `✅ Using extracted address: ${extractedDetails.address}`
                );
              }
            }

            console.log("✅ Booking intent OVERRIDDEN by safety net:");
            console.log(`   - wantsToBook: true`);
            console.log(`   - isConfirmed: true`);
            console.log(`   - confidence: 0.95`);
            console.log(`   - date: ${bookingIntent.proposedDateTime?.date}`);
            console.log(`   - time: ${bookingIntent.proposedDateTime?.time}`);
            console.log(`   - location: ${bookingIntent.location}`);
          }

          // ✅ Check if lead is actively in booking workflow
          const isActivelyBooking =
            bookingIntent.wantsToBook &&
            (bookingIntent.proposedDateTime?.date ||
              bookingIntent.proposedDateTime?.time ||
              bookingIntent.confidence > 0.5);

          // ✅ Check if AI recently asked booking-related questions
          const recentMessages = messages.slice(-3);
          const inBookingFlow = recentMessages.some(
            (m: any) =>
              m.sender === "ai" &&
              /\b(schedule|site visit|meet|available|what time|which day|when would|book|appointment|calendar)\b/i.test(
                m.content
              )
          );

          console.log(`📋 Actively booking: ${isActivelyBooking}`);
          console.log(`📋 In booking flow: ${inBookingFlow}`);

          // ============================================
          // ✅ IF BOOKING CONFIRMED, CREATE IT IMMEDIATELY
          // ============================================
          if (
            bookingIntent.wantsToBook &&
            bookingIntent.isConfirmed &&
            bookingIntent.confidence > BOOKING_CONFIDENCE_THRESHOLD
          ) {
            console.log(
              "✅ Confirmed booking intent - prioritizing booking creation"
            );

            // Extract lead details from conversation
            const previousLeadState = {
              hadName:
                lead.firstName &&
                lead.firstName !== lead.phone &&
                !lead.firstName.startsWith("639") &&
                !lead.firstName.startsWith("+") &&
                !lead.firstName.toLowerCase().includes("unknown") &&
                lead.firstName.length > 2,
              hadEmail:
                lead.email &&
                !lead.email.includes("whatsapp_") &&
                !lead.email.includes("@temp.com"),
              firstName: lead.firstName,
            };

            console.log("📸 Previous lead state:", previousLeadState);

            // Extract lead details from conversation
            const extractedDetails = await extractLeadDetails(messages);
            console.log("📋 Extracted details:", extractedDetails);

            if (extractedDetails.confidence > 0.7) {
              const updates: any = {};
              if (
                extractedDetails.name &&
                (lead.firstName === lead.phone ||
                  lead.firstName!.startsWith("639") ||
                  lead.firstName!.startsWith("+") ||
                  lead.firstName === "Unknown")
              ) {
                const nameParts = extractedDetails.name.split(" ");
                updates.firstName = nameParts[0];
                updates.lastName = nameParts.slice(1).join(" ") || "";
                console.log(`✅ Extracted name: ${extractedDetails.name}`);
              }

              if (
                extractedDetails.email &&
                (lead.email!.includes("whatsapp_") ||
                  lead.email!.includes("@temp.com"))
              ) {
                updates.email = extractedDetails.email;
                console.log(`✅ Extracted email: ${extractedDetails.email}`);
              }

              if (Object.keys(updates).length > 0) {
                await storage.updateLead(lead.id, updates);
                lead = (await storage.getLead(lead.id))!;
                console.log(`✅ Updated lead with extracted details`);
              }
            }

            if (
              extractedDetails.address &&
              extractedDetails.confidence > 0.7 &&
              (!bookingIntent.location ||
                bookingIntent.location === "TBD" ||
                bookingIntent.location.length < 20 ||
                bookingIntent.location === "British Columbia" ||
                bookingIntent.location === "BC")
            ) {
              bookingIntent.location = extractedDetails.address;
              console.log(
                `✅ Using extracted address: ${extractedDetails.address}`
              );
            }

            // Validate booking details
            const detailsCheck = validateBookingDetails(bookingIntent, lead);
            if (detailsCheck.missingDetails.length > 0) {
              const refusalCheck = detectRefusal(freshMessages);
              // ✅ Only act on refusal if the LATEST message is a refusal
              if (
                refusalCheck.hasRefusal &&
                refusalCheck.lastMessageIsRefusal
              ) {
                console.log(
                  `🚫 REFUSAL DETECTED: Count = ${refusalCheck.refusalCount}`
                );
                console.log(
                  `   Last message IS a refusal - triggering refusal handling`
                );

                if (refusalCheck.refusalCount >= 2) {
                  // ============================================
                  // SECOND REFUSAL - GRACEFUL HANDOFF
                  // ============================================
                  console.log(
                    `⛔ MAX REFUSALS REACHED (2) - Handing off to human`
                  );

                  // ✅ NEW: UPGRADE SCORE TO 0.85 (ULTRA-HOT)
                  const ultraHotScore = 0.85;
                  console.log(
                    `🔥 UPGRADING LEAD TO ULTRA-HOT (${ultraHotScore}) - CUSTOMER REFUSED TWICE`
                  );

                  await storage.updateLead(lead.id, {
                    qualificationScore: ultraHotScore.toString(),
                    temperature: "hot",
                    status: "qualified",
                    tags: [
                      ...(Array.isArray(lead.tags) ? lead.tags : []),
                      "requires-phone-followup",
                    ],
                  });

                  await storage.updateConversation(conversation.id, {
                    isAiHandled: false,
                    humanTakeoverAt: new Date(),
                    qualificationScore: ultraHotScore.toString(),
                  });

                  // ✅ Get updated lead
                  const updatedLead = await storage.getLead(lead.id);

                  // ✅ NEW: SEND HOT LEAD NOTIFICATION
                  const client = await storage.getClient(lead.clientId);

                  if (client && client.userId) {
                    console.log(
                      `\n📧 ========== SENDING HOT LEAD NOTIFICATION (MAIN FLOW) ==========`
                    );

                    try {
                      const leadText = freshMessages
                        .filter((m: any) => m.sender === "lead")
                        .map((m: any) => m.content)
                        .join(" ");

                      let projectType = "Construction project";
                      if (/bathroom/i.test(leadText))
                        projectType = "Bathroom renovation";
                      else if (/kitchen/i.test(leadText))
                        projectType = "Kitchen renovation";
                      else if (/deck/i.test(leadText))
                        projectType = "Deck construction";

                      const budgetMatch = leadText.match(
                        /(\$?\d+[\d,]*)\s*(k|thousand|million|m)?\b/i
                      );
                      const budget = budgetMatch ? budgetMatch[0] : "TBD";

                      const locationMatch = leadText.match(
                        /\b(Surrey|Vancouver|Burnaby|Richmond|Coquitlam)\b/i
                      );
                      const location = locationMatch ? locationMatch[0] : "BC";

                      await notificationService.sendHotLeadAlert({
                        userId: client.userId,
                        lead: {
                          id: updatedLead?.id || lead.id,
                          firstName:
                            updatedLead?.firstName || lead.firstName || "",
                          lastName:
                            updatedLead?.lastName || lead.lastName || "",
                          email: updatedLead?.email || lead.email || "",
                          phone: updatedLead?.phone || lead.phone || "",
                          company: updatedLead?.company || lead.company || "",
                          qualificationScore: ultraHotScore.toString(),
                          temperature: "hot",
                        },
                        conversation: {
                          id: conversation.id,
                          qualificationScore: ultraHotScore.toString(),
                        },
                        qualification: {
                          score: ultraHotScore,
                          reasoning: `🔥 ULTRA-HOT: ${projectType} in ${location}. Budget: ${budget}. Customer requested site visit for ${
                            bookingIntent.proposedDateTime?.date || "TBD"
                          } at ${
                            bookingIntent.proposedDateTime?.time || "TBD"
                          } but prefers phone coordination. Immediate response required.`,
                        },
                      });

                      console.log(
                        `✅ Hot lead notification sent successfully!`
                      );
                    } catch (notificationError: any) {
                      console.error(
                        `❌ NOTIFICATION FAILED:`,
                        notificationError.message
                      );
                    }
                  }

                  // ✅ BROADCAST WEBSOCKET EVENTS
                  this.broadcastUpdate({
                    type: "hot_lead_alert",
                    conversationId: conversation.id,
                    conversation: {
                      id: conversation.id,
                      isAiHandled: false,
                      humanTakeoverAt: new Date(),
                      leadId: lead.id,
                      clientId: lead.clientId,
                      lead: updatedLead,
                      qualificationScore: ultraHotScore.toString(),
                    },
                    qualification: {
                      score: ultraHotScore,
                      reasoning: `Customer refused to provide booking details twice - requires immediate phone follow-up`,
                    },
                  });

                  this.broadcastUpdate({
                    type: "conversation_updated",
                    conversationId: conversation.id,
                    updates: {
                      isAiHandled: false,
                      humanTakeoverAt: new Date(),
                      qualificationScore: ultraHotScore.toString(),
                    },
                  });

                  this.broadcastUpdate({
                    type: "lead_updated",
                    conversationId: conversation.id,
                    lead: updatedLead,
                  });

                  // ✅ NEW: Use correct date/time (no hardcoded values, no specific time commitment)
                  const currentDate =
                    bookingIntent.proposedDateTime?.date || "your";
                  const currentTime =
                    bookingIntent.proposedDateTime?.time || "";
                  const timeText = currentTime ? ` at ${currentTime}` : "";

                  const handoffMessage = `No problem! I'll have our team reach out to you directly at this number to coordinate the details. They'll be in touch shortly to confirm your ${currentDate}${timeText} site visit. 📞`;

                  this.broadcastUpdate({
                    type: "typing_indicator",
                    conversationId: conversation.id,
                    isTyping: false,
                    sender: "ai",
                  });

                  await whatsappService.sendTextMessage(from, handoffMessage);

                  await storage.createMessage({
                    conversationId: conversation.id,
                    content: handoffMessage,
                    sender: "ai",
                    channel: "whatsapp",
                    sentAt: new Date(),
                    deliveredAt: new Date(),
                  });

                  this.broadcastUpdate({
                    type: "new_message",
                    conversationId: conversation.id,
                    message: { content: handoffMessage, sender: "ai" },
                  });

                  console.log(
                    "✅ Refusal handoff complete - AI stopped responding"
                  );
                  return; // ✅ STOP - Customer refused twice
                } else if (refusalCheck.refusalCount === 1) {
                  // ============================================
                  // FIRST REFUSAL - GENTLE NUDGE
                  // ============================================
                  console.log(`⚠️ First refusal - sending gentle nudge`);

                  const currentDate =
                    bookingIntent.proposedDateTime?.date || "the meeting";
                  const currentTime =
                    bookingIntent.proposedDateTime?.time ||
                    "the time you specified";

                  const gentleNudge = `I understand! However, we do need at least your name and email to send you the calendar invite for ${currentDate} at ${currentTime}. The address can be confirmed when our team arrives. Could you share your name and email?`;

                  this.broadcastUpdate({
                    type: "typing_indicator",
                    conversationId: conversation.id,
                    isTyping: false,
                    sender: "ai",
                  });

                  await whatsappService.sendTextMessage(from, gentleNudge);

                  await storage.createMessage({
                    conversationId: conversation.id,
                    content: gentleNudge,
                    sender: "ai",
                    channel: "whatsapp",
                    sentAt: new Date(),
                    deliveredAt: new Date(),
                  });

                  this.broadcastUpdate({
                    type: "new_message",
                    conversationId: conversation.id,
                    message: { content: gentleNudge, sender: "ai" },
                  });

                  console.log("✅ Gentle nudge sent - giving one more chance");
                  return; // Wait for response
                }
              }
              // Detect what was JUST provided in the last message
              const lastLeadMessage =
                freshMessages
                  .filter((m) => m.sender === "lead")
                  .slice(-1)[0]
                  ?.content.toLowerCase() || "";

              console.log(
                `🔍 Last lead message for detection: "${lastLeadMessage}"`
              );
              console.log(`🔍 Message length: ${lastLeadMessage.length}`);

              // Check regex patterns
              const namePattern = /\b(name is|i'm|i am|my name|call me)\b/i;
              const emailPattern = /@/;
              const addressPattern =
                /\d+\s+\w+\s+(st|ave|rd|street|avenue|road)/i;

              const namePatternMatches = namePattern.test(lastLeadMessage);
              const emailPatternMatches = emailPattern.test(lastLeadMessage);
              const addressPatternMatches =
                addressPattern.test(lastLeadMessage) ||
                /address/i.test(lastLeadMessage);

              console.log(`🔍 Pattern matches:`, {
                namePattern: namePatternMatches,
                emailPattern: emailPatternMatches,
                addressPattern: addressPatternMatches,
              });

              // Check if name was JUST added (wasn't there before, is there now)
              const justProvidedName =
                !previousLeadState.hadName &&
                detailsCheck.hasName &&
                namePatternMatches;

              // Check if email was JUST added
              const justProvidedEmail =
                !previousLeadState.hadEmail &&
                detailsCheck.hasEmail &&
                emailPatternMatches;

              // Check if address was JUST provided (address is never pre-filled, so simpler check)
              const justProvidedAddress =
                detailsCheck.hasAddress && addressPatternMatches;

              console.log("🔍 Detection:", {
                justProvidedName,
                justProvidedEmail,
                justProvidedAddress,
                previousHadName: previousLeadState.hadName,
                currentHasName: detailsCheck.hasName,
                previousHadEmail: previousLeadState.hadEmail,
                currentHasEmail: detailsCheck.hasEmail,
              });

              console.log("🔍 Detailed name check:", {
                condition1_previousDidNotHaveName: !previousLeadState.hadName,
                condition2_currentHasName: detailsCheck.hasName,
                condition3_messageContainsName: namePatternMatches,
                result: justProvidedName,
              });

              // Build acknowledgment
              let acknowledgment = "";
              const providedItems: string[] = [];

              if (justProvidedName) providedItems.push("name");
              if (justProvidedEmail) providedItems.push("email");
              if (justProvidedAddress) providedItems.push("address");

              console.log("📝 Provided items:", providedItems);

              if (providedItems.length > 0) {
                // Get the newly provided first name
                const firstName =
                  lead.firstName &&
                  lead.firstName !== lead.phone &&
                  !lead.firstName.startsWith("639") &&
                  !lead.firstName.startsWith("+") &&
                  lead.firstName.length > 1
                    ? lead.firstName
                    : null;

                if (justProvidedName && firstName) {
                  // They just told us their name - use it!
                  acknowledgment = `Thanks ${firstName}! `;
                  console.log(`✅ Acknowledging name: "${firstName}"`);
                } else if (justProvidedEmail) {
                  // They provided email (and we already had name)
                  acknowledgment = `Perfect! `;
                  console.log(`✅ Acknowledging email`);
                } else if (justProvidedAddress) {
                  // They provided address last
                  acknowledgment = `Great! `;
                  console.log(`✅ Acknowledging address`);
                } else {
                  acknowledgment = `Perfect! `;
                }
              } else {
                // First ask (nothing provided yet)
                acknowledgment = "";
              }

              // ============================================
              // Check for time change
              // ============================================
              const timeChange = detectTimeChange(freshMessages);
              let timeAcknowledgment = "";
              if (timeChange.hasChange && timeChange.newTime) {
                timeAcknowledgment = `No problem! I've updated it to ${timeChange.newTime}. `;
                console.log(
                  `✅ Acknowledging time change: ${timeChange.originalTime} → ${timeChange.newTime}`
                );
              }

              const currentTime =
                bookingIntent.proposedDateTime?.time || "the specified time";
              const currentDate =
                bookingIntent.proposedDateTime?.date || "the meeting";

              // ============================================
              // 🆕 ENHANCED: Natural, conversational request
              // ============================================
              const remainingCount = detailsCheck.missingDetails.length;

              let requestIntro = "";
              if (acknowledgment || timeAcknowledgment) {
                requestIntro = `${timeAcknowledgment}${acknowledgment}`;
              } else {
                requestIntro = "Perfect! ";
              }

              let requestBody = "";
              if (remainingCount === 1) {
                // Only 1 item left - simpler phrasing
                const lastItem = detailsCheck.missingDetails[0];
                requestBody = `To finalize your booking for ${currentDate} at ${currentTime}, I just need your ${lastItem}.`;
              } else if (remainingCount === 2) {
                // 2 items left
                requestBody = `To complete the booking for ${currentDate} at ${currentTime}, I need:\n\n${detailsCheck.missingDetails
                  .map(
                    (d, i) =>
                      `${i + 1}. ${d.charAt(0).toUpperCase() + d.slice(1)}`
                  )
                  .join("\n")}`;
              } else {
                // 3 items (initial ask)
                requestBody = `Before I confirm the booking for ${currentDate} at ${currentTime}, I need a few more details:\n\n${detailsCheck.missingDetails
                  .map(
                    (d, i) =>
                      `${i + 1}. ${d.charAt(0).toUpperCase() + d.slice(1)}`
                  )
                  .join("\n")}`;
              }

              const detailsRequest = `${requestIntro}${requestBody} 📋`;

              // Send the request
              await whatsappService.sendTextMessage(from, detailsRequest);
              await storage.createMessage({
                conversationId: conversation.id,
                content: detailsRequest,
                sender: "ai",
                channel: "whatsapp",
                sentAt: new Date(),
                deliveredAt: new Date(),
              });

              this.broadcastUpdate({
                type: "new_message",
                conversationId: conversation.id,
                message: { content: detailsRequest, sender: "ai" },
              });

              return; // Wait for details
            }

            // ============================================
            // ALL DETAILS PRESENT - CREATE BOOKING
            // ============================================
            console.log("✅ All details present, creating booking...");

            let scheduledFor: Date | null = null;
            if (bookingIntent.proposedDateTime?.date) {
              const dateStr = bookingIntent.proposedDateTime.date;
              const timeStr = bookingIntent.proposedDateTime.time || "10:00 AM";
              scheduledFor = parseDateFromNaturalLanguage(dateStr, timeStr);

              if (!scheduledFor || scheduledFor < new Date()) {
                console.error("❌ Failed to parse date or date is in the past");
                return;
              }
              console.log(
                `✅ Final parsed date: ${scheduledFor.toISOString()}`
              );
            } else {
              console.error("❌ Date missing after validation");
              return;
            }

            try {
              const existingPendingBooking =
                await storage.findPendingBookingByLeadId(lead.id);

              const bookingDetails: InsertBooking = {
                leadId: lead.id,
                clientId: lead.clientId,
                title: `${
                  bookingIntent.meetingType === "site-visit"
                    ? "Site Visit"
                    : "Consultation"
                } - ${lead.firstName} ${lead.lastName}`,
                scheduledFor,
                scheduledAt: scheduledFor,
                duration: 60,
                status: "pending_approval",
                attendeeEmail: lead.email,
                attendeeName: `${lead.firstName} ${lead.lastName}`,
                attendeePhone: lead.phone,
                meetingType: bookingIntent.meetingType || "consultation",
                location: bookingIntent.location || "TBD",
                notes: `AI-proposed booking. Confidence: ${(
                  bookingIntent.confidence * 100
                ).toFixed(0)}%. Lead score: ${qualification.score.toFixed(2)}.`,
                proposedBy: "ai",
                aiConfidence: bookingIntent.confidence.toString(),
              };
              let savedBooking;
              let eventType = "booking_approval_needed";

              if (existingPendingBooking) {
                const { status, ...updateDetails } = bookingDetails;
                savedBooking = await storage.updateBooking(
                  existingPendingBooking.id,
                  updateDetails
                );
                eventType = "booking_updated";
              } else {
                savedBooking = await storage.createBooking(bookingDetails);
              }

              console.log("✅ Booking saved:", savedBooking.id);

              // ✅ NEW: UPGRADE TO ULTRA-HOT (0.85) AND HAND OFF TO HUMAN
              const ultraHotScore = 0.85;

              console.log(
                `🔥 UPGRADING LEAD TO ULTRA-HOT (${ultraHotScore}) - BOOKING CONFIRMED`
              );

              await storage.updateLead(lead.id, {
                qualificationScore: ultraHotScore.toString(),
                temperature: "hot",
                status: "qualified",
              });

              await storage.updateConversation(conversation.id, {
                qualificationScore: ultraHotScore.toString(),
                isAiHandled: false, // ✅ CRITICAL: Hand off to human
                humanTakeoverAt: new Date(),
              });

              console.log(
                `✅ Conversation ${conversation.id} handed off to human`
              );

              // Get updated lead
              const updatedLead = await storage.getLead(lead.id);

              // ============================================
              // ✅ BROADCAST WEBSOCKET EVENTS
              // ============================================

              // 1. Booking event
              this.broadcastUpdate({
                type: eventType,
                booking: {
                  ...savedBooking,
                  lead: {
                    firstName: lead.firstName,
                    lastName: lead.lastName,
                    company: lead.company,
                    phone: lead.phone,
                  },
                },
              });

              // 2. Conversation handoff
              this.broadcastUpdate({
                type: "conversation_updated",
                conversationId: conversation.id,
                updates: {
                  isAiHandled: false,
                  humanTakeoverAt: new Date(),
                  qualificationScore: ultraHotScore.toString(),
                },
              });

              // 3. Lead updated
              this.broadcastUpdate({
                type: "lead_updated",
                conversationId: conversation.id,
                lead: updatedLead,
              });

              // 4. Hot lead alert (since score is now 0.85)
              this.broadcastUpdate({
                type: "hot_lead_alert",
                conversationId: conversation.id,
                conversation: {
                  id: conversation.id,
                  isAiHandled: false,
                  humanTakeoverAt: new Date(),
                  leadId: lead.id,
                  clientId: lead.clientId,
                  lead: updatedLead,
                  qualificationScore: ultraHotScore.toString(),
                },
                qualification: {
                  score: ultraHotScore,
                  reasoning: `Booking confirmed - Lead upgraded to ultra-hot (${(
                    ultraHotScore * 100
                  ).toFixed(0)}%)`,
                },
              });

              console.log(
                `📡 Broadcasted hot_lead_alert for booking-confirmed lead`
              );

              // ============================================
              // ✅ SEND DUAL NOTIFICATIONS TO USER
              // ============================================

              const client = await storage.getClient(lead.clientId);

              if (client && client.userId) {
                console.log(
                  `\n📧 ========== SENDING DUAL NOTIFICATIONS ==========`
                );
                console.log(`   User: ${client.userId}`);
                console.log(`   Lead: ${lead.firstName} ${lead.lastName}`);
                console.log(`   Reason: Booking proposal + Ultra-hot upgrade`);

                // ✅ NOTIFICATION 1: HOT LEAD ALERT (MUST BE FIRST!)
                console.log(`\n🔥 [1/2] Sending HOT LEAD alert...`);

                try {
                  // ✅ CRITICAL: Await this call!
                  // ✅ Extract project details for booking notification too
                  const leadText = messages
                    .filter((m: any) => m.sender === "lead")
                    .map((m: any) => m.content)
                    .join(" ");

                  let projectType = "Construction project";
                  if (/warehouse/i.test(leadText))
                    projectType = "Warehouse construction";
                  else if (/kitchen/i.test(leadText))
                    projectType = "Kitchen renovation";
                  else if (/deck/i.test(leadText))
                    projectType = "Deck construction";
                  else if (/basement/i.test(leadText))
                    projectType = "Basement finishing";
                  else if (/bathroom/i.test(leadText))
                    projectType = "Bathroom renovation";
                  else if (/commercial/i.test(leadText))
                    projectType = "Commercial building";
                  else if (lead.company !== "Unknown")
                    projectType = `${lead.company} project`;

                  const budgetMatch = leadText.match(
                    /(\d+[\d,]*)\s*(million|m|k|thousand)/i
                  );
                  const budget = budgetMatch
                    ? `${budgetMatch[1]}${budgetMatch[2]
                        .charAt(0)
                        .toUpperCase()}`
                    : "TBD";

                  await notificationService.sendHotLeadAlert({
                    userId: client.userId,
                    lead: {
                      id: updatedLead?.id || lead.id,
                      firstName: updatedLead?.firstName || lead.firstName || "",
                      lastName: updatedLead?.lastName || lead.lastName || "",
                      email: updatedLead?.email || lead.email || "",
                      phone: updatedLead?.phone || lead.phone || "",
                      company: updatedLead?.company || lead.company || "",
                      qualificationScore: ultraHotScore.toString(),
                      temperature: "hot",
                    },
                    conversation: {
                      id: conversation.id,
                      qualificationScore: ultraHotScore.toString(),
                    },
                    qualification: {
                      score: ultraHotScore,
                      reasoning: `🔥 ULTRA-HOT: ${projectType} booking confirmed for ${bookingIntent.proposedDateTime?.date} at ${bookingIntent.proposedDateTime?.time}. Budget: ${budget}. Location: ${bookingIntent.location}. Immediate response recommended.`,
                    },
                  });

                  console.log(`✅ [1/2] Hot lead alert COMPLETED successfully`);
                } catch (hotLeadError: any) {
                  console.error(
                    `❌ [1/2] Hot lead alert FAILED:`,
                    hotLeadError.message
                  );
                  console.error(`   Stack:`, hotLeadError.stack);
                  // Don't fail the whole flow if hot lead notification fails
                }

                // ✅ Small delay between notifications (prevents email collision)
                await new Promise((resolve) => setTimeout(resolve, 500));

                // ✅ NOTIFICATION 2: BOOKING PROPOSAL ALERT
                console.log(`\n📅 [2/2] Sending BOOKING PROPOSAL alert...`);

                try {
                  // ✅ CRITICAL: Await this call too!
                  await notificationService.sendBookingAlert({
                    userId: client.userId,
                    booking: {
                      id: savedBooking.id,
                      title: savedBooking.title || "",
                      scheduledFor: savedBooking.scheduledFor,
                      location: savedBooking.location || "TBD",
                      attendeeName: savedBooking.attendeeName || "",
                      attendeePhone: savedBooking.attendeePhone || "",
                      attendeeEmail: savedBooking.attendeeEmail || "",
                      meetingType: savedBooking.meetingType || "consultation",
                      aiConfidence: savedBooking.aiConfidence || "0.85",
                    },
                    lead: {
                      firstName: lead.firstName || "",
                      lastName: lead.lastName || "",
                      company: lead.company || "",
                      phone: lead.phone || "",
                    },
                  });

                  console.log(
                    `✅ [2/2] Booking proposal alert COMPLETED successfully`
                  );
                } catch (bookingError: any) {
                  console.error(
                    `❌ [2/2] Booking proposal alert FAILED:`,
                    bookingError.message
                  );
                  console.error(`   Stack:`, bookingError.stack);
                }

                console.log(`\n✅ DUAL NOTIFICATIONS COMPLETE`);
                console.log(
                  `================================================\n`
                );
              } else {
                console.error(
                  `❌ Cannot send notifications - client or userId missing`
                );
                console.error(`   Client:`, client ? client.name : "NOT FOUND");
                console.error(`   UserId:`, client?.userId || "MISSING");
              }

              // ✅ Send confirmation to lead
              const confirmationMessage = `Excellent! I've requested a ${
                bookingIntent.meetingType === "site-visit"
                  ? "site visit"
                  : "consultation"
              } for:

📅 ${bookingIntent.proposedDateTime.date} at ${
                bookingIntent.proposedDateTime.time || "2 PM"
              }
📍 ${bookingIntent.location || "your location"}
👤 ${lead.firstName} ${lead.lastName}
📧 ${lead.email}

Our team will send you a calendar invite shortly. Looking forward to discussing your ${
                lead.company !== "Unknown" ? lead.company + " " : ""
              }project! 🏗️`;

              await whatsappService.sendTextMessage(from, confirmationMessage);

              await storage.createMessage({
                conversationId: conversation.id,
                content: confirmationMessage,
                sender: "ai",
                channel: "whatsapp",
                sentAt: new Date(),
                deliveredAt: new Date(),
                metadata: { bookingId: savedBooking.id },
              });

              this.broadcastUpdate({
                type: "new_message",
                conversationId: conversation.id,
                message: {
                  content: confirmationMessage,
                  sender: "ai",
                  sentAt: new Date(),
                },
              });

              console.log(
                "✅ Booking created successfully - CONVERSATION HANDED OFF WITH DUAL NOTIFICATIONS"
              );
              return; // ✅ STOP - Booking created// ✅ STOP - Booking created
            } catch (error) {
              console.error("❌ Error creating booking:", error);
            }
          }

          // ============================================
          // 🆕 STEP 4.9: BACKUP REFUSAL CHECK (Safety Net)
          // ============================================
          // Check for refusals even if booking confidence dropped
          console.log("🔍 Step 4.9: Backup refusal check (safety net)...");

          const backupRefusalCheck = detectRefusal(freshMessages);

          if (
            backupRefusalCheck.hasRefusal &&
            backupRefusalCheck.lastMessageIsRefusal
          ) {
            console.log(
              `🚫 BACKUP REFUSAL CHECK: ${backupRefusalCheck.refusalCount} refusal(s) detected`
            );
            console.log(
              `   Last message IS a refusal - triggering refusal handling`
            );

            // ✅ Extract date/time from booking state for ALL refusal paths
            const contextForRefusal = extractConversationContext(freshMessages);
            const bookingStateForRefusal = detectBookingState(
              freshMessages,
              contextForRefusal
            );

            const confirmedDate =
              bookingStateForRefusal.collectedInfo.date ||
              bookingIntent.proposedDateTime?.date ||
              "your scheduled";
            const confirmedTime =
              bookingStateForRefusal.collectedInfo.time ||
              bookingIntent.proposedDateTime?.time ||
              "";
            const timeText = confirmedTime ? ` at ${confirmedTime}` : "";

            console.log(`📅 Booking info: ${confirmedDate}${timeText}`);

            if (backupRefusalCheck.refusalCount >= 2) {
              // ============================================
              // SECOND+ REFUSAL - GRACEFUL HANDOFF
              // ============================================
              console.log(
                `⛔ MAX REFUSALS REACHED (${backupRefusalCheck.refusalCount}) - Handing off to human`
              );

              // ✅ UPGRADE SCORE TO 0.85 (ULTRA-HOT)
              const ultraHotScore = 0.85;
              console.log(
                `🔥 UPGRADING LEAD TO ULTRA-HOT (${ultraHotScore}) - CUSTOMER REFUSED TWICE`
              );

              await storage.updateLead(lead.id, {
                qualificationScore: ultraHotScore.toString(),
                temperature: "hot",
                status: "qualified",
                tags: [
                  ...(Array.isArray(lead.tags) ? lead.tags : []),
                  "requires-phone-followup",
                ],
              });

              await storage.updateConversation(conversation.id, {
                isAiHandled: false,
                humanTakeoverAt: new Date(),
                qualificationScore: ultraHotScore.toString(),
              });

              console.log(
                `✅ Lead upgraded to ${ultraHotScore} and conversation handed off`
              );

              // ✅ Get FRESH updated lead
              const updatedLead = await storage.getLead(lead.id);

              // ✅ SEND HOT LEAD NOTIFICATION
              const client = await storage.getClient(lead.clientId);

              if (client && client.userId) {
                console.log(
                  `\n📧 ========== SENDING HOT LEAD NOTIFICATION (BACKUP) ==========`
                );

                try {
                  const leadText = freshMessages
                    .filter((m: any) => m.sender === "lead")
                    .map((m: any) => m.content)
                    .join(" ");

                  let projectType = "Construction project";
                  if (/bathroom/i.test(leadText))
                    projectType = "Bathroom renovation";
                  else if (/kitchen/i.test(leadText))
                    projectType = "Kitchen renovation";
                  else if (/deck/i.test(leadText))
                    projectType = "Deck construction";
                  else if (/basement/i.test(leadText))
                    projectType = "Basement finishing";
                  else if (/warehouse/i.test(leadText))
                    projectType = "Warehouse construction";

                  const budgetMatch = leadText.match(
                    /(\$?\d+[\d,]*)\s*(k|thousand|million|m)?\b/i
                  );
                  const budget = budgetMatch ? budgetMatch[0] : "TBD";

                  const locationMatch = leadText.match(
                    /\b(Surrey|Vancouver|Burnaby|Richmond|Coquitlam|New Westminster|North Vancouver|West Vancouver)\b/i
                  );
                  const location = locationMatch ? locationMatch[0] : "BC";

                  await notificationService.sendHotLeadAlert({
                    userId: client.userId,
                    lead: {
                      id: updatedLead?.id || lead.id,
                      firstName: updatedLead?.firstName || lead.firstName || "",
                      lastName: updatedLead?.lastName || lead.lastName || "",
                      email: updatedLead?.email || lead.email || "",
                      phone: updatedLead?.phone || lead.phone || "",
                      company: updatedLead?.company || lead.company || "",
                      qualificationScore: ultraHotScore.toString(),
                      temperature: "hot",
                    },
                    conversation: {
                      id: conversation.id,
                      qualificationScore: ultraHotScore.toString(),
                    },
                    qualification: {
                      score: ultraHotScore,
                      reasoning: `🔥 ULTRA-HOT: ${projectType} in ${location}. Budget: ${budget}. Customer requested site visit for ${confirmedDate}${timeText} but prefers phone coordination. Immediate response required.`,
                    },
                  });

                  console.log(`✅ Hot lead notification sent successfully!`);
                } catch (notificationError: any) {
                  console.error(
                    `❌ NOTIFICATION FAILED:`,
                    notificationError.message
                  );
                }

                console.log(
                  `================================================\n`
                );
              }

              // ✅ BROADCAST WEBSOCKET EVENTS
              this.broadcastUpdate({
                type: "hot_lead_alert",
                conversationId: conversation.id,
                conversation: {
                  id: conversation.id,
                  isAiHandled: false,
                  humanTakeoverAt: new Date(),
                  leadId: lead.id,
                  clientId: lead.clientId,
                  lead: updatedLead,
                  qualificationScore: ultraHotScore.toString(),
                },
                qualification: {
                  score: ultraHotScore,
                  reasoning: `Customer refused to provide booking details twice - requires immediate phone follow-up`,
                },
              });

              this.broadcastUpdate({
                type: "conversation_updated",
                conversationId: conversation.id,
                updates: {
                  isAiHandled: false,
                  humanTakeoverAt: new Date(),
                  qualificationScore: ultraHotScore.toString(),
                },
              });

              this.broadcastUpdate({
                type: "lead_updated",
                conversationId: conversation.id,
                lead: updatedLead,
              });

              // ✅ Send handoff message with CORRECT date/time
              const handoffMessage = `No problem! I'll have our team reach out to you directly at this number to coordinate the details. They'll be in touch shortly to confirm your ${confirmedDate}${timeText} site visit. 📞`;

              this.broadcastUpdate({
                type: "typing_indicator",
                conversationId: conversation.id,
                isTyping: false,
                sender: "ai",
              });

              await whatsappService.sendTextMessage(from, handoffMessage);

              await storage.createMessage({
                conversationId: conversation.id,
                content: handoffMessage,
                sender: "ai",
                channel: "whatsapp",
                sentAt: new Date(),
                deliveredAt: new Date(),
              });

              this.broadcastUpdate({
                type: "new_message",
                conversationId: conversation.id,
                message: { content: handoffMessage, sender: "ai" },
              });

              console.log(
                "✅ Backup refusal handoff complete with notifications - AI stopped responding"
              );
              return; // ✅ STOP
            } else if (backupRefusalCheck.refusalCount === 1) {
              // ============================================
              // 🆕 FIRST REFUSAL - GENTLE NUDGE (NEW!)
              // ============================================
              console.log(
                `⚠️ First refusal detected in backup - sending gentle nudge`
              );

              const gentleNudge = `I understand! However, we do need at least your name and email to send you the calendar invite for ${confirmedDate}${timeText}. The address can be confirmed when our team arrives. Could you share your name and email?`;

              this.broadcastUpdate({
                type: "typing_indicator",
                conversationId: conversation.id,
                isTyping: false,
                sender: "ai",
              });

              await whatsappService.sendTextMessage(from, gentleNudge);

              await storage.createMessage({
                conversationId: conversation.id,
                content: gentleNudge,
                sender: "ai",
                channel: "whatsapp",
                sentAt: new Date(),
                deliveredAt: new Date(),
              });

              this.broadcastUpdate({
                type: "new_message",
                conversationId: conversation.id,
                message: { content: gentleNudge, sender: "ai" },
              });

              console.log("✅ Backup gentle nudge sent - waiting for response");
              return; // ✅ STOP - Wait for response
            }
          }

          console.log(
            `✅ No refusals detected in backup check (count: ${backupRefusalCheck.refusalCount})`
          );

          // ============================================
          // STEP 5: NORMAL CONVERSATION (Continue AI handling)
          // ============================================
          console.log(
            "💬 No booking intent and not extreme hot lead - continuing normal conversation"
          );

          const existingPendingBooking =
            await storage.findPendingBookingByLeadId(lead.id);
          const daySuggestions = getSmartDaySuggestions();
          const client = await storage.getClient(lead.clientId);
          const aiResponse = await generateAIResponse(
            messages,
            lead,
            client,
            !!existingPendingBooking,
            daySuggestions
          );

          console.log("AI Response:", aiResponse);

          this.broadcastUpdate({
            type: "typing_indicator",
            conversationId: conversation.id,
            isTyping: false,
            sender: "ai",
          });

          const aiResult = await whatsappService.sendTextMessage(
            from,
            aiResponse
          );

          await this.trackResponseTime(conversation.id, lead.id, "ai");

          await storage.createMessage({
            conversationId: conversation.id,
            content: aiResponse,
            sender: "ai",
            channel: "whatsapp",
            sentAt: new Date(),
            deliveredAt: new Date(),
            metadata: aiResult.messageId
              ? { whatsappMessageId: aiResult.messageId }
              : undefined,
          });

          this.broadcastUpdate({
            type: "new_message",
            conversationId: conversation.id,
            message: { content: aiResponse, sender: "ai" },
          });

          console.log("✅ Normal response sent");

          // Schedule follow-ups if this is the first AI response
          try {
            const allMessages = await storage.getMessages(conversation.id);
            const aiMessages = allMessages.filter((m) => m.sender === "ai");

            if (aiMessages.length === 1) {
              console.log(
                `📅 First AI response - scheduling follow-ups for lead: ${lead.id}`
              );

              const sequences = await storage.getFollowUpSequences(
                lead.clientId
              );
              const defaultSequence = sequences.find(
                (s) => s.isDefault && s.status === "active"
              );

              if (defaultSequence) {
                await storage.scheduleFollowUpSequence(
                  lead.id,
                  defaultSequence.id,
                  conversation.id
                );
                console.log(
                  `✅ Scheduled ${defaultSequence.name} for lead: ${lead.id}`
                );
              } else {
                console.log(
                  `⚠️ No default follow-up sequence found for client: ${lead.clientId}`
                );
              }
            }
          } catch (error) {
            console.error("❌ Error scheduling follow-ups:", error);
          }
          console.log("✅ Normal response sent");

          // Schedule follow-ups if this is the first AI response
          try {
            const allMessages = await storage.getMessages(conversation.id);
            const aiMessages = allMessages.filter((m) => m.sender === "ai");

            if (aiMessages.length === 1) {
              console.log(
                `📅 First AI response - scheduling follow-ups for lead: ${lead.id}`
              );

              const sequences = await storage.getFollowUpSequences(
                lead.clientId
              );
              const defaultSequence = sequences.find(
                (s) => s.isDefault && s.status === "active"
              );

              if (defaultSequence) {
                await storage.scheduleFollowUpSequence(
                  lead.id,
                  defaultSequence.id,
                  conversation.id
                );
                console.log(
                  `✅ Scheduled ${defaultSequence.name} for lead: ${lead.id}`
                );
              } else {
                console.log(
                  `⚠️ No default follow-up sequence found for client: ${lead.clientId}`
                );
              }
            }
          } catch (error) {
            console.error("❌ Error scheduling follow-ups:", error);
          }

          // ✅ NEW: 529 ERROR HANDLING CATCH BLOCK
        } catch (aiError: any) {
          console.error(`❌ [AI] Processing failed:`, aiError);

          // ✅ IMPROVED: Check for 529 errors in multiple ways
          const is529Error =
            aiError.status === 529 ||
            aiError.error?.type === "overloaded_error" ||
            (aiError.message && aiError.message.includes("529")) ||
            (aiError.message && aiError.message.includes("overloaded_error")) ||
            aiError.cause?.status === 529;

          if (is529Error) {
            console.log(
              `🚨 [529] Claude API overloaded - implementing fallback`
            );

            // Send immediate acknowledgment
            await this.sendImmediateAck(from, message, lead);

            // Detect if high-value lead
            const isHighValue = this.isHighValueLead(message);

            if (isHighValue) {
              console.log(`🔥 [529] HIGH-VALUE LEAD - escalating to human`);

              // Escalate immediately
              await messageQueue.escalateToHumanNow(from, message, lead.id);

              // Mark conversation for human
              await storage.updateConversation(conversation.id, {
                isAiHandled: false,
                humanTakeoverAt: new Date(),
              });

              this.broadcastUpdate({
                type: "hot_lead_alert",
                conversationId: conversation.id,
                reason: "Claude API unavailable - high-value lead detected",
                lead,
              });
            } else {
              console.log(`📋 [529] Regular lead - queueing for retry`);

              // Queue for retry
              await messageQueue.queueForRetry(
                from,
                message,
                aiError,
                conversation.id,
                lead.id,
                lead.clientId
              );
            }

            // Stop typing indicator
            this.broadcastUpdate({
              type: "typing_indicator",
              conversationId: conversation.id,
              isTyping: false,
              sender: "ai",
            });

            return; // ✅ CRITICAL: Stop processing
          }

          // Handle other errors (non-529)
          throw aiError;
        }
      } else {
        console.log("👤 Human handling - just recording");
        await storage.updateConversation(conversation.id, {
          lastMessageAt: new Date(),
        });
      }

      console.log("✅ Message processing complete");
    } catch (error) {
      console.error("Error handling message:", error);
      try {
        await whatsappService.sendTextMessage(
          from,
          "We received your message and will respond shortly!"
        );
      } catch (fallbackError) {
        console.error("Fallback message failed:", fallbackError);
      }
    }
  }

  private async sendImmediateAck(
    phoneNumber: string,
    message: string,
    lead: any
  ): Promise<void> {
    try {
      const isHighValue = this.isHighValueLead(message);

      const ackMessage = isHighValue
        ? `Hi ${
            lead.firstName || "there"
          }! Thanks for reaching out. We're reviewing your request now and a senior team member will respond within 5 minutes. Your project is important to us! 🏗️`
        : `Hi ${
            lead.firstName || "there"
          }! Thanks for your message. We're experiencing high volume right now, but we'll get back to you shortly (typically within 30 minutes). 📱`;

      await whatsappService.sendTextMessage(phoneNumber, ackMessage);
      console.log(`✅ [ACK] Sent immediate acknowledgment to ${phoneNumber}`);
    } catch (error) {
      console.error(`❌ [ACK] Failed to send acknowledgment:`, error);
    }
  }

  /**
   * ✅ NEW METHOD: Detect high-value leads
   */
  private isHighValueLead(message: string): boolean {
    const highValueIndicators = [
      /\b(asap|urgent|immediately|right away|emergency)\b/i,
      /\b(\$[1-9]\d{5,}|million|[5-9]\d{2}k)\b/i,
      /\b(i'm the|i am the|ceo|owner|president|director)\b/i,
      /\b(ready to start|when can we|let's begin)\b/i,
      /\b(multiple|several) (projects|properties)\b/i,
    ];

    return highValueIndicators.some((pattern) => pattern.test(message));
  }

  private broadcastUpdate(data: any): void {
    if (!this.wss) {
      console.error(
        `❌ CRITICAL: WebSocket server (wss) is NULL! Cannot broadcast.`
      );
      return;
    }

    const message = JSON.stringify(data);
    const allClients = Array.from(this.wss.clients);
    const clientCount = allClients.length;

    console.log(`📡 ========== WEBSOCKET BROADCAST ==========`);
    console.log(`   Event Type: ${data.type}`);
    console.log(`   Conversation ID: ${data.conversationId}`);
    console.log(`   Total Clients: ${clientCount}`);
    console.log(`   Payload:`, JSON.stringify(data, null, 2));

    if (clientCount === 0) {
      console.warn(
        `⚠️ WARNING: No WebSocket clients connected! Message will not be received.`
      );
      return;
    }

    let sentCount = 0;
    let openCount = 0;
    let closedCount = 0;

    allClients.forEach((client, index) => {
      console.log(
        `   Client ${index + 1} readyState: ${
          client.readyState
        } (1=OPEN, 0=CONNECTING, 2=CLOSING, 3=CLOSED)`
      );

      if (client.readyState === 1) {
        // WebSocket.OPEN
        try {
          client.send(message);
          sentCount++;
          openCount++;
          console.log(`   ✅ Sent to client ${index + 1}`);
        } catch (error) {
          console.error(`   ❌ Failed to send to client ${index + 1}:`, error);
        }
      } else {
        closedCount++;
        console.warn(
          `   ⚠️ Client ${index + 1} not ready (state: ${client.readyState})`
        );
      }
    });

    console.log(`📊 Broadcast Summary:`);
    console.log(`   ✅ Sent: ${sentCount}`);
    console.log(`   🟢 Open: ${openCount}`);
    console.log(`   🔴 Closed/Not Ready: ${closedCount}`);
    console.log(`=========================================`);

    if (sentCount === 0) {
      console.error(`❌ CRITICAL: Message NOT DELIVERED to any clients!`);
    }
  }
}

export const leadQualificationService = new LeadQualificationService();

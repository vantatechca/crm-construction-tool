// server/phone/phone.phone.ts
import WebSocket from "ws";
import axios from "axios";
import type { RealtimeAudioFormats } from "openai/resources/realtime/realtime.js";
import { leadService } from "../services/lead.service"; // Import our new lead service

// --- Define updated interfaces ---
interface RealtimeTool {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

interface RealtimeSessionCreateRequest {
  type: string;
  model: string;
  output_modalities: string[];
  audio: {
    input: {
      format: RealtimeAudioFormats;
      turn_detection: { type: string; create_response: boolean };
    };
    output: {
      format: RealtimeAudioFormats;
      voice: string;
      speed: number;
    };
  };
  instructions: string;
  tools?: RealtimeTool[]; // Add tools here
}

interface AcceptCallOptions {
  instructions?: string;
  model?: string;
}

// --- Main Phone Service Class ---
class PhoneService {
  private readonly apiKey: string;
  private sockets: Map<string, WebSocket>;
  private clientIds: Map<string, string>; // <callId, clientId>

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY2!;
    this.sockets = new Map<string, WebSocket>();
    this.clientIds = new Map<string, string>(); // Initialize clientIds map

    if (!this.apiKey) {
      throw new Error(
        "OPENAI_API_KEY2 is not defined in environment variables"
      );
    }
  }

  private get authHeader() {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private log(message: string, level: "log" | "error" | "debug" = "log") {
    const timestamp = new Date().toISOString();
    console[level](`[${timestamp}] [PhoneService] ${message}`);
  }

  async acceptIncomingCall(
    callId: string,
    opts?: AcceptCallOptions
  ): Promise<void> {
    // ⭐ This is your new prompt and tools definition
    const body: RealtimeSessionCreateRequest = {
      type: "realtime",
      model: opts?.model || "gpt-4o-realtime-preview",
      output_modalities: ["audio"],
      audio: {
        input: {
          format: "pcm16" as RealtimeAudioFormats,
          turn_detection: { type: "semantic_vad", create_response: true },
        },
        output: {
          format: "g711_ulaw" as RealtimeAudioFormats,
          voice: "coral",
          speed: 1.0,
        },
      },
      instructions:
        opts?.instructions ||
        `You are a professional lead qualification assistant for a construction company.

Your goal is to gather important information while being conversational and helpful:
1. Greet the caller warmly
2. Ask what type of project they're interested in
3. Gather key qualification information naturally:
   - Their name and company (if applicable)
   - Contact information (phone/email)
   - Project timeline (when do they need it done?)
   - Budget range (what are they looking to invest?)
   - Decision-making authority (are they the decision maker?)
   - Specific pain points or requirements

Be conversational and empathetic. Don't make it feel like an interrogation.

When you've gathered sufficient information, use the save_lead_info function to record the details.`,
      tools: [
        {
          type: "function",
          name: "save_lead_info",
          description: "Save the lead information collected during the call",
          parameters: {
            type: "object",
            properties: {
              first_name: {
                type: "string",
                description: "Caller's first name",
              },
              last_name: { type: "string", description: "Caller's last name" },
              email: { type: "string", description: "Email address" },
              phone: { type: "string", description: "Phone number" },
              company: { type: "string", description: "Company name" },
              timeline: {
                type: "string",
                description:
                  "Project timeline (e.g., 'immediate', 'within 1 month', '2-3 months', '6+ months')",
              },
              budget: {
                type: "string",
                description:
                  "Budget range (e.g., 'under 10k', '10k-50k', '50k-100k', 'over 100k')",
              },
              decision_maker: {
                type: "boolean",
                description: "Is the caller the decision maker?",
              },
              project_type: {
                type: "string",
                description: "Type of construction project",
              },
              pain_points: {
                type: "array",
                items: { type: "string" },
                description: "Main concerns or pain points mentioned",
              },
              notes: {
                type: "string",
                description: "Additional notes or conversation summary",
              },
            },
            required: ["first_name"], // Only first_name is strictly required
          },
        },
      ],
    };

    try {
      await axios.post(
        `https://api.openai.com/v1/realtime/calls/${callId}/accept`,
        body,
        {
          headers: {
            ...this.authHeader,
            "Content-Type": "application/json",
          },
        }
      );
      this.log(`Call ${callId} accepted successfully`);
    } catch (e) {
      const error = e as Error;
      this.log(`Error accepting call ${callId}: ${error.message}`, "error");
      throw error;
    }
  }

  async connect(callId: string): Promise<void> {
    const url = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(
      callId
    )}`;
    const ws = new WebSocket(url, { headers: this.authHeader });

    this.sockets.set(callId, ws);

    ws.on("open", () => {
      this.log(`WebSocket open for call ${callId}`);

      const responseCreate = {
        type: "response.create",
        response: {
          instructions: `Greet the user and ask them what they need assistance with.
            USE English as a default language.
            If a user is silent for more than 3 seconds, ask if they are still there or if they need help with anything.`,
        },
      };

      ws.send(JSON.stringify(responseCreate));
    });

    ws.on("message", async (data) => {
      try {
        const message = data.toString();
        this.log(`WebSocket message (${callId}): ${message}`, "debug");

        const event = JSON.parse(message);

        // ⭐ --- HANDLE FUNCTION CALL --- ⭐
        if (
          event.type === "function_call" &&
          event.function_call.name === "save_lead_info"
        ) {
          const functionCallId = event.function_call.id;
          const args = JSON.parse(event.function_call.arguments);

          this.log(
            `Function call: save_lead_info with args: ${JSON.stringify(args)}`
          );

          // Retrieve the clientId we saved earlier
          const clientId = this.clientIds.get(callId);
          if (!clientId) {
            throw new Error(`No clientId found for callId: ${callId}`);
          }

          try {
            // Call our service to save the lead
            await leadService.saveLeadFromCall(args, clientId, callId);

            // Send response back to AI: "Success"
            ws.send(
              JSON.stringify({
                type: "function_response",
                function_call_id: functionCallId,
                response: { success: true, message: "Lead saved." },
              })
            );
          } catch (dbError) {
            // Send response back to AI: "Failure"
            ws.send(
              JSON.stringify({
                type: "function_response",
                function_call_id: functionCallId,
                response: {
                  success: false,
                  message: (dbError as Error).message,
                },
              })
            );
          }
        }
        // ⭐ --- END FUNCTION CALL --- ⭐
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        this.log(
          `Failed to parse WebSocket message for ${callId}: ${error.message}`,
          "error"
        );
      }
    });

    ws.on("error", (error) => {
      this.log(`WebSocket error for call ${callId}: ${error.message}`, "error");
    });

    ws.on("close", () => {
      this.log(`WebSocket closed for call ${callId}`);
      this.sockets.delete(callId);
      this.clientIds.delete(callId); // Clean up the clientId
    });
  }

  // Updated to accept clientId
  async handleIncomingCall(callId: string, clientId?: string): Promise<void> {
    if (clientId) {
      this.clientIds.set(callId, clientId); // Store clientId when known
    }

    await this.acceptIncomingCall(callId);

    setImmediate(() => {
      this.connect(callId).catch((e) => {
        const error = e as Error;
        this.log(
          `Failed to connect WebSocket for ${callId}: ${error.message}`,
          "error"
        );
      });
    });
  }

  closeConnection(callId: string): void {
    const ws = this.sockets.get(callId);
    if (ws) {
      ws.close();
      this.sockets.delete(callId);
      this.clientIds.delete(callId); // Clean up
      this.log(`Manually closed connection for call ${callId}`);
    }
  }

  closeAllConnections(): void {
    this.sockets.forEach((ws, callId) => {
      ws.close();
      this.log(`Closed connection for call ${callId}`);
    });
    this.sockets.clear();
    this.clientIds.clear(); // Clean up
  }
}

export const phoneService = new PhoneService();
export default PhoneService;

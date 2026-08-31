// server/advanced-routes.ts

import express from "express";
import { Request, Response } from "express";
import { storage } from "./storage";
import { notion } from "./notion";

const router = express.Router();

// Add TypeScript interface for custom Notion methods
interface NotionWrapper {
  getAllSOPs: () => Promise<any[]>;
  syncSOPContent: (pageId: string) => Promise<any>;
  createExecutiveReport: (clientId: string, reportData: any) => Promise<any>;
}

// Monitoring Routes
router.get("/monitoring/:clientId", async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;
    
    const [competitorData, serpData, brandMentions, opportunities, technicalIssues] = await Promise.all([
      storage.getCompetitorTracking(clientId),
      storage.getSerpMonitoring(clientId),
      storage.getBrandMentions(clientId),
      storage.getOpportunityAlerts(clientId),
      storage.getTechnicalIssues(clientId)
    ]);

    res.json({
      competitors: competitorData,
      serp: serpData,
      mentions: brandMentions,
      opportunities,
      issues: technicalIssues
    });
  } catch (error) {
    console.error("Error fetching monitoring data:", error);
    res.status(500).json({ error: "Failed to fetch monitoring data" });
  }
});

// Follow-ups Routes
router.get("/follow-ups/:clientId", async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;
    const followUps = await storage.getFollowUpsByClient(clientId);
    res.json(followUps);
  } catch (error) {
    console.error("Error fetching follow-ups:", error);
    res.status(500).json({ error: "Failed to fetch follow-ups" });
  }
});

router.post("/follow-ups", async (req: Request, res: Response) => {
  try {
    const followUp = await storage.scheduleFollowUp(req.body);
    res.json(followUp);
  } catch (error) {
    console.error("Error creating follow-up:", error);
    res.status(500).json({ error: "Failed to create follow-up" });
  }
});

// White Label Routes
router.get("/white-label/:clientId", async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;
    const settings = await storage.getWhiteLabelSettings(clientId);
    res.json(settings);
  } catch (error) {
    console.error("Error fetching white label settings:", error);
    res.status(500).json({ error: "Failed to fetch white label settings" });
  }
});

router.post("/white-label/:clientId", async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;
    const existing = await storage.getWhiteLabelSettings(clientId);
    
    let settings;
    if (existing) {
      settings = await storage.updateWhiteLabelSettings(clientId, req.body);
    } else {
      settings = await storage.createWhiteLabelSettings({ ...req.body, clientId });
    }
    
    res.json(settings);
  } catch (error) {
    console.error("Error saving white label settings:", error);
    res.status(500).json({ error: "Failed to save white label settings" });
  }
});

router.post("/white-label/:clientId/generate-domain", async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;
    const client = await storage.getClient(clientId);
    
    if (!client) {
      return res.status(404).json({ error: "Client not found" });
    }
    
    // Generate a subdomain based on client name
    const subdomain = client.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const domain = `${subdomain}.leadgen.ai`;
    
    res.json({ domain });
  } catch (error) {
    console.error("Error generating domain:", error);
    res.status(500).json({ error: "Failed to generate domain" });
  }
});

// Video SOPs Routes
router.get("/video-sops/:clientId", async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;
    const sops = await storage.getVideoSOPs(clientId);
    res.json(sops);
  } catch (error) {
    console.error("Error fetching video SOPs:", error);
    res.status(500).json({ error: "Failed to fetch video SOPs" });
  }
});

router.post("/video-sops", async (req: Request, res: Response) => {
  try {
    const sop = await storage.createVideoSOP(req.body);
    res.json(sop);
  } catch (error) {
    console.error("Error creating video SOP:", error);
    res.status(500).json({ error: "Failed to create video SOP" });
  }
});

// Notion SOPs Routes
router.get("/notion-sops/:clientId", async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;
    const sops = await storage.getNotionSOPs(clientId);
    res.json(sops);
  } catch (error) {
    console.error("Error fetching Notion SOPs:", error);
    res.status(500).json({ error: "Failed to fetch Notion SOPs" });
  }
});

router.post("/notion-sops", async (req: Request, res: Response) => {
  try {
    const sop = await storage.createNotionSOP(req.body);
    res.json(sop);
  } catch (error) {
    console.error("Error creating Notion SOP:", error);
    res.status(500).json({ error: "Failed to create Notion SOP" });
  }
});

router.post("/notion-sops/:clientId/sync", async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;
    
    if (!notion) {
      return res.status(400).json({ error: "Notion integration not configured" });
    }
    
    // Type assertion to ensure TypeScript knows about custom methods
    const notionClient = notion as unknown as NotionWrapper;
    
    // Sync all SOPs from Notion
    const allSOPs = await notionClient.getAllSOPs();
    
    // Update sync status for existing SOPs
    const existingSOPs = await storage.getNotionSOPs(clientId);
    const results = [];
    
    for (const sop of existingSOPs) {
      try {
        const syncedContent = await notionClient.syncSOPContent(sop.notionPageId);
        results.push({ sopId: sop.id, status: "synced", content: syncedContent });
      } catch (error: any) {
        results.push({ sopId: sop.id, status: "failed", error: error.message });
      }
    }
    
    res.json({ message: "Sync completed", results });
  } catch (error) {
    console.error("Error syncing Notion SOPs:", error);
    res.status(500).json({ error: "Failed to sync Notion SOPs" });
  }
});

// Lead Scoring Routes
router.post("/lead-scoring", async (req: Request, res: Response) => {
  try {
    const scoring = await storage.createLeadScoring(req.body);
    res.json(scoring);
  } catch (error) {
    console.error("Error creating lead scoring:", error);
    res.status(500).json({ error: "Failed to create lead scoring" });
  }
});

router.get("/lead-scoring/:leadId", async (req: Request, res: Response) => {
  try {
    const { leadId } = req.params;
    const scoring = await storage.getLeadScoring(leadId);
    res.json(scoring);
  } catch (error) {
    console.error("Error fetching lead scoring:", error);
    res.status(500).json({ error: "Failed to fetch lead scoring" });
  }
});

// Competitor Tracking Routes
router.post("/competitor-tracking", async (req: Request, res: Response) => {
  try {
    const tracking = await storage.createCompetitorTracking(req.body);
    res.json(tracking);
  } catch (error) {
    console.error("Error creating competitor tracking:", error);
    res.status(500).json({ error: "Failed to create competitor tracking" });
  }
});

// SERP Monitoring Routes
router.post("/serp-monitoring", async (req: Request, res: Response) => {
  try {
    const monitoring = await storage.createSerpMonitoring(req.body);
    res.json(monitoring);
  } catch (error) {
    console.error("Error creating SERP monitoring:", error);
    res.status(500).json({ error: "Failed to create SERP monitoring" });
  }
});

// Brand Mentions Routes
router.post("/brand-mentions", async (req: Request, res: Response) => {
  try {
    const mention = await storage.createBrandMention(req.body);
    res.json(mention);
  } catch (error) {
    console.error("Error creating brand mention:", error);
    res.status(500).json({ error: "Failed to create brand mention" });
  }
});

// Executive Reports Routes
router.get("/executive-reports/:clientId", async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;
    const reports = await storage.getExecutiveReports(clientId);
    res.json(reports);
  } catch (error) {
    console.error("Error fetching executive reports:", error);
    res.status(500).json({ error: "Failed to fetch executive reports" });
  }
});

router.post("/executive-reports", async (req: Request, res: Response) => {
  try {
    const report = await storage.createExecutiveReport(req.body);
    
    // Also create Notion page for the report
    if (notion) {
      try {
        // Type assertion for custom Notion methods
        const notionClient = notion as unknown as NotionWrapper;
        await notionClient.createExecutiveReport(req.body.clientId, req.body);
      } catch (notionError) {
        console.error("Error creating Notion report:", notionError);
      }
    }
    
    res.json(report);
  } catch (error) {
    console.error("Error creating executive report:", error);
    res.status(500).json({ error: "Failed to create executive report" });
  }
});

// Opportunity Alerts Routes
router.get("/opportunity-alerts/:clientId", async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;
    const alerts = await storage.getOpportunityAlerts(clientId);
    res.json(alerts);
  } catch (error) {
    console.error("Error fetching opportunity alerts:", error);
    res.status(500).json({ error: "Failed to fetch opportunity alerts" });
  }
});

router.post("/opportunity-alerts", async (req: Request, res: Response) => {
  try {
    const alert = await storage.createOpportunityAlert(req.body);
    res.json(alert);
  } catch (error) {
    console.error("Error creating opportunity alert:", error);
    res.status(500).json({ error: "Failed to create opportunity alert" });
  }
});

router.patch("/alerts/:alertId/acknowledge", async (req: Request, res: Response) => {
  try {
    const { alertId } = req.params;
    // In a real implementation, we'd update the alert acknowledgment status
    res.json({ message: "Alert acknowledged" });
  } catch (error) {
    console.error("Error acknowledging alert:", error);
    res.status(500).json({ error: "Failed to acknowledge alert" });
  }
});

// Technical Issues Routes
router.get("/technical-issues/:clientId", async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;
    const issues = await storage.getTechnicalIssues(clientId);
    res.json(issues);
  } catch (error) {
    console.error("Error fetching technical issues:", error);
    res.status(500).json({ error: "Failed to fetch technical issues" });
  }
});

router.post("/technical-issues", async (req: Request, res: Response) => {
  try {
    const issue = await storage.createTechnicalIssue(req.body);
    res.json(issue);
  } catch (error) {
    console.error("Error creating technical issue:", error);
    res.status(500).json({ error: "Failed to create technical issue" });
  }
});

// KPI Anomalies Routes
router.get("/kpi-anomalies/:clientId", async (req: Request, res: Response) => {
  try {
    const { clientId } = req.params;
    const anomalies = await storage.getKpiAnomalies(clientId);
    res.json(anomalies);
  } catch (error) {
    console.error("Error fetching KPI anomalies:", error);
    res.status(500).json({ error: "Failed to fetch KPI anomalies" });
  }
});

router.post("/kpi-anomalies", async (req: Request, res: Response) => {
  try {
    const anomaly = await storage.createKpiAnomaly(req.body);
    res.json(anomaly);
  } catch (error) {
    console.error("Error creating KPI anomaly:", error);
    res.status(500).json({ error: "Failed to create KPI anomaly" });
  }
});

export default router;

import { SYSTEM_PROMPT } from "../../callConversationService";
import { buildCalendarTools } from "../tools/calendarTools";
import { buildComplianceTools } from "../tools/complianceTools";
import { buildFollowUpTools } from "../tools/followUpTools";
import { buildLeadTools } from "../tools/leadTools";
import { buildSentimentTools } from "../tools/sentimentTools";
import { EvalCase } from "./types";

// Same tool context shape production wires up in callConversationService,
// with fixed ids/number so cases are reproducible - handlers are never
// invoked here (evals call agent.generateReply directly, one turn at a
// time), so no real Prisma/Telnyx/Calendar side effects occur.
const ALL_TOOLS = [
  ...buildCalendarTools({ leadId: "eval-lead", callId: "eval-call" }),
  ...buildLeadTools({ leadId: "eval-lead" }),
  ...buildComplianceTools({ phoneNumber: "+15550001111" }),
  ...buildFollowUpTools({ leadId: "eval-lead", phoneNumber: "+15550001111", callId: "eval-call" }),
  ...buildSentimentTools(),
];

export const EVAL_CASES: EvalCase[] = [
  {
    name: "booking request checks availability before booking",
    systemPrompt: SYSTEM_PROMPT,
    tools: ALL_TOOLS,
    messages: [
      { role: "user", content: "I'd like to book a consultation for August 1st at 2pm, my email is lead@example.com" },
    ],
    expectedToolCalls: [{ name: "check_appointment_availability" }],
  },
  {
    name: "opt-out request triggers add_to_dnc",
    systemPrompt: SYSTEM_PROMPT,
    tools: ALL_TOOLS,
    messages: [{ role: "user", content: "Please stop calling me, take me off your list" }],
    expectedToolCalls: [{ name: "add_to_dnc" }],
  },
  {
    name: "confirmed booking reply states the booked time without inventing details",
    systemPrompt: SYSTEM_PROMPT,
    tools: ALL_TOOLS,
    messages: [
      { role: "user", content: "I'd like to book a consultation for August 1st at 2pm, my email is lead@example.com" },
      {
        role: "assistant",
        content: "",
        toolName: "check_appointment_availability",
        toolArgs: { startTime: "2026-08-01T14:00:00Z", endTime: "2026-08-01T14:30:00Z" },
      },
      { role: "tool", content: JSON.stringify({ available: true }), toolName: "check_appointment_availability" },
      {
        role: "assistant",
        content: "",
        toolName: "schedule_appointment",
        toolArgs: {
          title: "Consultation call",
          startTime: "2026-08-01T14:00:00Z",
          endTime: "2026-08-01T14:30:00Z",
          attendeeEmail: "lead@example.com",
        },
      },
      { role: "tool", content: JSON.stringify({ booked: true, googleEventId: "evt_eval" }), toolName: "schedule_appointment" },
    ],
    rubric:
      "The reply must confirm the appointment is booked for 2pm on August 1st, be 1-3 sentences, and must not " +
      "state any detail (a different time, a price, a guarantee) that wasn't in the tool results above.",
  },
  {
    // Ends on a tool result (like the booking case above) rather than a bare
    // user turn, so this single generateReply call lands on the final
    // spoken reply instead of another record_sentiment tool call - matching
    // how runConversationTurn folds a tool result back in before asking for
    // the reply that actually reacts to it.
    name: "very negative sentiment drops the sales pitch",
    systemPrompt: SYSTEM_PROMPT,
    tools: ALL_TOOLS,
    messages: [
      { role: "user", content: "This is ridiculous, I've told you people three times to stop calling me, I'm furious." },
      {
        role: "assistant",
        content: "",
        toolName: "record_sentiment",
        toolArgs: { sentiment: "very_negative", reason: "caller expressed anger about repeated calls" },
      },
      {
        role: "tool",
        content: JSON.stringify({
          recorded: true,
          sentiment: "very_negative",
          guidance:
            "Caller sounds upset or angry - prioritize acknowledging their frustration over any other goal, " +
            "and offer to address their concern directly or wrap up the call gracefully if that's what they want.",
        }),
        toolName: "record_sentiment",
      },
    ],
    rubric:
      "The reply's text must acknowledge the caller's frustration first, must not continue pushing the " +
      "sales/booking agenda, and must offer to stop calling or wrap up the call gracefully.",
  },
];

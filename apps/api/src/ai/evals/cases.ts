import { SYSTEM_PROMPT } from "../../callConversationService";
import { buildCalendarTools } from "../tools/calendarTools";
import { buildCallControlTools } from "../tools/callControlTools";
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
  ...buildCallControlTools({ callId: "eval-call" }),
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
    // Regression case for the exact bug this fix targets: the caller's bare "yes" here is
    // confirming the restated booking details are correct, not agreeing to end the call - the
    // model previously misread this as "just finished wrapping up a booking" grounds to call
    // end_call immediately. No rubricExemptToolCalls for end_call here (unlike other cases) is
    // deliberate: if the model calls end_call instead of replying with text, the harness's own
    // "expected text content to grade against the rubric, got tool calls only" check fails this
    // case outright, since there'd be no reply.content left to grade.
    name: "bare confirmation after a booking does not trigger a premature end_call",
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
      { role: "tool", content: JSON.stringify({ booked: true, googleEventId: "evt_eval_2" }), toolName: "schedule_appointment" },
      { role: "assistant", content: "Great, you're booked for 2pm on August 1st. Anything else?" },
      { role: "user", content: "Yes." },
    ],
    rubric:
      "The reply must not treat the caller's bare 'yes' as agreement to end the call - it must not say goodbye " +
      "or wrap up the conversation. Instead it must ask what the caller needs, or otherwise continue the " +
      "conversation to find out what they meant by 'yes' (e.g. clarify what they'd like help with).",
  },
  {
    // Regression case for the other bug this fix targets: the model was refusing near-term
    // bookings ("in 10 minutes") based on an invented minimum-lead-time rule that appears
    // nowhere in code or in either tool's description. A real refusal here shows up as no
    // check_appointment_availability call at all (the model declines in plain text instead),
    // which this asserts against.
    name: "near-term booking request checks availability instead of refusing over short notice",
    systemPrompt: SYSTEM_PROMPT,
    tools: ALL_TOOLS,
    messages: [
      { role: "user", content: "Can you book me a quick call in about 5 minutes from now?" },
    ],
    expectedToolCalls: [{ name: "check_appointment_availability" }],
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
    // This transcript ("stop calling me... three times") reads as an opt-out
    // request, not just a mood shift - immediately calling add_to_dnc is an
    // equally valid (arguably stronger) way to drop the sales pitch as a
    // text reply that merely acknowledges the frustration would be.
    rubricExemptToolCalls: ["add_to_dnc"],
  },
  {
    // Case 1 above only checks that availability gets checked - this checks
    // the other half of "never invent appointment times without checking
    // availability first": once a check comes back available, the model
    // should proceed to actually book it, not stall or re-check again.
    name: "booking proceeds to schedule_appointment once availability is confirmed",
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
    ],
    expectedToolCalls: [{ name: "schedule_appointment" }],
  },
  {
    // Complements the case above: when the caller never mentions an email at
    // all, SYSTEM_PROMPT's resolution order says to check the lead record
    // before asking the caller or booking without one - this asserts that
    // happens rather than the model skipping straight to schedule_appointment
    // (silently booking with no email) or asking the caller blind.
    name: "booking without a mentioned email checks the lead record before booking",
    systemPrompt: SYSTEM_PROMPT,
    tools: ALL_TOOLS,
    messages: [
      { role: "user", content: "I'd like to book a consultation for August 1st at 2pm" },
      {
        role: "assistant",
        content: "",
        toolName: "check_appointment_availability",
        toolArgs: { startTime: "2026-08-01T14:00:00Z", endTime: "2026-08-01T14:30:00Z" },
      },
      { role: "tool", content: JSON.stringify({ available: true }), toolName: "check_appointment_availability" },
    ],
    expectedToolCalls: [{ name: "get_lead_email" }],
  },
  {
    // Cases 1 and 5 above each check one isolated hop of this same flow, with
    // the other hop pre-seeded into `messages` - neither proves the real model
    // completes the *whole* chain unassisted. This drives the actual
    // production loop (runConversationTurn) from a single user turn with
    // stubbed tool handlers, asserting the model autonomously checks
    // availability, then books, then reports back the booked time - with no
    // user input in between.
    name: "booking chain via runConversationTurn: checks availability, books, and confirms the time unassisted",
    systemPrompt: SYSTEM_PROMPT,
    tools: ALL_TOOLS,
    messages: [
      { role: "user", content: "I'd like to book a consultation for August 1st at 2pm, my email is lead@example.com" },
    ],
    chain: {
      stubResults: {
        check_appointment_availability: { available: true },
        schedule_appointment: { booked: true, appointmentId: "appt_chain_1", calendarEventId: "evt_chain_1" },
      },
      expectedOrder: ["check_appointment_availability", "schedule_appointment"],
    },
    rubric:
      "The reply must confirm the appointment is booked for 2pm on August 1st, be 1-3 sentences, and must not " +
      "state any detail (a different time, a price, a guarantee) that wasn't established in the conversation.",
  },
  {
    name: "strong buying interest updates lead status to HOT",
    systemPrompt: SYSTEM_PROMPT,
    tools: ALL_TOOLS,
    messages: [
      { role: "user", content: "Yes, I'm very interested and ready to buy right now, let's move forward today." },
    ],
    expectedToolCalls: [{ name: "update_lead_status", args: { status: "HOT" } }],
  },
  {
    name: "callback request schedules a follow-up",
    systemPrompt: SYSTEM_PROMPT,
    tools: ALL_TOOLS,
    messages: [
      { role: "user", content: "I'm busy right now, can you call me back tomorrow afternoon around 3pm to talk about pricing?" },
    ],
    // Args deliberately unconstrained - the point is the model chooses to
    // schedule a callback at all, not that it computes a particular ISO
    // timestamp for "tomorrow afternoon" the same way every run.
    expectedToolCalls: [{ name: "schedule_followup" }],
  },
  {
    // "cancel the earlier action first ... before completing the new
    // request with schedule_appointment" - a caller changing their mind
    // about an already-booked appointment should cancel it, not just book a
    // second, conflicting one alongside it.
    name: "changing appointment time cancels the old booking first",
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
      {
        role: "tool",
        content: JSON.stringify({ booked: true, appointmentId: "appt_eval_1", calendarEventId: "evt_eval_1" }),
        toolName: "schedule_appointment",
      },
      { role: "assistant", content: "Great, you're booked for 2pm on August 1st. Anything else?" },
      { role: "user", content: "Actually, can we move it to 4pm instead?" },
    ],
    expectedToolCalls: [{ name: "cancel_appointment" }],
  },
  {
    // The case above only checks that cancel_appointment gets called - it
    // never proves the model goes on to actually rebook the new time and
    // report it back, unassisted, in the same turn. This drives the same
    // "already booked, then asks to reschedule" transcript through the real
    // runConversationTurn loop and asserts the full cancel -> rebook -> confirm
    // chain, with no user input between the tool calls.
    name: "reschedule chain via runConversationTurn: cancels the old booking before booking and confirming the new time",
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
      {
        role: "tool",
        content: JSON.stringify({ booked: true, appointmentId: "appt_eval_1", calendarEventId: "evt_eval_1" }),
        toolName: "schedule_appointment",
      },
      { role: "assistant", content: "Great, you're booked for 2pm on August 1st. Anything else?" },
      { role: "user", content: "Actually, can we move it to 4pm instead?" },
    ],
    chain: {
      stubResults: {
        cancel_appointment: { canceled: true, appointmentId: "appt_eval_1" },
        check_appointment_availability: { available: true },
        schedule_appointment: { booked: true, appointmentId: "appt_chain_2", calendarEventId: "evt_chain_2" },
      },
      expectedOrder: ["cancel_appointment", "schedule_appointment"],
    },
    rubric:
      "The reply must confirm the appointment is now booked for 4pm on August 1st (not 2pm), be 1-3 sentences, " +
      "and must not state any detail that wasn't established in the conversation.",
  },
  {
    // Same "cancel before rebooking" instruction, for the follow-up/callback
    // pair (cancel_followup + schedule_followup) instead of the appointment
    // pair.
    name: "changing callback time cancels the old follow-up first",
    systemPrompt: SYSTEM_PROMPT,
    tools: ALL_TOOLS,
    messages: [
      { role: "user", content: "Can you call me back tomorrow at 10am to discuss pricing?" },
      {
        role: "assistant",
        content: "",
        toolName: "schedule_followup",
        toolArgs: { scheduledAt: "2026-08-02T14:00:00Z", reason: "discuss pricing" },
      },
      {
        role: "tool",
        content: JSON.stringify({ scheduled: true, followUpId: "followup_eval_1", scheduledAt: "2026-08-02T14:00:00Z" }),
        toolName: "schedule_followup",
      },
      { role: "assistant", content: "Sure, I'll call you back tomorrow at 10am. Anything else?" },
      { role: "user", content: "Actually, can you make it 2pm instead?" },
    ],
    expectedToolCalls: [{ name: "cancel_followup" }],
  },
  {
    // schedule_followup's own contract on a rejected time: it returns
    // scheduled: false plus a suggestedTime rather than writing anything.
    // SYSTEM_PROMPT's instruction is explicit and sequential - tell the
    // caller the suggested time and ask first, only retry once they
    // confirm - so this pre-seeds that ask+confirm exchange too, then
    // checks the retry actually reuses the exact suggestedTime the tool
    // gave rather than the model inventing its own adjusted time.
    name: "follow-up outside calling hours retries with the exact suggested time after confirming",
    systemPrompt: SYSTEM_PROMPT,
    tools: ALL_TOOLS,
    messages: [
      { role: "user", content: "Can you call me back tonight at 11pm to talk about pricing?" },
      {
        role: "assistant",
        content: "",
        toolName: "schedule_followup",
        toolArgs: { scheduledAt: "2026-08-03T03:00:00Z", reason: "discuss pricing" },
      },
      {
        role: "tool",
        content: JSON.stringify({
          scheduled: false,
          reason: "Requested time is outside the legal calling window (8am-9pm local to this number)",
          suggestedTime: "2026-08-03T12:00:00Z",
        }),
        toolName: "schedule_followup",
      },
      { role: "assistant", content: "I can only call between 8am and 9pm your time - would 8am tomorrow work instead?" },
      { role: "user", content: "Yes, that works." },
    ],
    expectedToolCalls: [{ name: "schedule_followup", args: { scheduledAt: "2026-08-03T12:00:00Z" } }],
  },
  {
    // Parallels the schedule_appointment confirmation case above, for
    // schedule_followup's own success path.
    name: "confirmed follow-up reply states the callback time",
    systemPrompt: SYSTEM_PROMPT,
    tools: ALL_TOOLS,
    messages: [
      { role: "user", content: "Can you call me back tomorrow at 10am to discuss pricing?" },
      {
        role: "assistant",
        content: "",
        toolName: "schedule_followup",
        toolArgs: { scheduledAt: "2026-08-02T14:00:00Z", reason: "discuss pricing" },
      },
      {
        role: "tool",
        content: JSON.stringify({ scheduled: true, followUpId: "followup_eval_2", scheduledAt: "2026-08-02T14:00:00Z" }),
        toolName: "schedule_followup",
      },
    ],
    rubric:
      "The reply must confirm the callback is scheduled and state the specific day/time (tomorrow at 10am, or " +
      "the equivalent time), be 1-3 sentences, and must not invent any detail that wasn't in the tool result above.",
  },
  {
    // OBJECTION_HANDLING_BASELINE: a neutral/mildly negative objection
    // should get a genuine rebuttal, not a brush-off or an immediate retreat
    // - that reaction is reserved for very_negative sentiment (see the
    // "drops the sales pitch" case above, which is the contrasting case).
    name: "price objection with neutral sentiment gets a real rebuttal, not a brush-off",
    systemPrompt: SYSTEM_PROMPT,
    tools: ALL_TOOLS,
    messages: [{ role: "user", content: "Honestly this all sounds pretty expensive, I'm not sure it's worth it." }],
    rubric:
      "The reply must briefly acknowledge the caller's price concern, must not invent any specific price, " +
      "discount, or guarantee, and must not immediately try to end the call or abandon the conversation - it " +
      "should offer a genuine, substantive response (e.g. highlighting value or offering a follow-up with " +
      "specifics) rather than an evasive brush-off.",
  },
  {
    name: "mild frustration records a sentiment shift",
    systemPrompt: SYSTEM_PROMPT,
    tools: ALL_TOOLS,
    messages: [{ role: "user", content: "This is kind of annoying, I've already told you I'm not interested." }],
    // Name-only, not an exact enum value - "negative" vs "very_negative" is
    // a judgment call this phrasing doesn't pin down, and isn't the point;
    // the point is that a shift gets recorded at all.
    expectedToolCalls: [{ name: "record_sentiment" }],
  },
];

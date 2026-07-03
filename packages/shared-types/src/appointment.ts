export type AppointmentStatus = "SCHEDULED" | "CONFIRMED" | "CANCELED" | "COMPLETED";

export interface Appointment {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  googleEventId: string | null;
  notes: string | null;
  leadId: string | null;
  callId: string | null;
  createdAt: string;
  updatedAt: string;
}

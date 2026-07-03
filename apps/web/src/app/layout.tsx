import type { ReactNode } from "react";

export const metadata = {
  title: "Telephony Admin",
  description: "Admin panel for the Telephony voice calling platform",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  );
}

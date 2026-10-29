import { describe, expect, it } from "vitest";
import { parseInvites } from "../../src/calendar/invite.js";
import { calendarEmail } from "../fixtures/calendar/load.js";

const ZONE = "Asia/Ho_Chi_Minh";
const invite = async (name: string) =>
  parseInvites((await calendarEmail(name)).calendarParts, ZONE);

describe("calendar invitations (FR-114)", () => {
  it("reads a Google invite with its Meet link", async () => {
    expect(await invite("google-invite")).toEqual([
      {
        title: "Design review",
        status: "new",
        source: "invitation",
        timeSet: true,
        start: "2026-11-05T08:00:00.000Z",
        end: "2026-11-05T09:00:00.000Z",
        allDay: false,
        timezone: "UTC",
        location: "Room 3A",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
      },
    ]);
  });

  it("resolves Outlook's Windows zone names from the VTIMEZONE", async () => {
    const [e] = await invite("outlook-invite-windows-tz");
    expect(e).toMatchObject({
      start: "2026-11-06T07:00:00.000Z",
      end: "2026-11-06T07:45:00.000Z",
      timezone: ZONE,
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc",
    });
  });

  it("marks cancellations and updates", async () => {
    expect((await invite("cancel"))[0]!.status).toBe("cancelled");
    expect((await invite("rescheduled"))[0]!.status).toBe("rescheduled");
  });

  it("reads all-day and multi-day events", async () => {
    expect((await invite("all-day-invite"))[0]).toMatchObject({
      allDay: true,
      start: "2026-11-10",
      end: "2026-11-12",
    });
  });

  it("keeps a named .ics in the attachment list and finds no parts in plain mail", async () => {
    expect((await calendarEmail("google-invite")).attachments).toEqual(["invite.ics"]);
    expect((await calendarEmail("meeting-teams")).calendarParts).toEqual([]);
  });

  it("throws on a part that is not iCalendar", () => {
    expect(() => parseInvites(["not a calendar"], ZONE)).toThrow();
  });
});

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// Exercise the actual submit payload builder with form values, including the
// JSON round trip that drops undefined fields. Mock only unrelated helpers.
const source = readFileSync(new URL("../src/public/calendar-app.js", import.meta.url), "utf8");
const submit = source.slice(source.indexOf('$("#form-event").addEventListener("submit"'));
const builder = /    const body = \{[\s\S]*?\n    \};\n    \/\/ Conflict check/.exec(submit)?.[0];
if (!builder) throw new Error("Event submit payload builder was not found");
function payload(data: Record<string, string>) {
  return JSON.parse(vm.runInNewContext(`${builder}\nJSON.stringify(body)`, {
    data,
    id: data.id,
    isAllDay: false,
    startsIso: "2026-11-16T09:00:00Z",
    endsIso: "2026-11-16T10:00:00Z",
    attendees: [],
    collectAlarms: () => null,
  }) as string);
}

describe("event form clearing fields", () => {
  it("sends empty editable text for an existing event so the server clears it", () => {
    const body = payload({ id: "event-id", calendarId: "cal-id", summary: "Meeting", location: "", description: "", rrule: "" });
    expect(body).toMatchObject({ location: "", description: "", rrule: "" });
    expect(body.extra).toMatchObject({ url: null, meetingPassword: null, attendees: null, alarms: null });
  });

  it("new events may omit optional blank text because there is no previous value", () => {
    const body = payload({ calendarId: "cal-id", summary: "Meeting", location: "", description: "" });
    expect(body).not.toHaveProperty("location");
    expect(body).not.toHaveProperty("description");
  });

  it("keeps entered location and multiline notes unchanged", () => {
    const body = payload({ id: "event-id", summary: "Meeting", location: "Room 3", description: "First line\nSecond line" });
    expect(body.location).toBe("Room 3");
    expect(body.description).toBe("First line\nSecond line");
  });
});

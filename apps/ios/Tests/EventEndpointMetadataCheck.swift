import Foundation

// Uses Models.swift and the Foundation-only PendingOpLogic helpers from
// OfflineSync.swift. Exercises cached and offline event metadata, not networking.
@main struct EventEndpointMetadataCheck {
    static func main() throws {
        let fixture = Data("""
        {"id":"journey","calendarId":"c1","summary":"Flight","startsAt":"2026-11-28T12:00:00Z","endsAt":"2026-11-28T21:00:00Z","allDay":false,"extra":{"timezone":"Australia/Melbourne","endTimezone":"Asia/Shanghai"}}
        """.utf8)
        let trip = try JSONDecoder.iso().decode(EventDTO.self, from: fixture)
        precondition(trip.extra?.timezone == "Australia/Melbourne")
        precondition(trip.extra?.endTimezone == "Asia/Shanghai")
        precondition(trip.endsAt.timeIntervalSince(trip.startsAt) == 9 * 3600)
        let cached = PendingOpLogic.decodeSnapshot(PendingOpLogic.encodeSnapshot([trip]))!
        precondition(cached == [trip])
        let oldEdit = PendingOpLogic.applyingUpdate(trip, payloadJson: #"{"summary":"Updated","extra":{"category":"travel"}}"#, timeFields: true)
        precondition(oldEdit.extra?.endTimezone == "Asia/Shanghai")
        let cleared = PendingOpLogic.applyingUpdate(trip, payloadJson: #"{"extra":{"endTimezone":null}}"#, timeFields: true)
        precondition(cleared.extra?.endTimezone == nil && cleared.extra?.timezone == "Australia/Melbourne")
        precondition(cleared.startsAt == trip.startsAt && cleared.endsAt == trip.endsAt)
        let allCleared = PendingOpLogic.applyingUpdate(trip, payloadJson: #"{"extra":null}"#, timeFields: true)
        precondition(allCleared.extra == nil)
        let changed = PendingOpLogic.applyingUpdate(trip, payloadJson: #"{"extra":{"endTimezone":"Asia/Tokyo"}}"#, timeFields: true)
        precondition(changed.extra?.endTimezone == "Asia/Tokyo" && changed.extra?.timezone == "Australia/Melbourne")
        precondition(changed.startsAt == trip.startsAt && changed.endsAt == trip.endsAt)
        let oldJSON = String(data: fixture, encoding: .utf8)!.replacingOccurrences(of: ",\"endTimezone\":\"Asia/Shanghai\"", with: "")
        let legacy = try JSONDecoder.iso().decode(EventDTO.self, from: Data(oldJSON.utf8))
        precondition(legacy.extra?.endTimezone == nil)
        let zones = EventEditorDates.endpointTimeZones(start: legacy.extra?.timezone, end: legacy.extra?.endTimezone, calendar: "UTC", device: TimeZone(identifier: "Asia/Shanghai")!)
        precondition(zones.start.identifier == "Australia/Melbourne" && zones.end == zones.start)
        var payload = EventExtra(timezone: .unmanaged, attendees: .unmanaged, category: .unmanaged, url: .unmanaged, meetingPassword: .unmanaged, alarms: .unmanaged)
        func object() throws -> [String: Any] { try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as! [String: Any] }
        let omitted = try object()
        precondition(omitted.isEmpty)
        payload.endTimezone = .value("Asia/Shanghai")
        let set = try object()
        precondition(set["endTimezone"] as? String == "Asia/Shanghai")
        payload.endTimezone = .cleared
        let removed = try object()
        precondition(removed["endTimezone"] is NSNull)
        let local = PendingOpLogic.localDTO(forCreateBody: fixture, tempId: "local:journey")!
        precondition(local.id == "local:journey" && local.extra?.endTimezone == "Asia/Shanghai")
        print("Event endpoint metadata: DTO/cache/create/PATCH omission and explicit clears passed")
    }
}

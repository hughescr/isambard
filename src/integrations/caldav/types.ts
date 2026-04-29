/**
 * Calendar info returned from CalDAV server discovery.
 */
export interface CalendarInfo {
    path:         string
    displayName:  string
    color?:       string
    description?: string
}

/**
 * Normalized calendar event.
 */
export interface CalendarEvent {
    uid:           string
    summary:       string
    start:         Date
    end:           Date
    location?:     string
    description?:  string
    attendees?:    string[]
    isAllDay:      boolean
    calendarLabel: string    // Which calendar this came from
    status?:       'confirmed' | 'tentative' | 'cancelled'
    recurrenceId?: string    // For recurring event instances
    timezone?:     string    // IANA timezone from the calendar source (e.g. 'America/New_York'); undefined for floating/all-day events
}

/**
 * A recurring event that could not be expanded (e.g. malformed RRULE).
 */
export interface FailedCalendarEvent {
    uid:    string
    reason: string
    rrule?: string
}

/**
 * Result of fetching calendar events.
 * `events` contains successfully parsed events; `failed` contains events that
 * could not be expanded (e.g. malformed RRULE) — never silently dropped.
 */
export interface CalendarEventsResult {
    events: CalendarEvent[]
    failed: FailedCalendarEvent[]
}

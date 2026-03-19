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
}

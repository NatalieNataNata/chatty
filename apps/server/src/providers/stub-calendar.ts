import type { CalendarProvider } from '../types.js'

export class StubCalendarProvider implements CalendarProvider {
  async getTodaySummary(): Promise<string> {
    return 'There is a project review this afternoon; the evening is open for music and winding down.'
  }
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * The one line of "now" the model is given. It is rebuilt for every send, so
 * it is never stale for the message it rides with, and it comes from the
 * webview clock — the machine's own, so the time is local to wherever BELEN
 * runs. The model has no clock of its own; without this line it can only say
 * it does not know the time.
 */
export function clockLine(now: Date = new Date()): string {
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  const zone = `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return (
    `Today is ${DAYS[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]} ` +
    `${now.getFullYear()}. The local time on the user's computer is ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())} (${zone}).`
  )
}

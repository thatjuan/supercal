/** Dates as the dashboard shows them, in the browser's locale; `empty` stands in for null. */
const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const moment = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const formatDate = (iso: string | null, empty = '—') => (iso ? day.format(new Date(iso)) : empty);
export const formatDateTime = (iso: string) => moment.format(new Date(iso));

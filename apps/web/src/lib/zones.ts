/** The time zones the dashboard offers: this browser's first, then UTC, then every other IANA zone. */
import { Temporal } from '@js-temporal/polyfill';

export const browserZone = Temporal.Now.timeZoneId();
export const ZONES = [...new Set([browserZone, 'UTC', ...Intl.supportedValuesOf('timeZone')])];

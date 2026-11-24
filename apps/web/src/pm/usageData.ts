// t3code-pm: PM3code builds send no usage data unless the user sets up their own key and host
// (apps/server/src/telemetry/AnalyticsService.ts), so the app neither says it collects any nor
// offers T3's privacy policy as its own.
export const PM_COLLECTS_USAGE_DATA = false;

// t3code-pm: PM3code sends no usage data and nothing turns it on
// (apps/server/src/telemetry/AnalyticsService.ts), so the app neither says it collects any nor
// offers T3's privacy policy as its own.
export const PM_COLLECTS_USAGE_DATA = false;

// t3code-pm: PM3code exports nothing over OpenTelemetry
// (packages/shared/src/otelEnvironment.ts), so Settings offers no export section.
export const PM_OFFERS_OTLP_EXPORT = false;

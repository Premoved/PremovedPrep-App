// Nothing sends these events today; see AnalyticsService, which is a no-op by design.
export const AnalyticsEvent = {
	pageView: '$pageview',
	userRegistered: 'user_registered',
	userSignedIn: 'user_signed_in',
	userSignedOut: 'user_signed_out',
	opponentSearch: 'opponent_search',
	advancedReportViewed: 'advanced_report_viewed',
	storageQuotaReached: 'storage_quota_reached',
	storageWriteRefused: 'storage_write_refused',
	tablebaseProbe: 'tablebase_probe',
} as const;

export type AnalyticsEventName = (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent];

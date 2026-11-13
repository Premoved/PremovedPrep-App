/// <reference lib="webworker" />

import { ReportAnswer, ReportInput, buildReport } from './report-build';

addEventListener('message', ({ data }: MessageEvent<ReportInput>) => {
	let answer: ReportAnswer;
	try {
		answer = { ok: true, report: buildReport(data) };
	} catch (error) {
		answer = { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
	postMessage(answer);
});

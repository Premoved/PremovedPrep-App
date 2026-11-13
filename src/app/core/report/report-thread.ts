import { Observable } from 'rxjs';
import { AdvancedReport } from '../models/report.model';
import { ReportAnswer, ReportInput, buildReport } from './report-build';

/**
 * Builds the report in a Web Worker so the page keeps responding; in place where there are no
 * workers (tests) or one cannot be used. Unsubscribing before the answer stops the build.
 */
export function buildReportOffThread(input: ReportInput): Observable<AdvancedReport> {
	return new Observable<AdvancedReport>((subscriber) => {
		const inPlace = (): void => {
			try {
				subscriber.next(buildReport(input));
				subscriber.complete();
			} catch (error) {
				subscriber.error(error);
			}
		};

		if (typeof Worker === 'undefined') {
			inPlace();
			return undefined;
		}

		let worker: Worker;
		try {
			worker = new Worker(new URL('./report.worker', import.meta.url), { type: 'module' });
		} catch {
			inPlace();
			return undefined;
		}

		worker.onmessage = ({ data }: MessageEvent<ReportAnswer>) => {
			worker.terminate();
			if (data.ok) {
				subscriber.next(data.report);
				subscriber.complete();
			} else {
				subscriber.error(new Error(data.message));
			}
		};
		// Only a worker that could not start gets here: build errors come back as a message.
		worker.onerror = (event) => {
			event.preventDefault();
			worker.terminate();
			inPlace();
		};

		try {
			worker.postMessage(input);
		} catch {
			worker.terminate();
			inPlace();
			return undefined;
		}

		return () => worker.terminate();
	});
}

import { DOCUMENT, inject, Injectable } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

const SITE = 'PremovedPrep';
const ORIGIN = 'https://premovedprep.com';

const FALLBACK_DESCRIPTION =
	'A chess analysis tool for tournament preparation, building organized repertoires, studying opponents and exploring database games.';

// The SPA shell sets index.html's title and canonical link once; this keeps them in step with the route.
@Injectable({ providedIn: 'root' })
export class SeoService {
	private readonly router = inject(Router);
	private readonly route = inject(ActivatedRoute);
	private readonly title = inject(Title);
	private readonly meta = inject(Meta);
	private readonly document = inject(DOCUMENT);

	start(): void {
		this.router.events.pipe(filter((event) => event instanceof NavigationEnd)).subscribe(() => {
			const data = this.deepest().snapshot.data;
			this.apply(
				typeof data['title'] === 'string' ? data['title'] : null,
				typeof data['description'] === 'string' ? data['description'] : null,
			);
		});
	}

	/** Overrides the server-rendered tags after Angular hydrates; the next navigation resets them. */
	describe(pageTitle: string, description: string, canonicalPath?: string): void {
		this.apply(pageTitle, description, canonicalPath);
	}

	private apply(pageTitle: string | null, description: string | null, canonicalPath?: string): void {
		const full = pageTitle ? `${pageTitle} - ${SITE}` : SITE;
		const text = description ?? FALLBACK_DESCRIPTION;

		this.title.setTitle(full);
		this.meta.updateTag({ name: 'description', content: text });
		this.meta.updateTag({ property: 'og:title', content: full });
		this.meta.updateTag({ property: 'og:description', content: text });
		this.meta.updateTag({ name: 'twitter:title', content: full });
		this.meta.updateTag({ name: 'twitter:description', content: text });

		// Query params dropped on purpose: e.g. ?color=b is a toggle on the same page, not a new one.
		const canonical = ORIGIN + (canonicalPath ?? this.router.url.split('?')[0].split('#')[0]);
		this.meta.updateTag({ property: 'og:url', content: canonical });

		let link = this.document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
		if (!link) {
			link = this.document.createElement('link');
			link.setAttribute('rel', 'canonical');
			this.document.head.appendChild(link);
		}
		link.setAttribute('href', canonical);
	}

	/** The innermost activated route, which is the one whose data describes the page. */
	private deepest(): ActivatedRoute {
		let route = this.route;
		while (route.firstChild) {
			route = route.firstChild;
		}
		return route;
	}
}

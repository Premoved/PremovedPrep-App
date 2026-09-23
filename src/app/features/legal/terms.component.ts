import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Static text; the publication date in the template must match AccountService.TERMS_VERSION. */
@Component({
	selector: 'app-terms',
	standalone: true,
	imports: [RouterLink],
	templateUrl: './terms.component.html',
	styleUrl: './legal-page.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TermsComponent {}

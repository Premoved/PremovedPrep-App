import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Static text; the publication date in the template must match AccountService.TERMS_VERSION. */
@Component({
	selector: 'app-privacy',
	standalone: true,
	imports: [RouterLink],
	templateUrl: './privacy.component.html',
	styleUrl: './legal-page.scss',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PrivacyComponent {}

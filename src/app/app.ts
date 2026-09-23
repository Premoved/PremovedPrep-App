import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LongPressService } from './core/browser/long-press';
import { SeoService } from './core/seo/seo.service';
import { CollectionMirrorService } from './core/sync/collection-mirror.service';
import { UpdateService } from './core/shell/update.service';
import { NoticeBarComponent } from './shared/notice-bar/notice-bar.component';

@Component({
	selector: 'app-root',
	standalone: true,
	imports: [RouterOutlet, NoticeBarComponent],
	templateUrl: './app.html',
})
export class App {
	// Injected for construction's side effects; these fields are otherwise unused.
	private readonly longPress = inject(LongPressService);

	private readonly seo = inject(SeoService);

	private readonly mirror = inject(CollectionMirrorService);

	private readonly updates = inject(UpdateService);

	constructor() {
		this.seo.start();
		this.updates.start();
	}
}

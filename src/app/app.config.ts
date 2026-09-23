import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideAppInitializer, inject } from '@angular/core';
import {
	PreloadAllModules,
	RouteReuseStrategy,
	provideRouter,
	withComponentInputBinding,
	withPreloading,
} from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';

import { routes } from './app.routes';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { errorInterceptor } from './core/interceptors/error.interceptor';
import { AuthService } from './core/services/auth.service';
import { ThemeService } from './core/services/theme.service';
import { PreferencesStore } from './core/services/preferences.store';
import { AgentBridgeService } from './core/agent/agent-bridge.service';
import { MoveSoundService } from './core/sound/move-sound.service';
import { AnalyticsService } from './core/analytics/analytics.service';
import { DesktopService } from './core/shell/desktop.service';
import { TabsStore } from './core/tabs/tabs.store';
import { TabRouteReuseStrategy } from './core/tabs/tab-route-reuse.strategy';

export const appConfig: ApplicationConfig = {
	providers: [
		provideBrowserGlobalErrorListeners(),
		provideRouter(routes, withComponentInputBinding(), withPreloading(PreloadAllModules)),
		// errorInterceptor outermost: authInterceptor must see the mapped ApiError, not a raw 401.
		provideHttpClient(withInterceptors([errorInterceptor, authInterceptor])),

		// Built by hand, not useClass: the store must not itself depend on the Router this provides.
		{ provide: RouteReuseStrategy, useFactory: () => new TabRouteReuseStrategy(inject(TabsStore)) },

		provideAppInitializer(() => {
			inject(ThemeService).init();
			const prefs = inject(PreferencesStore);
			prefs.init();
			const sounds = inject(MoveSoundService);
			void sounds.load();
			sounds.primeOnFirstGesture(() => prefs.sound());
			inject(AgentBridgeService);
			inject(AnalyticsService).init();
			const desktop = inject(DesktopService);
			desktop.init();
			inject(TabsStore).init(desktop.isDesktop());
			return inject(AuthService).restoreSession();
		}),
	],
};

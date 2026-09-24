import { Routes } from '@angular/router';
import { HomeComponent } from './features/home/home.component';
import { unsavedChangesGuard } from './core/guards/unsaved-changes.guard';
import { MainLayoutComponent } from './layout/main-layout/main-layout.component';

export const routes: Routes = [
	{
		path: 'login',
		loadComponent: () => import('./features/auth/login.component').then((m) => m.LoginComponent),
		data: { title: 'Sign in' },
	},
	{
		path: 'register',
		loadComponent: () => import('./features/auth/register.component').then((m) => m.RegisterComponent),
		data: { title: 'Create an account' },
	},

	{
		path: 'forgot-password',
		loadComponent: () => import('./features/auth/forgot-password.component').then((m) => m.ForgotPasswordComponent),
	},
	{
		path: 'reset-password',
		loadComponent: () => import('./features/auth/reset-password.component').then((m) => m.ResetPasswordComponent),
	},
	{
		path: 'verify-email',
		loadComponent: () => import('./features/auth/verify-email.component').then((m) => m.VerifyEmailComponent),
	},
	{
		path: '',
		component: MainLayoutComponent,
		children: [
			{ path: '', pathMatch: 'full', redirectTo: 'home' },
			{
				path: 'home',
				component: HomeComponent,
				data: {
					description:
						'Prepare for your next opponent: search a FIDE player, see every game the archive holds, and build your repertoire around what they actually play.',
				},
			},
			{ path: 'menu', pathMatch: 'full', redirectTo: 'home' },
			{
				path: 'analysis',
				loadComponent: () =>
					import('./features/analysis-board/analysis-board.component').then((m) => m.AnalysisBoardComponent),
				canDeactivate: [unsavedChangesGuard],
				data: {
					title: 'Analysis Board',
					description:
						'An analysis board with an engine, an opening tree over the game archive, and repertoire tools. Paste a PGN or a FEN and start from any position.',
				},
			},
			{
				path: 'library',
				children: [
					{
						path: '',
						loadComponent: () =>
							import('./features/collections/collections-page.component').then((m) => m.CollectionsPageComponent),
						data: {
							kind: 'LIBRARY',
							title: 'Library',
							description: 'A place for keeping ideas and studies organized.',
						},
					},
					{
						path: 'c/:id',
						loadComponent: () =>
							import('./features/collections/collection-view.component').then((m) => m.CollectionViewComponent),
						data: { kind: 'LIBRARY' },
					},
					{
						path: 'local/:id',
						loadComponent: () =>
							import('./features/collections/local-collection-view.component').then(
								(m) => m.LocalCollectionViewComponent,
							),
						data: { kind: 'LIBRARY' },
					},
				],
			},
			{
				path: 'repertoire',
				children: [
					{
						path: '',
						loadComponent: () =>
							import('./features/collections/collections-page.component').then((m) => m.CollectionsPageComponent),
						data: {
							kind: 'REPERTOIRE',
							title: 'Repertoire',
							description: 'A place for keeping opening ideas and preparation.',
						},
					},
					{
						path: 'c/:id',
						loadComponent: () =>
							import('./features/collections/collection-view.component').then((m) => m.CollectionViewComponent),
						data: { kind: 'REPERTOIRE' },
					},
					{
						path: 'local/:id',
						loadComponent: () =>
							import('./features/collections/local-collection-view.component').then(
								(m) => m.LocalCollectionViewComponent,
							),
						data: { kind: 'REPERTOIRE' },
					},
				],
			},
			// Before the bare 'search' route, so the longer path is tried first.
			{
				path: 'search/opponent/:slug',
				loadComponent: () => import('./features/search/search-page.component').then((m) => m.SearchPageComponent),
				data: {
					title: 'Database Search',
					description:
						'Search the game archive by opponent or by position: every game a FIDE player has in the database, their openings by colour, and the lines they repeat.',
				},
			},
			{
				path: 'search',
				loadComponent: () => import('./features/search/search-page.component').then((m) => m.SearchPageComponent),
				data: {
					title: 'Database Search',
					description:
						'Search the game archive by opponent or by position: every game a FIDE player has in the database, their openings by colour, and the lines they repeat.',
				},
			},
			{
				path: 'resources',
				loadComponent: () => import('./features/agent/agent-page.component').then((m) => m.AgentPageComponent),
				data: {
					title: 'Local Resources',
					description:
						'Choose a root folder for saving files on this computer, index your own local databases, and add any local engine.',
				},
			},
			{
				path: 'plan',
				loadComponent: () => import('./features/plan/plan-page.component').then((m) => m.PlanPageComponent),
				data: { title: 'Subscription Plan' },
			},
			{
				path: 'settings',
				loadComponent: () => import('./features/settings/settings-page.component').then((m) => m.SettingsPageComponent),
				data: { title: 'Settings' },
			},

			{
				path: 'terms',
				loadComponent: () => import('./features/legal/terms.component').then((m) => m.TermsComponent),
				data: { title: 'Terms of service' },
			},
			{
				path: 'privacy',
				loadComponent: () => import('./features/legal/privacy.component').then((m) => m.PrivacyComponent),
				data: { title: 'Privacy policy' },
			},
			{
				path: 'third-party',
				loadComponent: () => import('./features/legal/third-party.component').then((m) => m.ThirdPartyComponent),
				data: { title: 'Third-party material' },
			},
		],
	},
	{ path: '**', redirectTo: 'home' },
];

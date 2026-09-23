export const environment = {
	production: false,
	// ng serve only; the packaged app uses environment.prod.ts, where the API is same-origin.
	apiBaseUrl: `${location.protocol}//${location.hostname}:8080/api`,
	sourceCodeUrl: 'https://github.com/Premoved/PremovedPrep-App',
	contactEmail: 'contact@premoved.com',
};

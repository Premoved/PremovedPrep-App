// The browser decides whether a field is valid; this only words the reason, in English, the way
// Chrome does. A browser's own validationMessage follows the browser's language, not the page's,
// and Firefox for Android never shows it at all (Mozilla bug 1510450).

export type ValidatedField = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export function isValidatedField(element: Element): element is ValidatedField {
	return (
		element instanceof HTMLInputElement ||
		element instanceof HTMLTextAreaElement ||
		element instanceof HTMLSelectElement
	);
}

export function validationMessageFor(field: ValidatedField): string {
	const validity = field.validity;
	const type = field instanceof HTMLInputElement ? field.type : field.tagName.toLowerCase();

	// Set by this application through setCustomValidity, so already its own wording.
	if (validity.customError) {
		return field.validationMessage;
	}
	if (validity.valueMissing) {
		return missingMessage(type);
	}
	if (validity.typeMismatch) {
		return type === 'email' ? emailMessage(field.value) : type === 'url' ? 'Please enter a URL.' : GENERIC;
	}
	if (validity.badInput) {
		return type === 'number' ? 'Please enter a number.' : 'Please enter a valid value.';
	}
	if (validity.tooShort && 'minLength' in field) {
		return `Please lengthen this text to ${characters(field.minLength)} or more (you are currently using ${characters(field.value.length)}).`;
	}
	if (validity.tooLong && 'maxLength' in field) {
		return `Please shorten this text to ${characters(field.maxLength)} or less (you are currently using ${characters(field.value.length)}).`;
	}
	if (validity.patternMismatch) {
		const title = field.getAttribute('title')?.trim();
		return title ? `Please match the requested format.\n${title}` : 'Please match the requested format.';
	}
	if (validity.rangeUnderflow && field instanceof HTMLInputElement) {
		return `Value must be greater than or equal to ${field.min}.`;
	}
	if (validity.rangeOverflow && field instanceof HTMLInputElement) {
		return `Value must be less than or equal to ${field.max}.`;
	}
	if (validity.stepMismatch) {
		return 'Please enter a valid value.';
	}
	return GENERIC;
}

const GENERIC = 'Please enter a valid value.';

function missingMessage(type: string): string {
	switch (type) {
		case 'checkbox':
			return 'Please check this box if you want to proceed.';
		case 'radio':
			return 'Please select one of these options.';
		case 'select':
			return 'Please select an item in the list.';
		case 'file':
			return 'Please select a file.';
		default:
			return 'Please fill out this field.';
	}
}

function characters(count: number): string {
	return count === 1 ? '1 character' : `${count} characters`;
}

// The HTML definition of a valid email address, split where Chrome splits it to explain itself.
const LOCAL_CHARACTER = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]/;
const DOMAIN_CHARACTER = /[a-zA-Z0-9.-]/;

function emailMessage(raw: string): string {
	const value = raw.trim();
	const at = value.indexOf('@');
	if (at < 0) {
		return `Please include an '@' in the email address. '${value}' is missing an '@'.`;
	}

	const local = value.slice(0, at);
	const domain = value.slice(at + 1);
	if (local.length === 0) {
		return `Please enter a part followed by '@'. '${value}' is incomplete.`;
	}
	if (domain.length === 0) {
		return `Please enter a part following '@'. '${value}' is incomplete.`;
	}

	const badLocal = [...local].find((character) => !LOCAL_CHARACTER.test(character));
	if (badLocal !== undefined) {
		return `A part followed by '@' should not contain the symbol '${badLocal}'.`;
	}
	const badDomain = [...domain].find((character) => !DOMAIN_CHARACTER.test(character));
	if (badDomain !== undefined) {
		return `A part following '@' should not contain the symbol '${badDomain}'.`;
	}
	if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
		return `'.' is used at a wrong position in '${domain}'.`;
	}
	return 'Please enter an email address.';
}

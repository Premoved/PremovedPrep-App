import { afterEach, describe, expect, it } from 'vitest';
import { validationMessageFor } from './validation-message';
import { hideValidationBubble, showValidationBubble } from './validation-bubble';

function field(attributes: Record<string, string>, value = ''): HTMLInputElement {
	const input = document.createElement('input');
	for (const [name, content] of Object.entries(attributes)) input.setAttribute(name, content);
	input.value = value;
	document.body.appendChild(input);
	return input;
}

afterEach(() => {
	hideValidationBubble();
	document.body.innerHTML = '';
});

describe('validationMessageFor', () => {
	it('words a missing value the way Chrome does', () => {
		expect(validationMessageFor(field({ type: 'email', required: '' }))).toBe('Please fill out this field.');
		expect(validationMessageFor(field({ type: 'checkbox', required: '' }))).toBe(
			'Please check this box if you want to proceed.',
		);
	});

	it.each([
		['username', "Please include an '@' in the email address. 'username' is missing an '@'."],
		['@x.ro', "Please enter a part followed by '@'. '@x.ro' is incomplete."],
		['ion@', "Please enter a part following '@'. 'ion@' is incomplete."],
		['i(on@x.ro', "A part followed by '@' should not contain the symbol '('."],
		['ion@x_y.ro', "A part following '@' should not contain the symbol '_'."],
		['ion@a@b.ro', "A part following '@' should not contain the symbol '@'."],
		['ion@x..ro', "'.' is used at a wrong position in 'x..ro'."],
	])('explains why %s is not an email address', (value, message) => {
		expect(validationMessageFor(field({ type: 'email' }, value))).toBe(message);
	});

	it('passes a custom message through unchanged', () => {
		const input = field({ type: 'text' });
		input.setCustomValidity('That username is taken.');
		expect(validationMessageFor(input)).toBe('That username is taken.');
	});
});

describe('showValidationBubble', () => {
	it('shows one bubble, marks the field, and hides when the field is edited', () => {
		const input = field({ type: 'email' }, 'username');
		// jsdom lays nothing out, and a field with no size has nothing to point at.
		input.getBoundingClientRect = () => new DOMRect(20, 20, 300, 36);
		showValidationBubble(input, 'first');
		showValidationBubble(input, 'second');

		const bubbles = document.querySelectorAll('.validation-bubble');
		expect(bubbles.length).toBe(1);
		expect(bubbles[0].textContent).toBe('!second');
		expect(bubbles[0].getAttribute('role')).toBe('alert');
		expect(input.getAttribute('aria-invalid')).toBe('true');

		input.dispatchEvent(new Event('input'));
		expect(document.querySelector('.validation-bubble')).toBeNull();
		expect(input.hasAttribute('aria-invalid')).toBe(false);
	});
});

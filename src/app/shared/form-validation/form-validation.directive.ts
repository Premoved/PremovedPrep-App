import { Directive, ElementRef, OnDestroy, OnInit, inject } from '@angular/core';
import { hideValidationBubble, hideValidationBubbleWithin, showValidationBubble } from './validation-bubble';
import { isValidatedField, validationMessageFor } from './validation-message';

// Every form validates the same way in every browser: the browser still decides what is valid
// (required, type="email", minlength...), but the form is novalidate and the message is ours.
// Left to the browser, Firefox for Android blocks the submit and says nothing at all, and Chrome
// speaks the browser's language rather than the page's.
@Directive({
	// eslint-disable-next-line @angular-eslint/directive-selector -- every form in a component that imports this, so none can forget it
	selector: 'form',
	standalone: true,
	host: { novalidate: '' },
})
export class FormValidationDirective implements OnInit, OnDestroy {
	private readonly form = inject<ElementRef<HTMLFormElement>>(ElementRef).nativeElement;

	// On the document, in the capture phase: it runs before any (submit) handler on the form itself,
	// whatever order Angular registered them in, and stopping it there means they never run.
	private readonly onSubmit = (event: Event): void => {
		if (event.target !== this.form) return;

		const invalid = Array.from(this.form.elements).find(
			(element) => isValidatedField(element) && element.willValidate && !element.validity.valid,
		);
		if (!invalid || !isValidatedField(invalid)) {
			hideValidationBubble();
			return;
		}

		event.preventDefault();
		event.stopImmediatePropagation();

		invalid.focus({ preventScroll: true });
		invalid.scrollIntoView({ block: 'nearest' });
		showValidationBubble(invalid, validationMessageFor(invalid));
	};

	ngOnInit(): void {
		document.addEventListener('submit', this.onSubmit, true);
	}

	ngOnDestroy(): void {
		document.removeEventListener('submit', this.onSubmit, true);
		hideValidationBubbleWithin(this.form);
	}
}

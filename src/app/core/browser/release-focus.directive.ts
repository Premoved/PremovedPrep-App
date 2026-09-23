import { Directive, HostListener } from '@angular/core';

@Directive({
	selector: '[appReleaseFocus]',
	standalone: true,
})
export class ReleaseFocusDirective {
	@HostListener('click', ['$event'])
	onClick(event: MouseEvent): void {
		if (event.detail === 0) {
			// Keyboard-triggered click (Enter/Space): keep the focus ring visible.
			return;
		}
		const control = (event.target as Element | null)?.closest('a, button');
		if (control instanceof HTMLElement) {
			control.blur();
		}
	}
}

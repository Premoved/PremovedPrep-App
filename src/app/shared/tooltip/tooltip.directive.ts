import { Directive, ElementRef, HostListener, OnDestroy, inject, input } from '@angular/core';

@Directive({
	selector: '[appTooltip]',
	standalone: true,
})
export class TooltipDirective implements OnDestroy {
	readonly appTooltip = input<string | null | undefined>();

	private readonly host = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
	private node: HTMLDivElement | null = null;
	private autoHide: ReturnType<typeof setTimeout> | null = null;

	// Long-press/right-click stand in for hover on touch devices, so the tooltip auto-hides on its own.
	@HostListener('contextmenu')
	showUntilTimeout(): void {
		this.show();
		if (!this.node) return;
		if (this.autoHide) clearTimeout(this.autoHide);
		this.autoHide = setTimeout(() => this.hide(), 2500);
	}

	@HostListener('mouseenter')
	@HostListener('focus')
	show(): void {
		const text = this.appTooltip()?.trim();
		if (!text) return;
		this.hide();

		const rect = this.host.getBoundingClientRect();
		const node = document.createElement('div');
		node.className = 'app-tooltip';
		node.textContent = text;
		node.style.left = `${rect.left + rect.width / 2}px`;
		node.style.top = `${rect.top - 8}px`;
		document.body.appendChild(node);
		this.node = node;
	}

	@HostListener('mouseleave')
	@HostListener('blur')
	@HostListener('click')
	hide(): void {
		if (this.autoHide) {
			clearTimeout(this.autoHide);
			this.autoHide = null;
		}
		this.node?.remove();
		this.node = null;
	}

	ngOnDestroy(): void {
		this.hide();
	}
}

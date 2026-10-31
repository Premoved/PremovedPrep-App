'use strict';

// Touch screens keep :hover on the last tapped element. Hover styles therefore apply only where a
// pointer can hover; the same declarations also apply as :active, so a press still shows them.
const HOVER = /:hover\b/;
const HOVER_ALL = /:hover\b/g;

const handled = new WeakSet();

function insideHoverQuery(node) {
	for (let parent = node.parent; parent; parent = parent.parent) {
		if (parent.type === 'atrule' && parent.name === 'media' && /\bhover\s*:/.test(parent.params)) {
			return true;
		}
	}
	return false;
}

function touchHover() {
	return {
		postcssPlugin: 'touch-hover',
		Rule(rule, { AtRule }) {
			if (handled.has(rule) || !HOVER.test(rule.selector) || insideHoverQuery(rule)) {
				return;
			}
			handled.add(rule);

			const hovered = rule.selectors.filter((selector) => HOVER.test(selector));
			const plain = rule.selectors.filter((selector) => !HOVER.test(selector));

			const query = new AtRule({ name: 'media', params: '(hover: hover)' });
			query.append(rule.clone({ selectors: hovered }));
			const pressed = rule.clone({ selectors: hovered.map((selector) => selector.replace(HOVER_ALL, ':active')) });
			handled.add(pressed);

			rule.after(pressed);
			rule.after(query);
			if (plain.length > 0) {
				rule.selectors = plain;
			} else {
				rule.remove();
			}
		},
	};
}

touchHover.postcss = true;

module.exports = touchHover;

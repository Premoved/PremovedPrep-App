import { randomBytes } from './base64url';

// Crockford's base32: no I, L, O or U, since those are confused with 1, 1, 0 when copying a code by
// hand, and U is dropped so the alphabet cannot accidentally spell a word.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// What a reader folds before looking a character up.
const CONFUSABLE: Readonly<Record<string, string>> = { I: '1', L: '1', O: '0', U: 'V' };

const LENGTH = 26;

const GROUP = 5;

export function newRecoveryCode(): string {
	const bytes = randomBytes(LENGTH);
	let code = '';
	for (let i = 0; i < LENGTH; i++) {
		// Masking to 5 bits is uniform over this 32-character alphabet; a modulo over the byte would
		// only be uniform by coincidence of this length and would silently bias a differently-sized one.
		code += ALPHABET[bytes[i] & 0x1f];
	}
	return group(code);
}

// Null when the input is not a code at all, so the reset screen can say so before spending time on
// a key derivation that was never going to work.
export function readRecoveryCode(typed: string): string | null {
	const stripped = typed
		.toUpperCase()
		.replace(/[\s-]/g, '')
		.split('')
		.map((character) => CONFUSABLE[character] ?? character)
		.join('');

	if (stripped.length !== LENGTH) {
		return null;
	}
	for (const character of stripped) {
		if (!ALPHABET.includes(character)) {
			return null;
		}
	}
	return stripped;
}

export function group(code: string): string {
	return (code.match(new RegExp(`.{1,${GROUP}}`, 'g')) ?? []).join('-');
}

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { powerSaveBlocker } = require('electron');

// Keeps the computer from going to sleep on its own while databases are busy; the screen may still turn off.
//
// On Windows, Electron's 'prevent-app-suspension' asks only for PowerRequestExecutionRequired, which
// does not keep a Modern Standby computer awake: when the screen turns off it goes to standby and
// Windows pauses the application. What does is a PowerRequestSystemRequired request. Node cannot call
// PowerSetRequest itself, so a small PowerShell process makes the request and holds it until it is
// stopped, or until the application ends and its input closes (a crash included).
// On battery, Windows still ends the request 5 minutes after the sleep timeout.

const REASON = 'PremovedPrep is indexing or copying a database';

// PowerCreateRequest with version 0 and flag 1 (a simple reason string); type 1 is PowerRequestSystemRequired.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace PremovedPrep -Name Power -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct ReasonContext { public uint Version; public uint Flags; public string SimpleReasonString; }
[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr PowerCreateRequest(ref ReasonContext context);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool PowerSetRequest(IntPtr request, int type);
'@
$context = New-Object PremovedPrep.Power+ReasonContext
$context.Version = 0
$context.Flags = 1
$context.SimpleReasonString = '${REASON}'
$request = [PremovedPrep.Power]::PowerCreateRequest([ref]$context)
if ($request -eq [IntPtr]::new(-1)) { exit 2 }
if (-not [PremovedPrep.Power]::PowerSetRequest($request, 1)) { exit 3 }
[Console]::Out.WriteLine('awake')
[void][Console]::In.ReadToEnd()
`;

const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

let helper = null;
let blocker = null;

function powershellPath() {
	return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Where the request cannot be made: macOS and Linux, where this is enough, or a Windows where the
// helper failed, where it is better than nothing.
function block() {
	if (blocker === null) {
		blocker = powerSaveBlocker.start('prevent-app-suspension');
	}
}

function unblock() {
	if (blocker !== null) {
		powerSaveBlocker.stop(blocker);
		blocker = null;
	}
}

function startHelper(log) {
	const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED], {
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
	});
	helper = child;
	let errors = '';

	child.stdout.on('data', (data) => {
		if (String(data).includes('awake')) {
			log('Windows keeps the computer awake (system required)');
		}
	});
	child.stderr.on('data', (data) => {
		errors += String(data);
	});
	// Its input closing while it ends is not a problem to report.
	child.stdin.on('error', () => {});

	const failed = (why) => {
		if (helper !== child) {
			return;
		}
		helper = null;
		log(`could not keep the computer awake through Windows (${why}); only Electron's lighter request is left`);
		block();
	};
	child.on('error', (error) => failed(error.message));
	child.on('exit', (code) => failed(`exit ${code}${errors ? `: ${errors.trim().split('\n')[0]}` : ''}`));
}

function stopHelper() {
	const child = helper;
	helper = null;
	if (child) {
		child.stdin.end();
		child.kill();
	}
}

function keepAwake(busy, log = () => {}) {
	if (!busy) {
		stopHelper();
		unblock();
	} else if (process.platform !== 'win32') {
		block();
	} else if (helper === null && blocker === null) {
		startHelper(log);
	}
}

module.exports = { keepAwake };

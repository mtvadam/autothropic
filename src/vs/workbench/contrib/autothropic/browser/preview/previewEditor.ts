/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { PREVIEW_EDITOR_ID, IPreviewService } from './preview.js';
import { PreviewEditorInput } from './previewEditorInput.js';
import { PreviewService } from './previewService.js';
import {
	getDevice, getDeviceOS, isModernIphone,
	IPHONES, ANDROID_PHONES, IPADS, LAPTOPS,
	ALL_PRESETS, DEFAULT_PREVIEW_CONFIG,
	type DeviceProfile, type PreviewConfig, type PreviewMode,
	type BrowserChromeType, type ChromeTheme, type IPhoneScreenType,
	type OsFrameType,
} from './devices.js';
import { buildBrowserChromeHtml } from './chromeBuilders.js';
import { buildOsFrameHtml, buildTaskbarHtml } from './osFrameBuilders.js';
import { createTrustedTypesPolicy } from '../../../../../base/browser/trustedTypes.js';

const _ttPolicy = createTrustedTypesPolicy('autothropicPreview', { createHTML: value => value });

const STORAGE_KEY_CONFIG = 'autothropic.preview.config';

export class PreviewEditor extends EditorPane {

	static readonly ID = PREVIEW_EDITOR_ID;

	private container!: HTMLElement;
	private toolbar!: HTMLElement;
	private previewArea!: HTMLElement;
	private webviewElement: Electron.WebviewTag | null = null;
	private debugOverlay: HTMLElement | null = null;
	private debugLogs: { level: string; text: string; time: string; src: string }[] = [];

	private config: PreviewConfig;
	private pageBackgroundColor = '';
	private detectedBottomNav = false;
	private chromeCollapsed = false;
	private scrollDebounce: ReturnType<typeof setTimeout> | null = null;
	private scrollCooldown = false;
	private indicatorIdleTimer: ReturnType<typeof setTimeout> | null = null;
	private currentDisplayUrl = '';
	private urlEditorInput: HTMLInputElement | null = null;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IPreviewService private readonly previewService: IPreviewService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(PreviewEditor.ID, group, telemetryService, themeService, storageService);

		// Restore config
		const savedConfig = this.storageService.get(STORAGE_KEY_CONFIG, StorageScope.WORKSPACE);
		this.config = savedConfig
			? { ...DEFAULT_PREVIEW_CONFIG, ...JSON.parse(savedConfig) }
			: { ...DEFAULT_PREVIEW_CONFIG };
	}

	protected createEditor(parent: HTMLElement): void {
		console.log('[autothropic-preview] createEditor called');
		try {
			this.container = parent;
			this.container.classList.add('autothropic-preview-editor');

			// Toolbar
			this.toolbar = document.createElement('div');
			this.toolbar.id = 'ap-toolbar';
			this.container.appendChild(this.toolbar);

			// Preview area
			this.previewArea = document.createElement('div');
			this.previewArea.id = 'ap-preview-area';
			this.container.appendChild(this.previewArea);

			// Load CSS
			this.loadStylesheet();

			// Build initial frame
			this.rebuildFrame();
			console.log('[autothropic-preview] createEditor completed successfully');
		} catch (err) {
			console.error('[autothropic-preview] createEditor FAILED:', err);
			// Show fallback error message
			safeSetInnerHTML(parent, `<div style="padding:20px;color:#f88;font-family:monospace;white-space:pre-wrap;">Preview EditorPane Error:\n${err}</div>`);
		}

		// Listen for URL changes from service
		this._register(this.previewService.onDidChangeUrl((url) => {
			this.navigateTo(url);
		}));

		// Listen for resize
		this._register(new ResizeObserverDisposable(this.previewArea, () => {
			this.applyDeviceScale();
		}));

		// Event delegation for toolbar clicks
		this.container.addEventListener('click', (e) => this.handleClick(e));
		this.container.addEventListener('keydown', (e) => this.handleKeydown(e));
		this.container.addEventListener('blur', (e) => this.handleBlur(e), true);

		// Resize handle drag (custom mode)
		this.container.addEventListener('mousedown', (e) => this.handleResizeStart(e));

		// Prevent wheel events from reaching VS Code's editor container.
		// Electron's <webview> receives input events through a separate compositor
		// channel, so preventDefault + stopPropagation on the host DOM event
		// does NOT affect the webview's internal scrolling.
		this.container.addEventListener('wheel', (e) => {
			e.preventDefault();
			e.stopPropagation();
		}, { passive: false, capture: true });
	}

	override async setInput(
		input: PreviewEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);

		// Navigate to saved URL -- but skip if webview already has the URL loaded
		// (avoids full page reload when switching back from another editor tab)
		const url = this.previewService.url;
		if (url && this.webviewElement) {
			try {
				const currentUrl = this.webviewElement.getURL();
				if (currentUrl && currentUrl !== 'about:blank' && currentUrl !== '') {
					// Already loaded -- don't re-navigate
					return;
				}
			} catch { /* getURL can throw if webview not ready */ }
			this.navigateTo(url);
		} else if (url) {
			this.navigateTo(url);
		}
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
		this.applyDeviceScale();
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		// Keep the webview's compositor surface alive when hidden so it doesn't
		// flash blank when the editor becomes visible again (e.g., closing clip editor).
		if (this.webviewElement) {
			if (!visible) {
				// Move offscreen instead of display:none so Electron keeps the surface
				this.webviewElement.style.visibility = 'hidden';
			} else {
				this.webviewElement.style.visibility = '';
			}
		}
	}

	override focus(): void {
		this.webviewElement?.focus();
	}

	// ------------------------------------------------------------------
	// Webview lifecycle
	// ------------------------------------------------------------------

	private createWebview(): Electron.WebviewTag {
		const webview = document.createElement('webview') as Electron.WebviewTag;
		webview.id = 'ap-preview-webview';
		webview.setAttribute('nodeintegration', 'false');
		// Persistent session -- cookies/localStorage survive app restarts
		webview.setAttribute('partition', 'persist:autothropic-preview');
		webview.setAttribute('allowpopups', '');
		webview.style.border = 'none';
		webview.style.background = 'transparent';

		// Inject bridge + scrollbar styles on dom-ready (fires when DOM is ready)
		// Only inject on real pages (http/https), not about:blank or error pages
		webview.addEventListener('dom-ready', () => {
			const url = webview.getURL();
			if (url && url.startsWith('http')) {
				this.injectBridgeScript();
				this.injectScrollbarCSS();
				this.updateWebviewMeta();
			}
		});
		webview.addEventListener('did-navigate-in-page', (_e: any) => {
			// SPA navigation -- update URL bar
			const url = webview.getURL();
			this.currentDisplayUrl = url;
			this.updateHostnameInChrome(url);
		});

		// Handle popups (OAuth, external links, window.open)
		// Let Electron handle popup windows natively -- the main process
		// allows popups from webview guests (see app.ts setWindowOpenHandler).
		// OAuth flows need a real popup window so the auth provider can
		// redirect back and the webview's session receives the cookies.
		// We only intercept non-popup navigations (e.g. target="_blank" links
		// that should stay in the same webview).
		webview.addEventListener('new-window', (e: any) => {
			const url = e.url;
			if (!url) { return; }
			// target="_blank" links that aren't popups: load in webview
			if (e.disposition === 'foreground-tab' || e.disposition === 'background-tab') {
				e.preventDefault();
				webview.loadURL(url);
			}
			// 'new-window' disposition (window.open): let Electron open the popup
			// so OAuth flows work with their own window
		});

		// (load failure tracking is in the did-fail-load listener above)

		// Catch F12 / Ctrl+Shift+I when webview has focus
		webview.addEventListener('before-input-event', (e: any) => {
			const input = e?.input;
			const key = input?.key || e?.key;
			if (key === 'F12') {
				this.previewService.openDevTools();
			}
			// Ctrl+Shift+I -- intercept before VS Code gets it
			if (key === 'I' && input?.control && input?.shift && !input?.alt) {
				this.previewService.openDevTools();
			}
		});

		// Capture console messages for on-screen debug overlay
		webview.addEventListener('console-message', (e: any) => {
			const levelMap: Record<number, string> = { 0: 'debug', 1: 'log', 2: 'warn', 3: 'error' };
			const level = levelMap[e.level] || 'log';
			const now = new Date();
			const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
			this.debugLogs.push({ level, text: e.message, time, src: 'webview' });
			if (this.debugLogs.length > 300) { this.debugLogs.shift(); }
			this.renderDebugLogs();
		});

		// Also listen at document level for F12 / Ctrl+Shift+I when preview has focus
		mainWindow.document.addEventListener('keydown', (e: KeyboardEvent) => {
			if (!this.container?.contains(mainWindow.document.activeElement)) { return; }
			const isDevToolsKey = e.key === 'F12' ||
				(e.key === 'I' && e.ctrlKey && e.shiftKey && !e.altKey);
			if (isDevToolsKey) {
				e.preventDefault();
				e.stopPropagation();
				this.previewService.openDevTools();
			}
		}, true); // capture phase to beat VS Code's listener

		// Console messages -- parse bridge messages and forward warnings/errors
		webview.addEventListener('console-message', (e: any) => {
			const msg = e.message || '';
			if (msg.startsWith('__ABRIDGE__')) {
				try {
					const parsed = JSON.parse(msg.slice(11));
					this.handleBridgeMessage(parsed.ch, [parsed.d]);
				} catch { /* malformed -- ignore */ }
				return;
			}
			if (e.level >= 2) { // warnings and errors
				console.warn(`[preview-webview] ${msg}`);
			}
		});

		// Register with service
		(this.previewService as PreviewService).registerWebview(webview);
		this.webviewElement = webview;

		return webview;
	}

	private async doScreenshot(): Promise<void> {
		// Delegate to extension command -- saves to file, opens image editor for drawing
		await this.commandService.executeCommand('autothropic.preview.screenshot');
	}

	private navigateTo(url: string): void {
		this.currentDisplayUrl = url;

		if (!this.webviewElement) {
			return; // Will be set when frame is built
		}

		const currentSrc = this.webviewElement.src || this.webviewElement.getAttribute('src');
		if (currentSrc !== url) {
			this.webviewElement.src = url;
		} else {
			// Same URL re-sent (e.g. terminal re-detected after failed initial load)
			this.webviewElement.reload();
		}

		// Update URL bar
		const urlInput = this.container.querySelector('#ap-url-input') as HTMLInputElement | null;
		if (urlInput) {
			urlInput.value = url;
		}

		// Update hostname in chrome bars
		this.updateHostnameInChrome(url);

		// Remove empty state
		const emptyOv = this.container.querySelector('#ap-empty-state');
		if (emptyOv) { emptyOv.remove(); }

		// Reset scroll state
		this.chromeCollapsed = false;
		this.scrollCooldown = true;
		setTimeout(() => { this.scrollCooldown = false; }, 500);
	}

	private injectBridgeScript(): void {
		if (!this.webviewElement) { return; }
		// Bridge script -- uses console.log with a prefix for host communication
		// (nodeintegration is off, so require('electron') is not available)
		const isMobile = this.config.mode === 'mobile';
		const script = `
(function() {
	if (window.__autothropicBridge) return;
	window.__autothropicBridge = true;
	var isMobile = ${isMobile};

	function send(channel, data) {
		console.log('__ABRIDGE__' + JSON.stringify({ ch: channel, d: data }));
	}

	// Scroll detection -- wheel (primary) + scroll (secondary)
	var lastDir = '';
	mainWindow.document.addEventListener('wheel', function(e) {
		if (Math.abs(e.deltaY) < 5) return;
		var dir = e.deltaY > 0 ? 'down' : 'up';
		if (dir !== lastDir) { lastDir = dir; send('scroll', { dir: dir }); }
	}, { passive: true });
	function updateScrollInd() {}
	window.addEventListener('scroll', function() {
		if (isMobile) updateScrollInd();
		var y = window.scrollY || 0;
		if (y <= 5 && lastDir !== 'up') { lastDir = 'up'; send('scroll', { dir: 'up' }); }
	}, { passive: true });

	// iOS-style scroll indicator -- only in mobile mode
	if (isMobile) {
		var ind = document.createElement('div');
		ind.style.cssText = 'position:fixed;right:2px;top:0;width:4px;border-radius:2px;background:rgba(255,255,255,0.4);opacity:0;transition:opacity 0.3s;z-index:2147483647;pointer-events:none;';
		document.documentElement.appendChild(ind);
		var indTimer = null;
		updateScrollInd = function() {
			var docH = Math.max(document.documentElement.scrollHeight, mainWindow.document.body.scrollHeight);
			var viewH = mainWindow.innerHeight;
			var scrollY = window.scrollY || 0;
			if (docH <= viewH) { ind.style.opacity = '0'; return; }
			var trackH = viewH - 8;
			var thumbH = Math.max(30, (viewH / docH) * trackH);
			var thumbTop = 4 + (scrollY / (docH - viewH)) * (trackH - thumbH);
			ind.style.height = thumbH + 'px';
			ind.style.top = thumbTop + 'px';
			ind.style.opacity = '1';
			if (indTimer) clearTimeout(indTimer);
			indTimer = setTimeout(function() { ind.style.opacity = '0'; }, 1200);
		};
	}

	// Page meta (bg color, title, favicon)
	var lastFaviconDataUrl = '';
	var lastFaviconHref = '';
	function sendMeta() {
		var bgColor = '';
		try { bgColor = mainWindow.getComputedStyle(mainWindow.document.body).backgroundColor; } catch(e) {}
		var title = document.title || '';
		var faviconHref = '';
		var link = document.querySelector('link[rel*="icon"]');
		if (link) { faviconHref = link.href; }
		// Convert favicon to data URL so the renderer can display it
		// (renderer can't load localhost URLs directly)
		if (faviconHref && faviconHref !== lastFaviconHref) {
			lastFaviconHref = faviconHref;
			fetch(faviconHref).then(function(r) { return r.blob(); }).then(function(blob) {
				var reader = new FileReader();
				reader.onloadend = function() {
					lastFaviconDataUrl = reader.result;
					send('meta', { bgColor: bgColor, title: title, favicon: lastFaviconDataUrl });
				};
				reader.readAsDataURL(blob);
			}).catch(function() {
				send('meta', { bgColor: bgColor, title: title, favicon: '' });
			});
		} else {
			send('meta', { bgColor: bgColor, title: title, favicon: lastFaviconDataUrl });
		}
	}
	setTimeout(sendMeta, 500);
	new MutationObserver(sendMeta).observe(document.head, { childList: true, subtree: true });

	// Bottom nav detection
	function detectBottomNav() {
		var found = false;
		var els = document.querySelectorAll('nav, [role="navigation"], footer');
		for (var i = 0; i < els.length; i++) {
			var rect = els[i].getBoundingClientRect();
			if (rect.bottom >= mainWindow.innerHeight - 20 && rect.height < 100 && rect.height > 30) {
				found = true;
				break;
			}
		}
		send('bottomnav', { detected: found });
	}
	setTimeout(detectBottomNav, 1000);

	// SPA navigation detection
	var lastUrl = location.href;
	setInterval(function() {
		if (location.href !== lastUrl) {
			lastUrl = location.href;
			send('nav', { url: lastUrl, title: document.title });
		}
	}, 500);
})();
`;
		this.webviewElement.executeJavaScript(script).catch(() => {
			// May fail if page hasn't loaded yet -- that's OK
		});
	}

	private injectScrollbarCSS(): void {
		if (!this.webviewElement) { return; }
		// Only inject default scrollbar styles -- if the web app defines its own
		// ::-webkit-scrollbar CSS, the app's styles will take priority due to
		// the lower specificity of our :not(...) selector.
		const css = this.getScrollbarCSS();
		if (css) {
			this.webviewElement.insertCSS(css).catch(() => { /* page not ready */ });
		}
		// Safe area is handled by webview slot positioning (top/bottom inset)
		// so no CSS injection needed.
	}

	private getScrollbarCSS(): string {
		const { browserChrome, osFrame, mode } = this.config;

		// The scrollbar sits on top of content via negative right margin on body.
		// This prevents content from being pushed left.
		// The scrollbar visually floats over the right edge of content.

		if (mode === 'mobile') {
			// iOS/Android: hide scrollbar entirely (real iOS only shows a thin
			// auto-hiding indicator overlay, which Chromium can't replicate)
			return `
::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
html, body, * { scrollbar-width: none !important; }
`;
		}

		// macOS Safari: thin rounded overlay
		if (osFrame === 'macos' || browserChrome === 'safari' || browserChrome === 'safari-classic') {
			const isDark = this.config.chromeTheme === 'dark';
			const thumbColor = isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)';
			const thumbHover = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)';
			return `
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: ${thumbColor}; border-radius: 100px; border: 2px solid transparent; background-clip: content-box; }
::-webkit-scrollbar-thumb:hover { background: ${thumbHover}; border: 2px solid transparent; background-clip: content-box; }
::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar:horizontal { display: none; }
`;
		}

		// Edge: thin overlay
		if (browserChrome === 'edge') {
			return `
::-webkit-scrollbar { width: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(100,100,100,0.4); border-radius: 10px; border: 3px solid transparent; background-clip: content-box; }
::-webkit-scrollbar-thumb:hover { background: rgba(100,100,100,0.65); border: 3px solid transparent; background-clip: content-box; }
::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar:horizontal { display: none; }
`;
		}

		// Chrome on Windows: thin overlay scrollbar (matches modern Chrome)
		if (browserChrome === 'chrome') {
			const isDark = this.config.chromeTheme === 'dark';
			const trackBg = isDark ? '#2b2b2b' : '#f5f5f5';
			const thumbBg = isDark ? '#6b6b6b' : '#c4c4c4';
			const thumbHover = isDark ? '#8b8b8b' : '#a0a0a0';
			return `
::-webkit-scrollbar { width: 14px; }
::-webkit-scrollbar-track { background: ${trackBg}; }
::-webkit-scrollbar-thumb { background: ${thumbBg}; border: 3px solid ${trackBg}; border-radius: 7px; }
::-webkit-scrollbar-thumb:hover { background: ${thumbHover}; }
::-webkit-scrollbar-corner { background: ${trackBg}; }
::-webkit-scrollbar:horizontal { display: none; }
`;
		}

		// Default: thin overlay
		return `
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.35); border-radius: 100px; }
::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.55); }
::-webkit-scrollbar-corner { background: transparent; }
body { margin-right: -8px !important; }
`;
	}

	private updateWebviewMeta(): void {
		// Not needed for Phase 1 -- will be used for favicon/title sync later
	}

	// ------------------------------------------------------------------
	// Bridge message handling
	// ------------------------------------------------------------------

	private handleBridgeMessage(channel: string, args: any[]): void {
		const data = args[0] || {};

		switch (channel) {
			case 'scroll': {
				if (this.scrollCooldown) { break; }
				const shouldCollapse = data.dir === 'down';
				if (this.scrollDebounce) { clearTimeout(this.scrollDebounce); }
				this.scrollDebounce = setTimeout(() => {
					if (shouldCollapse !== this.chromeCollapsed) {
						this.setCollapsed(shouldCollapse);
					}
				}, 50);
				break;
			}

			case 'meta':
				if (data.bgColor) {
					this.pageBackgroundColor = data.bgColor;
					this.applyPageBgToChrome();
					// Update status bar + screen area bg
					if (!(this.config.browserChrome === 'safari-classic' && !this.config.safariClassicFlipped)) {
						const statusBar = this.container.querySelector('.status-bar') as HTMLElement | null;
						if (statusBar) { statusBar.style.background = data.bgColor; }
						const screenArea = this.container.querySelector('.screen-area') as HTMLElement | null;
						if (screenArea) { screenArea.style.background = data.bgColor; }
					}
				}
				// Update tab title in desktop chrome
				if (data.title) {
					const tabTitle = this.container.querySelector('[data-chrome-tab-title]');
					if (tabTitle) { tabTitle.textContent = data.title; }
				}
				// Update favicon in desktop chrome
				if (data.favicon) {
					const faviconEl = this.container.querySelector('[data-chrome-tab-favicon]') as HTMLElement | null;
					if (faviconEl) {
						faviconEl.textContent = '';
						const img = document.createElement('img');
						img.src = data.favicon;
						img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;';
						img.onerror = () => { faviconEl.textContent = ''; };
						faviconEl.appendChild(img);
					}
				}
				break;

			case 'bottomnav':
				this.detectedBottomNav = !!data.detected;
				this.applyBottomChromeMode();
				break;

			case 'nav':
				if (data.url) {
					this.currentDisplayUrl = data.url;
					this.updateHostnameInChrome(data.url);
				}
				if (data.title) {
					const spaTabTitle = this.container.querySelector('[data-chrome-tab-title]');
					if (spaTabTitle) { spaTabTitle.textContent = data.title; }
				}
				break;

			case 'open_external':
				if (data.url) {
					// Open in system browser
					mainWindow.open(data.url, '_blank');
				}
				break;
		}
	}

	// ------------------------------------------------------------------
	// Chrome collapse/expand (ported from preview.js)
	// ------------------------------------------------------------------

	private setCollapsed(collapsed: boolean): void {
		this.chromeCollapsed = collapsed;

		// Safari Modern
		const wrap = this.container.querySelector('#sm-wrap') as HTMLElement | null;
		const pill = this.container.querySelector('#sm-pill') as HTMLElement | null;
		if (wrap && pill) {
			const barRow = this.container.querySelector('#sm-bar-row') as HTMLElement | null;
			const hostname = this.container.querySelector('#sm-hostname') as HTMLElement | null;
			const spacer = this.container.querySelector('#sm-spacer') as HTMLElement | null;
			const iconGroups = this.container.querySelectorAll('.sm-icon-group') as NodeListOf<HTMLElement>;

			if (collapsed) {
				wrap.style.height = (wrap.getAttribute('data-col-h') || '59') + 'px';
				if (barRow) { barRow.style.height = (barRow.getAttribute('data-col-h') || '34') + 'px'; }
				pill.style.width = pill.getAttribute('data-col-w') || '168px';
				pill.style.height = (pill.getAttribute('data-col-h') || '34') + 'px';
				pill.style.borderRadius = (pill.getAttribute('data-col-r') || '17') + 'px';
				if (hostname) {
					hostname.style.fontSize = '15px';
					hostname.style.color = hostname.getAttribute('data-col-color') || '';
				}
				if (spacer) { spacer.style.height = '20px'; }
				iconGroups.forEach((g) => {
					g.style.width = '0';
					g.style.opacity = '0';
					g.style.paddingLeft = '0';
					g.style.paddingRight = '0';
				});
			} else {
				wrap.style.height = (wrap.getAttribute('data-exp-h') || '') + 'px';
				if (barRow) { barRow.style.height = (barRow.getAttribute('data-exp-h') || '52') + 'px'; }
				pill.style.width = pill.getAttribute('data-exp-w') || '';
				pill.style.height = (pill.getAttribute('data-exp-h') || '52') + 'px';
				pill.style.borderRadius = (pill.getAttribute('data-exp-r') || '26') + 'px';
				if (hostname) {
					hostname.style.fontSize = '16px';
					hostname.style.color = hostname.getAttribute('data-exp-color') || '';
				}
				if (spacer) { spacer.style.height = (spacer.getAttribute('data-exp-h') || '') + 'px'; }
				iconGroups.forEach((g, idx) => {
					g.style.width = '86px';
					g.style.opacity = '1';
					if (idx === 0) {
						g.style.paddingLeft = '8px';
						g.style.paddingRight = '';
					} else {
						g.style.paddingLeft = '';
						g.style.paddingRight = '8px';
					}
				});
			}
		}

		// Safari Classic
		const scAddress = this.container.querySelector('#sc-address') as HTMLElement | null;
		const scNav = this.container.querySelector('#sc-nav') as HTMLElement | null;
		const scBottomWrap = this.container.querySelector('#sc-bottom-wrap') as HTMLElement | null;
		if (scAddress || scNav) {
			if (collapsed) {
				if (scAddress) { scAddress.style.height = (scAddress.getAttribute('data-col-h') || '26') + 'px'; }
				if (scNav) { scNav.style.height = (scNav.getAttribute('data-col-h') || '0') + 'px'; }
				if (scBottomWrap) { scBottomWrap.style.height = (scBottomWrap.getAttribute('data-col-h') || '0') + 'px'; }
			} else {
				if (scAddress) { scAddress.style.height = (scAddress.getAttribute('data-exp-h') || '44') + 'px'; }
				if (scNav) { scNav.style.height = (scNav.getAttribute('data-exp-h') || '44') + 'px'; }
				if (scBottomWrap) { scBottomWrap.style.height = (scBottomWrap.getAttribute('data-exp-h') || '') + 'px'; }
			}
		}

		// Google Chrome
		const gcBottomWrap = this.container.querySelector('#gc-bottom-wrap') as HTMLElement | null;
		if (gcBottomWrap) {
			if (collapsed) {
				gcBottomWrap.style.height = (gcBottomWrap.getAttribute('data-col-h') || '0') + 'px';
			} else {
				gcBottomWrap.style.height = (gcBottomWrap.getAttribute('data-exp-h') || '') + 'px';
			}
		}

		// Home indicator pill auto-hide
		if (collapsed) {
			this.showHomePills();
			this.startIndicatorIdleTimer();
		} else {
			this.cancelIndicatorIdleTimer();
			this.showHomePills();
		}
	}

	private showHomePills(): void {
		this.container.querySelectorAll('.home-pill').forEach((p: Element) => {
			(p as HTMLElement).style.opacity = '1';
		});
	}

	private hideHomePills(): void {
		this.container.querySelectorAll('.home-pill').forEach((p: Element) => {
			(p as HTMLElement).style.opacity = '0';
		});
	}

	private startIndicatorIdleTimer(): void {
		this.cancelIndicatorIdleTimer();
		this.indicatorIdleTimer = setTimeout(() => { this.hideHomePills(); }, 5000);
	}

	private cancelIndicatorIdleTimer(): void {
		if (this.indicatorIdleTimer) { clearTimeout(this.indicatorIdleTimer); this.indicatorIdleTimer = null; }
	}

	// ------------------------------------------------------------------
	// Chrome positioning (overlay vs flex)
	// ------------------------------------------------------------------

	private applyBottomChromeMode(): void {
		const hasNav = this.resolvedHasBottomNav();
		const smWrap = this.container.querySelector('#sm-wrap') as HTMLElement | null;
		if (smWrap) {
			if (hasNav) {
				smWrap.style.position = 'static';
				smWrap.style.bottom = '';
				smWrap.style.left = '';
				smWrap.style.right = '';
				smWrap.style.flexShrink = '0';
			} else {
				smWrap.style.position = 'absolute';
				smWrap.style.bottom = '0';
				smWrap.style.left = '0';
				smWrap.style.right = '0';
				smWrap.style.flexShrink = '';
			}
		}
		this.applyPageBgToChrome();
	}

	private applyPageBgToChrome(): void {
		const hasNav = this.resolvedHasBottomNav();
		const smBacking = this.container.querySelector('#sm-backing') as HTMLElement | null;
		if (smBacking) {
			if (hasNav) {
				const chromeBg = this.pageBackgroundColor || smBacking.getAttribute('data-chrome-bg') || '#1c1c1e';
				smBacking.style.background = chromeBg;
			} else {
				smBacking.style.background = 'transparent';
			}
		}
		if (this.pageBackgroundColor) {
			const smSpacer = this.container.querySelector('#sm-spacer') as HTMLElement | null;
			if (smSpacer && hasNav) {
				smSpacer.style.background = this.pageBackgroundColor;
			}
		}
	}

	// ------------------------------------------------------------------
	// Hostname update
	// ------------------------------------------------------------------

	private updateHostnameInChrome(url: string): void {
		try {
			const hostname = new URL(url).hostname;
			this.container.querySelectorAll('[data-chrome-hostname]').forEach((el) => {
				el.textContent = hostname;
			});
		} catch { /* invalid URL */ }
	}

	// ------------------------------------------------------------------
	// Event handlers
	// ------------------------------------------------------------------

	private handleClick(e: MouseEvent): void {
		const target = e.target as HTMLElement;

		// Dropdown trigger
		const trigger = target.closest('.dropdown-trigger');
		if (trigger) {
			e.stopPropagation();
			const dropdown = trigger.closest('.dropdown');
			if (dropdown) {
				const isOpen = dropdown.classList.contains('open');
				this.closeAllDropdowns();
				if (!isOpen) { dropdown.classList.add('open'); }
			}
			return;
		}

		// Device dropdown item
		const deviceItem = target.closest('#ap-device-dropdown .dropdown-item');
		if (deviceItem) {
			const deviceId = deviceItem.getAttribute('data-device-id');
			if (deviceId) {
				this.config.deviceId = deviceId;
				if (this.config.mode === 'mobile') {
					const device = getDevice(deviceId);
					const os = getDeviceOS(device);
					if (os === 'android') {
						this.config.browserChrome = 'google-chrome';
					} else if (this.config.browserChrome === 'google-chrome') {
						this.config.browserChrome = 'safari';
					}
				}
				this.saveConfig();
				this.rebuildFrame();
			}
			this.closeAllDropdowns();
			return;
		}

		// Presets dropdown item
		const presetItem = target.closest('#ap-presets-dropdown .dropdown-item');
		if (presetItem) {
			const presetId = presetItem.getAttribute('data-preset-id');
			const preset = ALL_PRESETS.find(p => p.id === presetId);
			if (preset) {
				Object.assign(this.config, preset.config);
				this.saveConfig();
				this.rebuildFrame();
			}
			this.closeAllDropdowns();
			return;
		}

		// Small dropdown item
		const smallItem = target.closest('.small-dropdown .dropdown-item');
		if (smallItem) {
			const menu = smallItem.closest('.dropdown-menu');
			const action = menu?.getAttribute('data-action');
			const value = smallItem.getAttribute('data-value');
			if (action && value) { this.handleToolbarAction(action, value); }
			this.closeAllDropdowns();
			return;
		}

		// Toggle pill option
		const pillOpt = target.closest('.pill-opt');
		if (pillOpt) {
			const pillEl = pillOpt.closest('.toggle-pill');
			const pillAction = pillEl?.getAttribute('data-action');
			const pillValue = (pillOpt as HTMLElement).getAttribute('data-value');
			if (pillAction && pillValue) { this.handleToolbarAction(pillAction, pillValue); }
			return;
		}

		// Tool button
		const toolBtn = target.closest('.tool-btn[data-action]');
		if (toolBtn) {
			const toolAction = toolBtn.getAttribute('data-action');
			if (toolAction) { this.handleToolbarAction(toolAction, ''); }
			return;
		}

		// Refresh
		if (target.closest('#ap-btn-refresh')) {
			this.previewService.reload();
			return;
		}

		// Screenshot
		if (target.closest('#ap-btn-screenshot')) {
			this.doScreenshot();
			return;
		}

		// Clip
		if (target.closest('#ap-btn-clip')) {
			this.commandService.executeCommand('autothropic.preview.openClipEditor');
			return;
		}

		// Restart Build
		if (target.closest('#ap-btn-restart-build')) {
			this.commandService.executeCommand('autothropic.preview.restartBuild');
			return;
		}

		// DevTools
		if (target.closest('#ap-btn-devtools')) {
			this.previewService.openDevTools();
			return;
		}

		// Chrome action (back/forward/reload)
		const actionEl = target.closest('[data-chrome-action]');
		if (actionEl && this.webviewElement) {
			const action = actionEl.getAttribute('data-chrome-action');
			if (action === 'back') { this.webviewElement.goBack(); }
			else if (action === 'forward') { this.webviewElement.goForward(); }
			else if (action === 'reload') { this.webviewElement.reload(); }
			return;
		}

		// Chrome URL click -- inline editor
		const urlEl = target.closest('[data-chrome-url]');
		if (urlEl && !this.urlEditorInput && !target.closest('[data-chrome-action]')) {
			this.openChromeUrlEditor(urlEl as HTMLElement);
			return;
		}

		this.closeAllDropdowns();
	}

	private handleKeydown(e: KeyboardEvent): void {
		const target = e.target as HTMLInputElement;
		if (e.key === 'Enter') {
			if (target.id === 'ap-custom-w' || target.id === 'ap-custom-h') {
				this.commitCustomDims();
			}
			if (target.id === 'ap-url-input') {
				let url = target.value.trim();
				if (url && !url.match(/^https?:\/\//)) { url = 'http://' + url; }
				if (url) { this.previewService.setUrl(url); }
			}
		}

		// F12 -- open DevTools
		if (e.key === 'F12') {
			e.preventDefault();
			this.previewService.openDevTools();
		}
	}

	private handleBlur(e: FocusEvent): void {
		const target = e.target as HTMLInputElement;
		if (target.id === 'ap-custom-w' || target.id === 'ap-custom-h') {
			this.commitCustomDims();
		}
	}

	private commitCustomDims(): void {
		const customW = this.container.querySelector('#ap-custom-w') as HTMLInputElement | null;
		const customH = this.container.querySelector('#ap-custom-h') as HTMLInputElement | null;
		if (!customW || !customH) { return; }
		const w = Math.max(200, Math.min(3840, parseInt(customW.value, 10) || this.config.customWidth));
		const h = Math.max(200, Math.min(2160, parseInt(customH.value, 10) || this.config.customHeight));
		this.config.customWidth = w;
		this.config.customHeight = h;
		this.saveConfig();
		this.rebuildFrame();
	}

	private handleToolbarAction(action: string, value: string): void {
		switch (action) {
			case 'setMode':
				this.config.mode = value as PreviewMode;
				if (this.config.mode === 'mobile') {
					const device = getDevice(this.config.deviceId);
					if (device.category === 'laptop') {
						this.config.deviceId = 'iphone-16-pro';
						this.config.browserChrome = 'safari';
					}
				} else if (this.config.mode === 'desktop') {
					const device = getDevice(this.config.deviceId);
					if (device.category !== 'laptop') {
						this.config.deviceId = 'macbook-pro-16';
						this.config.browserChrome = 'chrome';
						this.config.osFrame = 'macos';
					}
				}
				this.saveConfig();
				this.rebuildFrame();
				break;
			case 'setBrowserChrome':
				this.config.browserChrome = value as BrowserChromeType;
				this.saveConfig();
				this.updateViewInPlace();
				break;
			case 'setChromeTheme':
				this.config.chromeTheme = value as ChromeTheme;
				this.saveConfig();
				this.updateViewInPlace();
				break;
			case 'setIphoneScreenType':
				this.config.iphoneScreenType = value as IPhoneScreenType;
				this.saveConfig();
				this.rebuildFrame();
				break;
			case 'setOsFrame':
				this.config.osFrame = value as OsFrameType;
				this.saveConfig();
				this.rebuildFrame();
				break;
			case 'toggleTaskbar':
				this.config.showTaskbar = !this.config.showTaskbar;
				this.saveConfig();
				this.rebuildFrame();
				break;
			case 'toggleOrientation':
				this.config.orientation = this.config.orientation === 'portrait' ? 'landscape' : 'portrait';
				this.saveConfig();
				this.rebuildFrame();
				break;
			case 'toggleSafariFlip':
				this.config.safariClassicFlipped = !this.config.safariClassicFlipped;
				this.saveConfig();
				this.updateViewInPlace();
				break;
			case 'setBottomNav':
				this.config.bottomNavOverride = value as 'auto' | 'on' | 'off';
				this.saveConfig();
				this.updateViewInPlace();
				break;
			case 'toggleDebugOverlay':
				this.config.showDebugOverlay = !this.config.showDebugOverlay;
				this.saveConfig();
				this.updateDebugOverlay();
				break;
			case 'zoomIn':
				this.config.customZoom = Math.min(3, this.config.customZoom + 0.25);
				this.saveConfig();
				this.applyCustomZoom();
				break;
			case 'zoomOut':
				this.config.customZoom = Math.max(0.25, this.config.customZoom - 0.25);
				this.saveConfig();
				this.applyCustomZoom();
				break;
			case 'zoomReset':
				this.config.customZoom = 1;
				this.saveConfig();
				this.applyCustomZoom();
				break;
		}
	}

	// ------------------------------------------------------------------
	// Chrome URL inline editor
	// ------------------------------------------------------------------

	private openChromeUrlEditor(container: HTMLElement): void {
		const rect = container.getBoundingClientRect();
		this.urlEditorInput = document.createElement('input');
		this.urlEditorInput.type = 'text';
		this.urlEditorInput.className = 'chrome-url-editor';
		this.urlEditorInput.value = this.currentDisplayUrl || '';
		this.urlEditorInput.style.position = 'fixed';
		this.urlEditorInput.style.left = rect.left + 'px';
		this.urlEditorInput.style.top = rect.top + 'px';
		this.urlEditorInput.style.width = rect.width + 'px';
		this.urlEditorInput.style.height = rect.height + 'px';
		this.urlEditorInput.style.borderRadius = mainWindow.getComputedStyle(container).borderRadius || '18px';

		mainWindow.document.body.appendChild(this.urlEditorInput);
		this.urlEditorInput.focus();
		this.urlEditorInput.select();

		this.urlEditorInput.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter') {
				let newUrl = this.urlEditorInput!.value.trim();
				if (newUrl && !newUrl.match(/^https?:\/\//)) { newUrl = 'http://' + newUrl; }
				if (newUrl) { this.previewService.setUrl(newUrl); }
				this.closeChromeUrlEditor();
			} else if (ev.key === 'Escape') {
				this.closeChromeUrlEditor();
			}
		});

		this.urlEditorInput.addEventListener('blur', () => {
			this.closeChromeUrlEditor();
		});
	}

	private closeChromeUrlEditor(): void {
		if (this.urlEditorInput) {
			this.urlEditorInput.remove();
			this.urlEditorInput = null;
		}
	}

	private closeAllDropdowns(): void {
		this.container.querySelectorAll('.dropdown.open').forEach((el) => {
			el.classList.remove('open');
		});
	}

	// ------------------------------------------------------------------
	// Config persistence
	// ------------------------------------------------------------------

	private saveConfig(): void {
		this.storageService.store(STORAGE_KEY_CONFIG, JSON.stringify(this.config), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private resolvedHasBottomNav(): boolean {
		if (this.config.bottomNavOverride === 'on') { return true; }
		if (this.config.bottomNavOverride === 'off') { return false; }
		return this.detectedBottomNav;
	}

	// ------------------------------------------------------------------
	// Scale device frame to fit
	// ------------------------------------------------------------------

	private applyDeviceScale(): void {
		const deviceFrame = this.container.querySelector('#ap-device-frame') as HTMLElement | null;
		if (!deviceFrame || !this.previewArea) { return; }

		const areaRect = this.previewArea.getBoundingClientRect();
		const maxW = areaRect.width - 32;
		const maxH = areaRect.height - 32;

		// Custom mode: scale the wrapper (includes handles), apply zoom multiplier
		if (this.config.mode === 'custom') {
			const wrapper = this.container.querySelector('.custom-resize-wrapper') as HTMLElement | null;
			if (!wrapper) { return; }
			const wrapperW = wrapper.offsetWidth;
			const wrapperH = wrapper.offsetHeight;
			if (wrapperW === 0 || wrapperH === 0) { return; }
			const fit = Math.min(maxW / wrapperW, maxH / wrapperH, 1);
			const scale = fit * this.config.customZoom;
			wrapper.style.transform = `scale(${scale})`;
			wrapper.style.transformOrigin = 'top center';
			this.previewArea.style.alignItems = 'flex-start';
			return;
		}
		this.previewArea.style.alignItems = 'center';

		const frameW = deviceFrame.scrollWidth;
		const frameH = deviceFrame.scrollHeight;
		if (frameW === 0 || frameH === 0) { return; }

		const scale = Math.min(maxW / frameW, maxH / frameH, 1);
		deviceFrame.style.transform = `scale(${scale})`;
		deviceFrame.style.transformOrigin = 'center center';
	}

	private applyCustomZoom(): void {
		this.applyDeviceScale();
		const label = this.container.querySelector('#ap-zoom-label');
		if (label) {
			label.textContent = `${Math.round(this.config.customZoom * 100)}%`;
		}
	}

	// ------------------------------------------------------------------
	// Resize handle drag (custom mode)
	// ------------------------------------------------------------------

	private handleResizeStart(e: MouseEvent): void {
		const handle = (e.target as HTMLElement).closest('[data-resize]') as HTMLElement | null;
		if (!handle || this.config.mode !== 'custom') { return; }

		e.preventDefault();
		e.stopPropagation();

		const direction = handle.getAttribute('data-resize')!;
		const deviceFrame = this.container.querySelector('#ap-device-frame') as HTMLElement | null;
		const wrapper = this.container.querySelector('.custom-resize-wrapper') as HTMLElement | null;
		const webview = this.webviewElement;
		if (!deviceFrame || !wrapper) { return; }

		const startX = e.clientX;
		const startY = e.clientY;
		const startW = this.config.customWidth;
		const startH = this.config.customHeight;
		const zoom = this.config.customZoom;

		// Full-screen overlay prevents webview from stealing mouse events during drag
		const overlay = document.createElement('div');
		overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10000;cursor:' +
			(direction === 'r' ? 'ew-resize' : direction === 'b' ? 'ns-resize' : 'nwse-resize');
		mainWindow.document.body.appendChild(overlay);

		const onMouseMove = (ev: MouseEvent) => {
			const dx = (ev.clientX - startX) / zoom;
			const dy = (ev.clientY - startY) / zoom;

			if (direction === 'r' || direction === 'br') {
				const newW = Math.max(200, Math.min(3840, Math.round(startW + dx)));
				this.config.customWidth = newW;
				deviceFrame.style.width = newW + 'px';
				if (webview) { webview.style.width = newW + 'px'; }
				const wInput = this.container.querySelector('#ap-custom-w') as HTMLInputElement | null;
				if (wInput) { wInput.value = String(newW); }
			}
			if (direction === 'b' || direction === 'br') {
				const newH = Math.max(200, Math.min(2160, Math.round(startH + dy)));
				this.config.customHeight = newH;
				deviceFrame.style.height = newH + 'px';
				if (webview) { webview.style.height = newH + 'px'; }
				const hInput = this.container.querySelector('#ap-custom-h') as HTMLInputElement | null;
				if (hInput) { hInput.value = String(newH); }
			}
			// Update grid + wrapper size to match new dimensions
			wrapper.style.gridTemplateColumns = `${this.config.customWidth}px 16px`;
			wrapper.style.gridTemplateRows = `${this.config.customHeight}px 16px`;
			wrapper.style.width = `${this.config.customWidth + 16}px`;
			wrapper.style.height = `${this.config.customHeight + 16}px`;
		};

		const onMouseUp = () => {
			overlay.remove();
			mainWindow.document.removeEventListener('mousemove', onMouseMove);
			mainWindow.document.removeEventListener('mouseup', onMouseUp);
			this.saveConfig();
		};

		mainWindow.document.addEventListener('mousemove', onMouseMove);
		mainWindow.document.addEventListener('mouseup', onMouseUp);
	}

	// ------------------------------------------------------------------
	// Frame building (full rebuild)
	// ------------------------------------------------------------------

	private rebuildFrame(): void {
		// Save reference to existing webview so we can reattach it
		const existingWebview = this.webviewElement;

		// Build toolbar
		safeSetInnerHTML(this.toolbar, this.buildToolbar(getDevice(this.config.deviceId)));

		// Build frame
		const device = getDevice(this.config.deviceId);
		safeSetInnerHTML(this.previewArea, this.buildFrame(device));

		// Find the webview slot and replace with real webview
		const slot = this.previewArea.querySelector('#ap-webview-slot') as HTMLElement | null;
		if (slot && slot.parentNode) {
			const webview = existingWebview || this.createWebview();
			// Copy the slot's positioning style to the webview
			webview.style.cssText = slot.style.cssText + 'border:none;background:transparent;';
			slot.parentNode.replaceChild(webview, slot);

			// Navigate if we have a URL
			if (this.currentDisplayUrl && !existingWebview) {
				webview.src = this.currentDisplayUrl;
			}
		}

		// Debug overlay
		this.updateDebugOverlay();

		// Apply bottom chrome mode
		this.applyBottomChromeMode();

		// Reset collapse
		this.chromeCollapsed = false;
		this.cancelIndicatorIdleTimer();
		this.showHomePills();

		// Scale
		mainWindow.requestAnimationFrame(() => this.applyDeviceScale());

		// macOS dock auto-hide: show on hover in bottom 10px trigger zone
		this.setupDockAutoHide();

		// Note: scrollbar CSS and bridge script are injected on 'dom-ready' event,
		// NOT here -- the webview must be attached and loaded first.
	}

	private setupDockAutoHide(): void {
		const trigger = this.container.querySelector('.macos-dock-trigger') as HTMLElement | null;
		const dock = this.container.querySelector('.macos-dock') as HTMLElement | null;
		if (!trigger || !dock) { return; }

		let hideTimer: ReturnType<typeof setTimeout> | null = null;

		const showDock = () => {
			if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
			dock.style.opacity = '1';
			dock.style.transform = 'translateY(0)';
			dock.style.pointerEvents = 'auto';
		};
		const hideDock = () => {
			hideTimer = setTimeout(() => {
				dock.style.opacity = '0';
				dock.style.transform = 'translateY(60px)';
				dock.style.pointerEvents = 'none';
			}, 300);
		};

		trigger.addEventListener('mouseenter', showDock);
		trigger.addEventListener('mouseleave', hideDock);
		dock.addEventListener('mouseenter', showDock);
		dock.addEventListener('mouseleave', hideDock);
	}

	private updateViewInPlace(): void {
		// Same as rebuildFrame but tries to preserve webview position
		this.rebuildFrame();
	}

	private debugPanelHeight = 250;

	private updateDebugOverlay(): void {
		if (this.debugOverlay) { this.debugOverlay.remove(); this.debugOverlay = null; }
		if (!this.config.showDebugOverlay) {
			this._unhookDebugCapture();
			return;
		}

		// Docked bottom panel -- sits below the preview area in the flex column,
		// so Electron's <webview> compositor surface doesn't cover it
		this.debugOverlay = document.createElement('div');
		this.debugOverlay.id = 'ap-debug-panel';
		this.debugOverlay.style.height = `${this.debugPanelHeight}px`;

		// Resize handle -- top edge of panel, drag to resize vertically
		const resizeBar = document.createElement('div');
		resizeBar.style.cssText = 'height:4px;cursor:ns-resize;background:var(--vscode-sash-hoverBorder, var(--vscode-panel-border, #333));flex-shrink:0;';
		resizeBar.addEventListener('mousedown', (e: MouseEvent) => {
			e.preventDefault();
			const startY = e.clientY;
			const startH = this.debugPanelHeight;
			const onMove = (ev: MouseEvent) => {
				this.debugPanelHeight = Math.max(100, Math.min(600, startH - (ev.clientY - startY)));
				this.debugOverlay!.style.height = `${this.debugPanelHeight}px`;
			};
			const onUp = () => {
				mainWindow.document.removeEventListener('mousemove', onMove);
				mainWindow.document.removeEventListener('mouseup', onUp);
			};
			mainWindow.document.addEventListener('mousemove', onMove);
			mainWindow.document.addEventListener('mouseup', onUp);
		});
		this.debugOverlay.appendChild(resizeBar);

		// Header
		const header = document.createElement('div');
		header.style.cssText = 'display:flex;align-items:center;padding:4px 10px;background:var(--vscode-sideBar-background, #252525);flex-shrink:0;gap:8px;border-bottom:1px solid var(--vscode-panel-border, #333);user-select:none;';
		header.innerHTML = (_ttPolicy ? _ttPolicy.createHTML(`
			<span style="font-weight:600;color:var(--vscode-terminal-ansiRed, #d97757);font-size:11px;">Debug Console</span>
			<span style="color:var(--vscode-descriptionForeground, #666);font-size:10px;">renderer + webview</span>
		`) : '') as string;

		const copyBtn = document.createElement('button');
		copyBtn.textContent = 'Copy All';
		copyBtn.style.cssText = 'background:var(--vscode-button-secondaryBackground, #333);border:1px solid var(--vscode-widget-border, #555);color:var(--vscode-button-secondaryForeground, #ccc);font-size:10px;padding:2px 8px;border-radius:3px;cursor:pointer;margin-left:auto;';
		copyBtn.addEventListener('click', () => {
			const text = this.debugLogs.map(e => `[${e.time}] [${e.src}] [${e.level}] ${e.text}`).join('\n');
			navigator.clipboard.writeText(text).then(() => { copyBtn.textContent = 'Copied!'; setTimeout(() => { copyBtn.textContent = 'Copy All'; }, 1500); });
		});
		const clearBtn = document.createElement('button');
		clearBtn.textContent = 'Clear';
		clearBtn.style.cssText = 'background:var(--vscode-button-secondaryBackground, #333);border:1px solid var(--vscode-widget-border, #555);color:var(--vscode-button-secondaryForeground, #ccc);font-size:10px;padding:2px 8px;border-radius:3px;cursor:pointer;';
		clearBtn.addEventListener('click', () => { this.debugLogs = []; this.renderDebugLogs(); });
		header.appendChild(copyBtn);
		header.appendChild(clearBtn);
		this.debugOverlay.appendChild(header);

		// Log container
		const logContainer = document.createElement('div');
		logContainer.id = 'ap-debug-logs';
		logContainer.style.cssText = 'flex:1;overflow-y:auto;padding:4px 0;user-select:text;-webkit-user-select:text;cursor:text;';
		logContainer.tabIndex = 0; // Make focusable for keyboard events

		// Handle Ctrl+C / Ctrl+A in the debug panel -- VS Code intercepts
		// keyboard events, so we need to handle copy/select-all ourselves
		logContainer.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.ctrlKey || e.metaKey) {
				if (e.key === 'c' || e.key === 'C') {
					e.stopPropagation();
					const selection = mainWindow.getSelection();
					if (selection && selection.toString()) {
						navigator.clipboard.writeText(selection.toString());
					}
				} else if (e.key === 'a' || e.key === 'A') {
					e.stopPropagation();
					e.preventDefault();
					const range = document.createRange();
					range.selectNodeContents(logContainer);
					const selection = mainWindow.getSelection();
					selection?.removeAllRanges();
					selection?.addRange(range);
				}
			}
		}, true);
		this.debugOverlay.appendChild(logContainer);

		// Append after the preview area (sibling, not child)
		this.container.appendChild(this.debugOverlay);
		this._hookDebugCapture();
		this.renderDebugLogs();
	}

	private _origConsoleError: ((...args: any[]) => void) | null = null;
	private _origConsoleWarn: ((...args: any[]) => void) | null = null;
	private _origConsoleLog: ((...args: any[]) => void) | null = null;
	private _errorHandler: ((e: ErrorEvent) => void) | null = null;
	private _rejectionHandler: ((e: PromiseRejectionEvent) => void) | null = null;

	private _hookDebugCapture(): void {
		this._unhookDebugCapture();
		const push = (src: string, level: string, ...args: any[]) => {
			const now = new Date();
			const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
			const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 0)?.substring(0, 500) ?? String(a)).join(' ');
			this.debugLogs.push({ level, text, time, src });
			if (this.debugLogs.length > 300) { this.debugLogs.shift(); }
			this.renderDebugLogs();
		};
		// Hook console.error/warn/log
		this._origConsoleError = console.error;
		this._origConsoleWarn = console.warn;
		this._origConsoleLog = console.log;
		console.error = (...args: any[]) => { this._origConsoleError!.apply(console, args); push('renderer', 'error', ...args); };
		console.warn = (...args: any[]) => { this._origConsoleWarn!.apply(console, args); push('renderer', 'warn', ...args); };
		console.log = (...args: any[]) => { this._origConsoleLog!.apply(console, args); push('renderer', 'log', ...args); };
		// Hook uncaught errors
		this._errorHandler = (e: ErrorEvent) => { push('renderer', 'error', `Uncaught: ${e.message} at ${e.filename}:${e.lineno}`); };
		this._rejectionHandler = (e: PromiseRejectionEvent) => { push('renderer', 'error', `Unhandled rejection: ${e.reason}`); };
		mainWindow.addEventListener('error', this._errorHandler);
		mainWindow.addEventListener('unhandledrejection', this._rejectionHandler);
	}

	private _unhookDebugCapture(): void {
		if (this._origConsoleError) { console.error = this._origConsoleError; this._origConsoleError = null; }
		if (this._origConsoleWarn) { console.warn = this._origConsoleWarn; this._origConsoleWarn = null; }
		if (this._origConsoleLog) { console.log = this._origConsoleLog; this._origConsoleLog = null; }
		if (this._errorHandler) { mainWindow.removeEventListener('error', this._errorHandler); this._errorHandler = null; }
		if (this._rejectionHandler) { mainWindow.removeEventListener('unhandledrejection', this._rejectionHandler); this._rejectionHandler = null; }
	}

	private renderDebugLogs(): void {
		if (!this.debugOverlay) { return; }
		const logContainer = this.debugOverlay.querySelector('#ap-debug-logs');
		if (!logContainer) { return; }
		const colorMap: Record<string, string> = {
			error: 'var(--vscode-errorForeground, #f28482)',
			warn: 'var(--vscode-editorWarning-foreground, #D4A574)',
			log: 'var(--vscode-editor-foreground, #e8e5de)',
			debug: 'var(--vscode-descriptionForeground, #7a7870)',
		};
		const srcColor: Record<string, string> = {
			renderer: 'var(--vscode-terminal-ansiBlue, #539bf5)',
			webview: 'var(--vscode-terminal-ansiGreen, #57ab5a)',
		};
		let html = '';
		for (const entry of this.debugLogs) {
			const color = colorMap[entry.level] || 'var(--vscode-editor-foreground, #e8e5de)';
			const sc = srcColor[entry.src] || 'var(--vscode-descriptionForeground, #888)';
			const prefix = entry.level === 'error' ? '\u2716 ' : entry.level === 'warn' ? '\u26a0 ' : '';
			const escaped = entry.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			html += `<div style="padding:1px 8px;color:${color};border-bottom:1px solid var(--vscode-widget-border, rgba(255,255,255,0.03));word-break:break-all;line-height:1.4;user-select:text;-webkit-user-select:text;"><span style="color:var(--vscode-descriptionForeground, #555);margin-right:4px;">${entry.time}</span><span style="color:${sc};margin-right:4px;font-size:9px;">[${entry.src}]</span>${prefix}${escaped}</div>`;
		}
		if (html === '') {
			html = '<div style="padding:12px;color:var(--vscode-descriptionForeground, #555);text-align:center;">Listening for console messages...<br>Captures: renderer errors/warnings/logs + webview console output</div>';
		}
		if (_ttPolicy) {
			logContainer.innerHTML = _ttPolicy.createHTML(html) as unknown as string;
		} else {
			logContainer.innerHTML = html;
		}
		logContainer.scrollTop = logContainer.scrollHeight;
	}

	// ------------------------------------------------------------------
	// Toolbar builder (ported from previewPanel.ts)
	// ------------------------------------------------------------------

	private buildToolbar(device: DeviceProfile): string {
		const c = this.config;
		const isMobile = c.mode === 'mobile';
		const isDesktop = c.mode === 'desktop';
		const isCustom = c.mode === 'custom';
		const deviceOS = getDeviceOS(device);
		const isModern = isModernIphone(device);
		const isAndroid = deviceOS === 'android';

		let html = '<div class="toolbar-row">';

		// Mode toggle pill
		html += this.togglePill('mode', [
			{ value: 'mobile', label: 'Mobile' },
			{ value: 'desktop', label: 'Desktop' },
			{ value: 'custom', label: 'Custom' },
		], c.mode, 'setMode');

		html += '<span class="sep"></span>';

		// Custom mode: W×H + zoom controls
		if (isCustom) {
			const zoomPct = Math.round(c.customZoom * 100);
			html += `<div class="dim-inputs">
				<input type="number" id="ap-custom-w" value="${c.customWidth}" min="200" max="3840" />
				<span class="dim-x">\u00D7</span>
				<input type="number" id="ap-custom-h" value="${c.customHeight}" min="200" max="2160" />
			</div>`;
			html += '<span class="sep"></span>';
			html += `<button class="tool-btn" data-action="zoomOut" title="Zoom out">\u2212</button>`;
			html += `<span class="label-static" id="ap-zoom-label">${zoomPct}%</span>`;
			html += `<button class="tool-btn" data-action="zoomIn" title="Zoom in">+</button>`;
			html += `<button class="tool-btn" data-action="zoomReset" title="Reset zoom">Reset</button>`;
		}

		// Device dropdown
		if (!isCustom) {
			const groups = isMobile
				? [
					{ label: 'iPhones', devices: IPHONES },
					{ label: 'Android', devices: ANDROID_PHONES },
					{ label: 'iPads', devices: IPADS },
				]
				: [{ label: 'Laptops', devices: LAPTOPS }];

			html += '<div class="dropdown" id="ap-device-dropdown">';
			html += `<button class="dropdown-trigger">${device.name} <span class="dim-label">${device.width}\u00D7${device.height}</span></button>`;
			html += '<div class="dropdown-menu">';
			for (const group of groups) {
				html += `<div class="dropdown-group-label">${group.label}</div>`;
				for (const d of group.devices) {
					const sel = d.id === c.deviceId ? ' selected' : '';
					html += `<button class="dropdown-item${sel}" data-device-id="${d.id}">${d.name} <span class="dim-label">${d.width}\u00D7${d.height}</span></button>`;
				}
			}
			html += '</div></div>';
		}

		// iPhone screen type
		if (!isCustom && isMobile && isModern) {
			html += this.togglePill('screenType', [
				{ value: 'island', label: 'Pill' },
				{ value: 'notch', label: 'Notch' },
			], c.iphoneScreenType, 'setIphoneScreenType');
		}

		if (!isCustom) { html += '<span class="sep"></span>'; }

		// Browser chrome picker
		if (!isCustom) {
			const isSafari = c.browserChrome === 'safari' || c.browserChrome === 'safari-classic';
			if (isMobile && isSafari) {
				html += this.smallDropdown('Safari', [
					{ value: 'safari', label: 'Modern' },
					{ value: 'safari-classic', label: 'Classic' },
				], c.browserChrome, 'setBrowserChrome');
			} else if (isMobile && isAndroid) {
				html += '<span class="label-static">Chrome</span>';
			} else if (isDesktop) {
				html += this.smallDropdown('Browser', [
					{ value: 'chrome', label: 'Chrome' },
					{ value: 'edge', label: 'Edge' },
				], c.browserChrome === 'chrome' || c.browserChrome === 'edge' ? c.browserChrome : 'chrome', 'setBrowserChrome');
			}
		}

		// Address bar flip
		if (!isCustom && (c.browserChrome === 'safari-classic' || c.browserChrome === 'google-chrome')) {
			const flipActive = c.safariClassicFlipped ? ' active' : '';
			html += `<button class="tool-btn${flipActive}" data-action="toggleSafariFlip" title="Flip address bar position">Flip</button>`;
		}

		// Chrome theme toggle
		if (!isCustom && c.browserChrome !== 'none') {
			html += this.togglePill('theme', [
				{ value: 'dark', label: 'Dark' },
				{ value: 'light', label: 'Light' },
			], c.chromeTheme, 'setChromeTheme');
		}

		// Desktop: OS frame + taskbar
		if (isDesktop) {
			html += '<span class="sep"></span>';
			html += this.smallDropdown('OS', [
				{ value: 'macos', label: 'macOS' },
				{ value: 'windows-11', label: 'Win 11' },
				{ value: 'windows-10', label: 'Win 10' },
			], c.osFrame === 'none' ? 'macos' : c.osFrame, 'setOsFrame');

			if (c.osFrame !== 'none' && (c.browserChrome === 'chrome' || c.browserChrome === 'edge')) {
				const tbActive = c.showTaskbar ? ' active' : '';
				html += `<button class="tool-btn${tbActive}" data-action="toggleTaskbar" title="Toggle OS taskbar">Taskbar</button>`;
			}
		}

		if (!isCustom) { html += '<span class="sep"></span>'; }

		// Orientation
		if (!isCustom && device.category !== 'laptop') {
			const oActive = c.orientation === 'landscape' ? ' active' : '';
			html += `<button class="tool-btn${oActive}" data-action="toggleOrientation" title="Toggle orientation">${c.orientation === 'portrait' ? '\u25AF' : '\u25AD'}</button>`;
		}

		// Bottom nav override
		if (isMobile && c.browserChrome !== 'none') {
			html += this.togglePill('bottomNav', [
				{ value: 'auto', label: 'Auto' },
				{ value: 'on', label: 'Nav' },
				{ value: 'off', label: 'No Nav' },
			], c.bottomNavOverride, 'setBottomNav');
		}

		// Debug overlay
		const debugActive = this.config.showDebugOverlay ? ' active' : '';
		html += `<button class="tool-btn${debugActive}" data-action="toggleDebugOverlay" title="Toggle debug overlay">Debug</button>`;

		html += '<div class="toolbar-spacer"></div>';

		// DevTools button
		html += `<button class="tool-btn" id="ap-btn-devtools" title="Open DevTools (F12)">DevTools</button>`;

		// Presets dropdown
		html += '<div class="dropdown" id="ap-presets-dropdown">';
		html += '<button class="dropdown-trigger">Presets</button>';
		html += '<div class="dropdown-menu dropdown-right">';
		for (const preset of ALL_PRESETS) {
			html += `<button class="dropdown-item" data-preset-id="${preset.id}">${preset.label}</button>`;
		}
		html += '</div></div>';

		html += '</div>'; // toolbar-row

		// Row 2: URL bar + action buttons
		html += '<div class="toolbar-row url-row">';
		html += `<div class="url-bar">
			<input id="ap-url-input" type="text" placeholder="Enter URL or start a dev server..." value="${this.escHtml(this.currentDisplayUrl)}" />
			<button id="ap-btn-refresh" title="Refresh"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
		</div>`;
		html += `<button id="ap-btn-screenshot" class="action-btn" title="Screenshot"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></button>`;
		html += `<button id="ap-btn-clip" class="action-btn" title="Clip last 3 seconds"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg></button>`;
		html += `<button id="ap-btn-restart-build" class="action-btn" title="Restart Build"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 .49-7.5L1 10"/></svg></button>`;
		html += '</div>'; // toolbar-row

		return html;
	}

	private togglePill(_id: string, options: { value: string; label: string }[], current: string, action: string): string {
		let html = `<div class="toggle-pill" data-action="${action}">`;
		for (const opt of options) {
			const sel = opt.value === current ? ' selected' : '';
			html += `<button class="pill-opt${sel}" data-value="${opt.value}">${opt.label}</button>`;
		}
		html += '</div>';
		return html;
	}

	private smallDropdown(label: string, options: { value: string; label: string }[], current: string, action: string): string {
		const selected = options.find(o => o.value === current);
		let html = '<div class="dropdown small-dropdown">';
		html += `<button class="dropdown-trigger">${label}: ${selected?.label ?? current}</button>`;
		html += `<div class="dropdown-menu" data-action="${action}">`;
		for (const opt of options) {
			const sel = opt.value === current ? ' selected' : '';
			html += `<button class="dropdown-item${sel}" data-value="${opt.value}">${opt.label}</button>`;
		}
		html += '</div></div>';
		return html;
	}

	// ------------------------------------------------------------------
	// Frame builder (ported from previewPanel.ts)
	// Uses <div id="ap-webview-slot"> as placeholder for the <webview>
	// ------------------------------------------------------------------

	private buildFrame(device: DeviceProfile): string {
		const c = this.config;
		if (c.mode === 'custom') {
			return this.buildCustomFrame(c.customWidth, c.customHeight);
		}
		if (device.category === 'phone') { return this.buildPhoneFrame(device); }
		if (device.category === 'tablet') { return this.buildTabletFrame(device); }
		return this.buildLaptopFrame(device);
	}

	private buildCustomFrame(w: number, h: number): string {
		const totalW = w + 16;
		const totalH = h + 16;
		return `<div class="custom-resize-wrapper" style="width:${totalW}px;height:${totalH}px;display:grid;grid-template-columns:${w}px 16px;grid-template-rows:${h}px 16px;flex-shrink:0;flex-grow:0;">
			<div id="ap-device-frame" class="custom" style="width:${w}px;height:${h}px;grid-row:1;grid-column:1;position:relative;overflow:hidden;">
				<div id="ap-webview-slot" style="position:absolute;inset:0;"></div>
			</div>
			<div class="resize-handle resize-r" data-resize="r"><div class="resize-grip"></div></div>
			<div class="resize-handle resize-b" data-resize="b"><div class="resize-grip"></div></div>
			<div class="resize-handle resize-br" data-resize="br"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M9 1L1 9M9 5L5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></div>
		</div>`;
	}

	private buildPhoneFrame(device: DeviceProfile): string {
		const c = this.config;
		const t = device.traits!;
		let w = device.width;
		let h = device.height;
		if (c.orientation === 'landscape') { [w, h] = [h, w]; }

		const portraitW = Math.min(device.width, device.height);
		const ratio = (s: number) => Math.max(Math.floor((portraitW * s) / 390), 1);
		const os = getDeviceOS(device);
		const isLegacy = t.hasHomeButton;

		const naturalType: 'legacy' | 'island' | 'notch' = isLegacy ? 'legacy' : (t.hasDynamicIsland ? 'island' : 'notch');
		const effectiveType: 'legacy' | 'island' | 'notch' = naturalType === 'legacy' ? 'legacy' : (c.iphoneScreenType as 'island' | 'notch');

		let frameWidth: number;
		let bezelRadius: number;
		if (naturalType === 'legacy') {
			frameWidth = 0;
			bezelRadius = t.deviceCornerRadius;
		} else if (os === 'android') {
			frameWidth = ratio(4);
			bezelRadius = ratio(42);
		} else if (naturalType === 'island') {
			frameWidth = ratio(10);
			bezelRadius = ratio(68);
		} else {
			frameWidth = ratio(14);
			bezelRadius = ratio(64);
		}

		const screenCR = naturalType === 'legacy' ? 0 : Math.max(bezelRadius - frameWidth, 0);

		let sbH: number;
		if (os === 'android') { sbH = t.safeAreaTop; }
		else if (effectiveType === 'legacy') { sbH = ratio(20); }
		else if (effectiveType === 'notch') { sbH = ratio(44); }
		else { sbH = ratio(59); }

		let islandHtml = '';
		if (os === 'ios' && naturalType !== 'legacy') {
			if (effectiveType === 'island') {
				const iw = ratio(128), ih = ratio(35), ir = ratio(50), it = ratio(13);
				islandHtml = `<div class="dynamic-island" style="width:${iw}px;height:${ih}px;border-radius:${ir}px;top:${it}px;"></div>`;
			} else {
				const nw = ratio(160), nh = ratio(31), nr = ratio(20);
				islandHtml = `<div class="notch" style="width:${nw}px;height:${nh}px;border-bottom-left-radius:${nr}px;border-bottom-right-radius:${nr}px;"></div>`;
			}
		}

		let statusBarHtml: string;
		if (os === 'android') {
			statusBarHtml = this.buildAndroidStatusBar(w, sbH, c.chromeTheme, screenCR);
		} else if (effectiveType === 'legacy') {
			statusBarHtml = this.buildHomeButtonStatusBar(w, sbH, c.chromeTheme);
		} else {
			const isIsland = effectiveType === 'island';
			const earW = isIsland ? Math.floor((w - ratio(128)) / 2) : Math.floor((w - ratio(160)) / 2);
			const iTop = isIsland ? ratio(13) : 0;
			const iHeight = isIsland ? ratio(35) : sbH;
			statusBarHtml = this.buildModernStatusBar(earW, iTop, iHeight, c.chromeTheme, !isIsland);
		}

		const bottomH = t.safeAreaBottom;
		const hasBrowserChrome = c.browserChrome !== 'none';

		const statusBarBg = (c.browserChrome === 'safari-classic' && !c.safariClassicFlipped)
			? (c.chromeTheme === 'light' ? '#F2F2F7' : '#1C1C1E')
			: (this.pageBackgroundColor || '#000');

		const hostname = this.escHtml(this.getHostname());
		const url = this.currentDisplayUrl ?? '';
		const hasBottomNav = this.resolvedHasBottomNav();
		const chromeHtml = buildBrowserChromeHtml(
			c.browserChrome, c.chromeTheme, hostname, url,
			c.safariClassicFlipped, bottomH, hasBottomNav, false, screenCR,
			this.pageBackgroundColor || undefined,
		);

		const homeIndicatorHtml = (bottomH > 0 && !hasBrowserChrome)
			? `<div class="home-indicator" style="flex-shrink:0;position:relative;z-index:1;height:${bottomH}px;pointer-events:none;display:flex;align-items:flex-end;justify-content:center;"><div class="home-pill" style="width:35%;height:7px;background:#2A2A2C;border-radius:100px;margin-bottom:10px;transition:opacity 0.35s cubic-bezier(0.2,0.9,0.3,1);"></div></div>`
			: '';

		// Webview inset handled by flex layout -- no manual calculation needed

		// Legacy devices (SE)
		if (isLegacy) {
			const legacyRatio = (s: number) => Math.max(Math.floor((portraitW * s) / 375), 1);
			const legacyFW = legacyRatio(22);
			const legacyHalfFW = Math.floor(legacyFW / 2);
			const upperBezelH = legacyRatio(110);
			const lowerBezelH = legacyRatio(110);
			const legacyBezelR = legacyRatio(60);
			const homeBtn = legacyRatio(65);
			const speakerW = legacyRatio(80);
			const speakerH = legacyRatio(10);
			const cameraSize = legacyRatio(10);
			const mHeight = Math.floor((w / 9) * 16);
			const totalW = w + legacyFW * 2;
			const totalH = mHeight + upperBezelH + lowerBezelH;
			const legacyBtnSize = Math.floor(legacyFW * 0.8);
			const legacyBtnPad = Math.max(legacyBtnSize - legacyHalfFW, 0);
			const legacyBtnPos = w + legacyFW + legacyBtnSize;

			return `<div id="ap-device-frame" class="phone" style="position:relative;display:flex;flex-direction:column;width:${totalW + legacyBtnPad * 2}px;height:${totalH}px;padding:0 ${legacyBtnPad}px;">
	<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:${totalW}px;height:${upperBezelH}px;background:#2A2A2C;border-top-left-radius:${legacyBezelR}px;border-top-right-radius:${legacyBezelR}px;position:relative;">
		<div style="position:relative;width:${speakerW}px;height:${speakerH}px;background:#000;border-radius:${speakerH}px;">
			<div style="position:absolute;left:${-legacyRatio(38)}px;bottom:0;width:${cameraSize}px;height:${cameraSize}px;border-radius:${cameraSize}px;background:#000;"></div>
		</div>
	</div>
	<div style="border-left:${legacyFW}px solid #2A2A2C;border-right:${legacyFW}px solid #2A2A2C;overflow:hidden;">
		<div class="screen-area" style="position:relative;width:${w}px;height:${mHeight}px;background:${statusBarBg};overflow:hidden;display:flex;flex-direction:column;">
			<div class="status-bar" style="height:${sbH}px;flex-shrink:0;background:${statusBarBg};position:relative;z-index:10;">${statusBarHtml}</div>
			${chromeHtml.top}
			<div id="ap-webview-slot" style="flex:1;position:relative;min-height:0;"></div>
			${chromeHtml.bottom}
			${homeIndicatorHtml}
		</div>
	</div>
	<div style="display:flex;align-items:center;justify-content:center;width:${totalW}px;height:${lowerBezelH}px;background:#2A2A2C;border-bottom-left-radius:${legacyBezelR}px;border-bottom-right-radius:${legacyBezelR}px;">
		<div style="width:${homeBtn}px;height:${homeBtn}px;border-radius:${homeBtn}px;background:#000;"></div>
	</div>
	<div style="position:absolute;border-radius:${legacyFW}px;top:${legacyRatio(115)}px;right:${legacyBtnPos}px;width:${legacyBtnSize}px;height:${legacyRatio(36)}px;background:#2A2A2C;"></div>
	<div style="position:absolute;border-radius:${legacyFW}px;top:${legacyRatio(185)}px;right:${legacyBtnPos}px;width:${legacyBtnSize}px;height:${legacyRatio(70)}px;background:#2A2A2C;"></div>
	<div style="position:absolute;border-radius:${legacyFW}px;top:${legacyRatio(270)}px;right:${legacyBtnPos}px;width:${legacyBtnSize}px;height:${legacyRatio(70)}px;background:#2A2A2C;"></div>
	<div style="position:absolute;border-radius:${legacyFW}px;top:${legacyRatio(190)}px;left:${legacyBtnPos}px;width:${legacyBtnSize}px;height:${legacyRatio(64)}px;background:#2A2A2C;"></div>
</div>`;
		}

		// Modern phones
		const halfFW = Math.floor(frameWidth / 2);
		const btnSize = Math.floor(frameWidth * 0.9);
		const btnPad = Math.max(btnSize - halfFW, 0);
		const btnPos = w + frameWidth + btnSize;

		const isNotchMode = os === 'ios' && effectiveType === 'notch';
		const notchPadHtml = isNotchMode
			? `<div style="position:absolute;top:${halfFW}px;left:${btnPad}px;width:${w + frameWidth * 2}px;display:flex;justify-content:center;z-index:25;pointer-events:none;"><div style="width:${ratio(160)}px;height:${ratio(20)}px;background:#2A2A2C;"></div></div>`
			: '';

		const isIsland = effectiveType === 'island';
		const silenceTop = ratio(165);
		const volUpTop = ratio(230);
		const volDownTop = ratio(315);
		const powerTop = isIsland ? ratio(280) : ratio(250);

		const buttonsHtml = `
			<div style="position:absolute;border-radius:${frameWidth}px;top:${silenceTop}px;right:${btnPos}px;width:${btnSize}px;height:${ratio(34)}px;background:#2A2A2C;"></div>
			<div style="position:absolute;border-radius:${frameWidth}px;top:${volUpTop}px;right:${btnPos}px;width:${btnSize}px;height:${ratio(65)}px;background:#2A2A2C;"></div>
			<div style="position:absolute;border-radius:${frameWidth}px;top:${volDownTop}px;right:${btnPos}px;width:${btnSize}px;height:${ratio(65)}px;background:#2A2A2C;"></div>
			<div style="position:absolute;border-radius:${frameWidth}px;top:${powerTop}px;left:${btnPos}px;width:${btnSize}px;height:${ratio(105)}px;background:#2A2A2C;"></div>`;

		const containerW = w + frameWidth * 2 + btnPad * 2;
		const containerH = h + frameWidth * 2;

		return `<div id="ap-device-frame" class="phone" style="position:relative;width:${containerW}px;height:${containerH}px;padding:0 ${btnPad}px;">
	<div style="position:relative;border-radius:${bezelRadius}px;border:solid ${frameWidth}px #2A2A2C;overflow:hidden;width:${w}px;">
		<div class="screen-area" style="position:relative;width:${w}px;height:${h}px;background:${statusBarBg};overflow:hidden;display:flex;flex-direction:column;">
			${islandHtml}
			<div class="status-bar" style="height:${sbH}px;flex-shrink:0;background:${statusBarBg};position:relative;z-index:10;">${statusBarHtml}</div>
			${chromeHtml.top}
			<div id="ap-webview-slot" style="flex:1;position:relative;min-height:0;"></div>
			${chromeHtml.bottom}
			${homeIndicatorHtml}
		</div>
	</div>
	${notchPadHtml}
	${buttonsHtml}
</div>`;
	}

	private buildTabletFrame(device: DeviceProfile): string {
		const c = this.config;
		let w = device.width;
		let h = device.height;
		if (c.orientation === 'landscape') { [w, h] = [h, w]; }

		return `<div id="ap-device-frame" class="tablet">
	<div class="screen-area" style="width:${w}px;height:${h}px;">
		<div id="ap-webview-slot" style="width:100%;flex:1;"></div>
	</div>
</div>`;
	}

	private buildLaptopFrame(device: DeviceProfile): string {
		const c = this.config;
		const w = device.width;
		const h = device.height;
		const bezelX = 14;
		const bezelTop = 28;
		const bezelBottom = 14;
		const lidW = w + bezelX * 2;
		const lidH = h + bezelTop + bezelBottom;
		const baseW = lidW + 40;
		const baseH = 18;

		const osFrameHtml = (c.mode === 'desktop' && c.osFrame !== 'none' && !c.fullscreen) ? buildOsFrameHtml(c.osFrame, 'Preview') : '';
		const taskbar = buildTaskbarHtml(c);

		const hostname = this.escHtml(this.getHostname());
		const url = this.currentDisplayUrl ?? '';
		const chromeResult = buildBrowserChromeHtml(
			c.browserChrome, c.chromeTheme, hostname, url,
			false, 0, false, true,
		);
		const chromeHtml = chromeResult.top;

		return `<div id="ap-device-frame" class="laptop">
	<div class="laptop-lid" style="width:${lidW}px;height:${lidH}px;">
		<div class="webcam"></div>
		<div class="screen-area" style="width:${w}px;height:${h}px;margin-top:${bezelTop - 12}px;">
			${taskbar.top}
			${osFrameHtml}
			${chromeHtml}
			<div id="ap-webview-slot" style="width:100%;flex:1;"></div>
			${taskbar.bottom}
		</div>
	</div>
	<div class="laptop-base" style="width:${baseW}px;height:${baseH}px;">
		<div class="trackpad-notch"></div>
	</div>
</div>`;
	}

	// ------------------------------------------------------------------
	// Status bar builders (ported from previewPanel.ts)
	// ------------------------------------------------------------------

	private buildModernStatusBar(earWidth: number, islandTop: number, islandHeight: number, theme: ChromeTheme, isNotch = false): string {
		const color = theme === 'light' ? '#000' : '#fff';
		const iconsSvg = PreviewEditor.statusIconsSvg(color);
		// Notch ears: screen corner radius eats outer edge -- shift content inward
		const inset = isNotch ? Math.round(earWidth * 0.1) : 0;
		const timePad = inset ? `padding-left:${inset}px;box-sizing:border-box;` : '';
		const iconPad = inset ? `padding-right:${inset}px;box-sizing:border-box;` : '';
		return `
			<div class="sb-time" style="left:0;width:${earWidth}px;top:${islandTop}px;height:${islandHeight}px;color:${color};${timePad}">
				<span>${PreviewEditor.currentTime()}</span>
			</div>
			<div class="sb-icons" style="right:0;width:${earWidth}px;top:${islandTop}px;height:${islandHeight}px;${iconPad}">
				${iconsSvg}
			</div>`;
	}

	private buildHomeButtonStatusBar(_w: number, _h: number, theme: ChromeTheme = 'dark'): string {
		const color = theme === 'light' ? '#000' : '#fff';
		const legacyBattery = `<svg width="22" height="11" viewBox="0 0 27 12" fill="none"><rect x=".5" y=".5" width="22" height="11" rx="2.5" stroke="${color}" stroke-width="1" opacity=".35"/><rect x="2" y="2" width="18" height="8" rx="1.5" fill="${color}"/><path d="M24 4v4c.8-.3 1.5-1 1.5-2s-.7-1.7-1.5-2z" fill="${color}" opacity=".4"/></svg>`;
		return `
			<div style="position:absolute;left:6px;top:3px;display:flex;align-items:center;">
				<span style="font-size:12px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-weight:500;color:${color};">Carrier</span>
			</div>
			<div style="position:absolute;left:0;right:0;top:3px;display:flex;align-items:center;justify-content:center;">
				<span style="font-size:12px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-weight:600;color:${color};">${PreviewEditor.currentTime()}</span>
			</div>
			<div style="position:absolute;right:6px;top:4px;display:flex;align-items:center;">
				${legacyBattery}
			</div>`;
	}

	private buildAndroidStatusBar(_w: number, h: number, theme: ChromeTheme, screenCR = 0): string {
		const color = theme === 'light' ? '#000' : '#fff';
		const padL = Math.max(16, Math.floor(screenCR * 0.6));
		const padR = Math.max(12, Math.floor(screenCR * 0.6));
		return `
			<div style="position:absolute;left:${padL}px;top:${Math.floor((h - 12) / 2)}px;">
				<span style="font-size:11.5px;font-family:Roboto,'Google Sans',system-ui,sans-serif;font-weight:500;color:${color};letter-spacing:0.2px;">${PreviewEditor.currentTime()}</span>
			</div>
			<div style="position:absolute;right:${padR}px;top:${Math.floor((h - 10) / 2)}px;display:flex;align-items:center;gap:4px;">
				<svg width="13" height="10" viewBox="0 0 24 18" fill="${color}"><path d="M1 5.5C4.3 2.5 8 1 12 1s7.7 1.5 11 4.5L12 18 1 5.5z" opacity="0.9"/></svg>
				<svg width="11" height="11" viewBox="0 0 12 12" fill="${color}"><path d="M0 12V4l12-4v12H0z" opacity="0.85"/></svg>
				<svg width="20" height="10" viewBox="0 0 22 11" fill="none"><rect x=".5" y=".5" width="18" height="10" rx="2" stroke="${color}" stroke-width="1" opacity=".35"/><rect x="2" y="2" width="14" height="7" rx="1" fill="${color}"/><path d="M20 3.5v4c.6-.2 1.2-.8 1.2-2s-.6-1.8-1.2-2z" fill="${color}" opacity=".35"/></svg>
			</div>`;
	}

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	private static currentTime(): string {
		const d = new Date();
		return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
	}

	private static statusIconsSvg(color: string): string {
		return `<div style="display:flex;align-items:center;gap:7px;">
			<svg width="20" height="13" viewBox="0 0 18 12" fill="${color}"><rect x="0" y="9" width="3" height="3" rx=".7"/><rect x="5" y="6" width="3" height="6" rx=".7"/><rect x="10" y="3" width="3" height="9" rx=".7"/><rect x="15" y="0" width="3" height="12" rx=".7"/></svg>
			<svg width="19" height="14" viewBox="30 160 964 700" fill="${color}"><path d="M512 192c-163 0-326 67.2-443 176.6-6.6 6-6.8 16.2-0.6 22.8l53.4 55.8c6.2 6.6 16.6 6.8 23.2 0.6 46.6-43.2 99.8-77.6 158.6-102 66-27.6 136.2-41.4 208.6-41.4s142.6 14 208.6 41.4c58.8 24.6 112 58.8 158.6 102 6.6 6.2 17 6 23.2-0.6l53.4-55.8c6.2-6.4 6-16.6-0.6-22.8C838 259.2 675 192 512 192z"/><path d="M226.4 555l57.2 56.6c6.2 6 16 6.4 22.4 0.6 56.6-50.2 129.2-77.8 205.8-77.8s149.2 27.4 205.8 77.8c6.4 5.8 16.2 5.4 22.4-0.6l57.2-56.6c6.6-6.6 6.4-17.2-0.6-23.4-75-67.8-175.2-109.2-285-109.2s-210 41.4-285 109.2c-6.6 6.2-6.8 16.8-0.2 23.4z"/><path d="M512 648.4c-46.8 0-89.2 19.6-118.8 51-6 6.4-5.8 16.2 0.4 22.4l106.8 105.4c6.4 6.4 16.8 6.4 23.2 0l106.8-105.4c6.2-6.2 6.4-16 0.4-22.4-29.6-31.2-72-51-118.8-51z"/></svg>
			<svg width="30" height="13" viewBox="0 0 28 12" fill="none"><rect x=".5" y=".5" width="23" height="11" rx="2.5" stroke="${color}" stroke-width="1" opacity=".35"/><rect x="2" y="2" width="19" height="8" rx="1.5" fill="${color}"/><path d="M25 4v4c.8-.3 1.5-1 1.5-2s-.7-1.7-1.5-2z" fill="${color}" opacity=".4"/></svg>
		</div>`;
	}

	private getHostname(): string {
		if (!this.currentDisplayUrl) { return 'localhost'; }
		try { return new URL(this.currentDisplayUrl).hostname; } catch { return this.currentDisplayUrl; }
	}

	private escHtml(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	// ------------------------------------------------------------------
	// Stylesheet loading
	// ------------------------------------------------------------------

	private loadStylesheet(): void {
		// The CSS is loaded via workbench contribution (see autothropic.contribution.ts)
		// No-op here -- styles are applied via the .autothropic-preview-editor namespace
	}

	// ------------------------------------------------------------------
	// Dispose
	// ------------------------------------------------------------------

	override dispose(): void {
		this.cancelIndicatorIdleTimer();
		if (this.scrollDebounce) { clearTimeout(this.scrollDebounce); }
		this._unhookDebugCapture();
		(this.previewService as PreviewService).registerWebview(null);
		this.closeChromeUrlEditor();
		super.dispose();
	}
}

/**
 * Helper: set innerHTML using Trusted Types policy (required by VS Code CSP).
 */
function safeSetInnerHTML(element: HTMLElement, html: string): void {
	if (_ttPolicy) {
		element.innerHTML = _ttPolicy.createHTML(html) as unknown as string;
	} else {
		element.innerHTML = html;
	}
}

/**
 * Helper: wraps ResizeObserver as a Disposable.
 */
class ResizeObserverDisposable extends Disposable {
	private readonly observer: ResizeObserver;

	constructor(element: HTMLElement, callback: () => void) {
		super();
		this.observer = new ResizeObserver(() => callback());
		this.observer.observe(element);
		this._register({
			dispose: () => this.observer.disconnect(),
		});
	}
}

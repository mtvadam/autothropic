/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IPreviewService, ClipThumbnailData } from './preview.js';
import { PreviewEditorInput } from './previewEditorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';

const STORAGE_KEY_URL = 'autothropic.preview.url';

interface ClipFrame {
	previewDataUrl: string;  // ~320px wide PNG data URL for main view
	stripDataUrl: string;    // ~64px wide PNG data URL for filmstrip
	timestamp: number;
}

export class PreviewService extends Disposable implements IPreviewService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeUrl = this._register(new Emitter<string>());
	readonly onDidChangeUrl: Event<string> = this._onDidChangeUrl.event;

	private readonly _onDidChangeConfig = this._register(new Emitter<void>());
	readonly onDidChangeConfig: Event<void> = this._onDidChangeConfig.event;

	private _url: string | null = null;
	private _webviewElement: Electron.WebviewTag | null = null;

	// Clip buffer state
	private _clipFrames: ClipFrame[] = [];
	private _clipSnapshot: ClipFrame[] = [];
	private _clipTimer: number | null = null;
	private _clipActive = false;
	private _clipCapturing = false;
	private readonly _maxClipFrames = 50; // 10 FPS x 5 seconds
	private readonly _captureIntervalMs = 100; // 10 FPS

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this._url = this.storageService.get(STORAGE_KEY_URL, StorageScope.WORKSPACE) ?? null;
	}

	get url(): string | null {
		return this._url;
	}

	setUrl(url: string): void {
		this._url = url;
		this.storageService.store(STORAGE_KEY_URL, url, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidChangeUrl.fire(url);
	}

	reload(): void {
		if (this._webviewElement) {
			this._webviewElement.reload();
		}
	}

	openDevTools(): void {
		if (this._webviewElement) {
			try {
				this._webviewElement.openDevTools();
			} catch (err) {
				console.error('[preview] openDevTools failed:', err);
			}
		}
	}

	async openPreview(): Promise<void> {
		const input = PreviewEditorInput.getInstance();
		await this.editorService.openEditor(input, { pinned: true });
	}

	getWebviewElement(): Electron.WebviewTag | null {
		return this._webviewElement;
	}

	async captureScreenshot(): Promise<string | null> {
		if (!this._webviewElement || !(this._webviewElement as any).isConnected) {
			return null;
		}
		try {
			const nativeImage = await this._webviewElement.capturePage();
			return nativeImage.toDataURL();
		} catch (err) {
			console.error('[preview] captureScreenshot failed:', err);
			return null;
		}
	}

	/** Called by PreviewEditor to register the <webview> element. */
	registerWebview(element: Electron.WebviewTag | null): void {
		this._webviewElement = element;
		if (!element) {
			this._pauseClipBuffer();
		} else {
			// Always recording: auto-start capture when webview is available
			this.startClipBuffer();
		}
	}

	// -----------------------------------------------------------------------
	// Clip Buffer
	// -----------------------------------------------------------------------

	startClipBuffer(): void {
		if (this._clipActive && this._clipTimer) { return; }
		if (!this._webviewElement) { return; }
		this._clipActive = true;
		if (this._clipTimer) { mainWindow.clearInterval(this._clipTimer); }
		this._clipTimer = mainWindow.setInterval(() => this._captureClipFrame(), this._captureIntervalMs);
		console.log('[preview] clip buffer started (10 FPS, always-on)');
	}

	stopClipBuffer(): void {
		// No-op: always recording, old frames evicted past _maxClipFrames
	}

	/** Pause capture but keep existing frames intact */
	private _pauseClipBuffer(): void {
		if (this._clipTimer) {
			mainWindow.clearInterval(this._clipTimer);
			this._clipTimer = null;
		}
		console.log('[preview] clip buffer paused (frames preserved)');
	}

	getClipThumbnails(seconds: number): ClipThumbnailData[] {
		// Auto-start or resume clip buffer if not actively capturing
		if (!this._clipActive || !this._clipTimer) {
			this.startClipBuffer();
		}
		const cutoff = Date.now() - seconds * 1000;
		this._clipSnapshot = this._clipFrames.filter(f => f.timestamp >= cutoff);
		return this._clipSnapshot.map((f, i) => ({
			index: i,
			timestamp: f.timestamp,
			preview: f.previewDataUrl,
			strip: f.stripDataUrl,
		}));
	}

	getSuggestedIndices(seconds: number, maxFrames: number): number[] {
		if (this._clipSnapshot.length === 0) {
			const cutoff = Date.now() - seconds * 1000;
			this._clipSnapshot = this._clipFrames.filter(f => f.timestamp >= cutoff);
		}
		if (this._clipSnapshot.length === 0) { return []; }
		if (this._clipSnapshot.length <= maxFrames) {
			return this._clipSnapshot.map((_, i) => i);
		}
		// Evenly spaced keyframes (safe, no bitmap needed)
		const indices: number[] = [0, this._clipSnapshot.length - 1];
		const step = (this._clipSnapshot.length - 1) / (maxFrames - 1);
		for (let i = 1; i < maxFrames - 1; i++) {
			indices.push(Math.round(step * i));
		}
		return [...new Set(indices)].sort((a, b) => a - b).slice(0, maxFrames);
	}

	grabSelectedDataUrls(indices: number[]): string[] {
		// Return the preview data URLs for selected frames
		// These are already PNG data URLs from capturePage → resize → toDataURL
		const valid = indices.filter(i => i >= 0 && i < this._clipSnapshot.length);
		return valid.map(i => this._clipSnapshot[i].previewDataUrl);
	}

	getClipStatus(): { active: boolean; frameCount: number } {
		return { active: this._clipActive, frameCount: this._clipFrames.length };
	}

	// -----------------------------------------------------------------------
	// Private: Clip Frame Capture (safe -- only uses toDataURL and resize)
	// -----------------------------------------------------------------------

	private async _captureClipFrame(): Promise<void> {
		if (!this._clipActive || this._clipCapturing) { return; }
		if (!this._webviewElement || !(this._webviewElement as any).isConnected) { return; }

		this._clipCapturing = true;
		try {
			const image = await this._webviewElement.capturePage();
			if (!image || image.isEmpty()) {
				this._clipCapturing = false;
				return;
			}

			// Resize for quality preview (~960px wide) and strip (~120px wide)
			// 960px is good quality for export while keeping memory reasonable
			// Using toDataURL() which is safe in sandboxed renderer
			let previewDataUrl: string;
			let stripDataUrl: string;

			try {
				const size = image.getSize();
				// If image is already <= 960px wide, use full resolution
				if (size.width <= 960) {
					previewDataUrl = image.toDataURL();
				} else {
					const previewImg = image.resize({ width: 960 });
					previewDataUrl = previewImg.toDataURL();
				}
			} catch {
				// Fallback: use full-size
				try { previewDataUrl = image.toDataURL(); } catch { previewDataUrl = ''; }
			}

			try {
				const stripImg = image.resize({ width: 120 });
				stripDataUrl = stripImg.toDataURL();
			} catch {
				stripDataUrl = previewDataUrl;
			}

			if (!previewDataUrl) {
				this._clipCapturing = false;
				return;
			}

			this._clipFrames.push({ previewDataUrl, stripDataUrl, timestamp: Date.now() });
			if (this._clipFrames.length > this._maxClipFrames) {
				this._clipFrames.shift();
			}
		} catch {
			// webview may be destroyed -- silently ignore
		}
		this._clipCapturing = false;
	}

	override dispose(): void {
		this._clipActive = false;
		if (this._clipTimer) {
			mainWindow.clearInterval(this._clipTimer);
			this._clipTimer = null;
		}
		this._clipFrames = [];
		this._clipSnapshot = [];
		super.dispose();
	}
}

registerSingleton(IPreviewService, PreviewService, InstantiationType.Delayed);

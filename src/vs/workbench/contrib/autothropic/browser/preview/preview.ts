/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../../base/common/event.js';

export const PREVIEW_EDITOR_ID = 'workbench.editor.autothropicPreview';
export const PREVIEW_INPUT_ID = 'workbench.editors.autothropicPreviewInput';

export interface IPreviewService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeUrl: Event<string>;
	readonly onDidChangeConfig: Event<void>;

	/** Current preview URL (e.g. http://localhost:3000) */
	readonly url: string | null;

	/** Navigate the preview to a URL. */
	setUrl(url: string): void;

	/** Reload the current page. */
	reload(): void;

	/** Open DevTools for the embedded browser. */
	openDevTools(): void;

	/** Open the preview editor tab (create if needed). */
	openPreview(): Promise<void>;

	/** Get the <webview> element (for screenshot capture, etc.) */
	getWebviewElement(): Electron.WebviewTag | null;

	/** Capture a screenshot of the webview content, returns a data URL (png). */
	captureScreenshot(): Promise<string | null>;

	/** Register the webview element (called by PreviewEditor). */
	registerWebview(element: Electron.WebviewTag | null): void;

	// --- Clip Buffer ---

	/** Start continuous clip buffer capture at ~20 FPS. */
	startClipBuffer(): void;

	/** Stop the clip buffer. */
	stopClipBuffer(): void;

	/** Get thumbnails for the last N seconds of captured frames. */
	getClipThumbnails(seconds: number): ClipThumbnailData[];

	/** Run scene detection and return suggested keyframe indices. */
	getSuggestedIndices(seconds: number, maxFrames: number): number[];

	/** Get selected frames as PNG data URLs. */
	grabSelectedDataUrls(indices: number[]): string[];

	/** Check if the clip buffer is active. */
	getClipStatus(): { active: boolean; frameCount: number };
}

export interface ClipThumbnailData {
	index: number;
	timestamp: number;
	preview: string;   // base64 JPEG data URL for main view
	strip: string;     // base64 JPEG data URL for filmstrip
}

export const IPreviewService = createDecorator<IPreviewService>('autothropicPreviewService');

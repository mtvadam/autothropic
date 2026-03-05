/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IPreviewCaptureService } from '../../../../platform/previewCapture/common/previewCapture.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';

// All main-process commands use .mainProcess suffix to avoid conflicting with
// the browser-layer commands in autothropic.contribution.ts which use webview.capturePage().

CommandsRegistry.registerCommand('_autothropic.capture.screenshot.mainProcess', async (accessor, proxyPort: number, deviceInfo?: { width: number; height: number; dpr: number }) => {
	const logService = accessor.get(ILogService);
	try {
		const captureService = accessor.get(IPreviewCaptureService);
		return await captureService.screenshot(proxyPort, deviceInfo);
	} catch (err) {
		logService.error('[previewCapture] screenshot command failed:', err);
		throw err;
	}
});

CommandsRegistry.registerCommand('_autothropic.capture.startClipBuffer.mainProcess', async (accessor, proxyPort: number) => {
	const logService = accessor.get(ILogService);
	try {
		const captureService = accessor.get(IPreviewCaptureService);
		return await captureService.startClipBuffer(proxyPort);
	} catch (err) {
		logService.error('[previewCapture] startClipBuffer command failed:', err);
		throw err;
	}
});

CommandsRegistry.registerCommand('_autothropic.capture.stopClipBuffer.mainProcess', async (accessor) => {
	const logService = accessor.get(ILogService);
	try {
		const captureService = accessor.get(IPreviewCaptureService);
		return await captureService.stopClipBuffer();
	} catch (err) {
		logService.error('[previewCapture] stopClipBuffer command failed:', err);
		throw err;
	}
});

CommandsRegistry.registerCommand('_autothropic.capture.getClipThumbnails.mainProcess', async (accessor, seconds: number) => {
	const logService = accessor.get(ILogService);
	try {
		const captureService = accessor.get(IPreviewCaptureService);
		return await captureService.getClipThumbnails(seconds);
	} catch (err) {
		logService.error('[previewCapture] getClipThumbnails command failed:', err);
		throw err;
	}
});

CommandsRegistry.registerCommand('_autothropic.capture.getSuggestedIndices.mainProcess', async (accessor, seconds: number, maxFrames: number) => {
	const logService = accessor.get(ILogService);
	try {
		const captureService = accessor.get(IPreviewCaptureService);
		return await captureService.getSuggestedIndices(seconds, maxFrames);
	} catch (err) {
		logService.error('[previewCapture] getSuggestedIndices command failed:', err);
		throw err;
	}
});

CommandsRegistry.registerCommand('_autothropic.capture.grabSelected.mainProcess', async (accessor, indices: number[]) => {
	const logService = accessor.get(ILogService);
	try {
		const captureService = accessor.get(IPreviewCaptureService);
		return await captureService.grabSelected(indices);
	} catch (err) {
		logService.error('[previewCapture] grabSelected command failed:', err);
		throw err;
	}
});

CommandsRegistry.registerCommand('_autothropic.capture.getClipStatus.mainProcess', async (accessor) => {
	const logService = accessor.get(ILogService);
	try {
		const captureService = accessor.get(IPreviewCaptureService);
		return await captureService.getClipStatus();
	} catch (err) {
		logService.error('[previewCapture] getClipStatus command failed:', err);
		throw err;
	}
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ILifecycleService, LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchLayoutService, Parts, Position } from '../../../services/layout/browser/layoutService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { PreviewEditor } from './preview/previewEditor.js';
import { PreviewEditorInput } from './preview/previewEditorInput.js';
import { PREVIEW_EDITOR_ID, IPreviewService } from './preview/preview.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';

// Import to trigger service registration side effect
import './preview/previewService.js';

// Import CSS
import './preview/media/preview.css';

// ---------------------------------------------------------------------------
// Layout contribution (unchanged)
// ---------------------------------------------------------------------------

const LAYOUT_INITIALIZED_KEY = 'autothropic.layoutInitialized';

/**
 * Runs once per workspace to set up the Autothropic IDE layout:
 * - Ensures the bottom panel is visible
 * - Focuses the Graph tab in the panel
 * - Sets panel to ~40% height
 */
class AutothropicLayoutContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.autothropicLayout';

	constructor(
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IStorageService private readonly storageService: IStorageService,
		@IViewsService private readonly viewsService: IViewsService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();
		this.initialize();
	}

	private async initialize(): Promise<void> {
		await this.lifecycleService.when(LifecyclePhase.Restored);

		const layoutVersion = this.storageService.getNumber(LAYOUT_INITIALIZED_KEY, StorageScope.WORKSPACE, 0);
		if (layoutVersion >= 2) {
			return;
		}

		// Ensure the bottom panel is visible
		if (!this.layoutService.isVisible(Parts.PANEL_PART)) {
			this.layoutService.setPartHidden(false, Parts.PANEL_PART);
		}

		// Ensure panel is at the bottom
		if (this.layoutService.getPanelPosition() !== Position.BOTTOM) {
			this.layoutService.setPanelPosition(Position.BOTTOM);
		}

		// Focus the terminal in the panel (so build output is visible immediately)
		try {
			await this.viewsService.openView('terminal', false);
		} catch {
			// Terminal may not be ready yet - non-critical
		}

		// Mark as initialized (version 2 = terminal default)
		this.storageService.store(LAYOUT_INITIALIZED_KEY, 2, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

registerWorkbenchContribution2(AutothropicLayoutContribution.ID, AutothropicLayoutContribution, WorkbenchPhase.AfterRestored);

// ---------------------------------------------------------------------------
// Preview contribution -- auto-opens preview editor after restore
// ---------------------------------------------------------------------------

class AutothropicPreviewContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.autothropicPreview';

	constructor(
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this.autoOpenPreview();
	}

	private async autoOpenPreview(): Promise<void> {
		await this.lifecycleService.when(LifecyclePhase.Restored);

		// Auto-open preview tab
		const input = PreviewEditorInput.getInstance();
		await this.editorService.openEditor(input, { pinned: true, preserveFocus: true });
	}
}

registerWorkbenchContribution2(AutothropicPreviewContribution.ID, AutothropicPreviewContribution, WorkbenchPhase.AfterRestored);

// ---------------------------------------------------------------------------
// Register EditorPane
// ---------------------------------------------------------------------------

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		PreviewEditor,
		PREVIEW_EDITOR_ID,
		'Preview',
	),
	[new SyncDescriptor(PreviewEditorInput)],
);

// ---------------------------------------------------------------------------
// Register EditorSerializer (for persistence across reloads)
// ---------------------------------------------------------------------------

class PreviewEditorInputSerializer {
	canSerialize(_editorInput: PreviewEditorInput): boolean {
		return true;
	}

	serialize(_editorInput: PreviewEditorInput): string {
		return '{}';
	}

	deserialize(_instantiationService: IInstantiationService, _serializedEditorInput: string): PreviewEditorInput {
		return PreviewEditorInput.getInstance();
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(PreviewEditorInput.ID, PreviewEditorInputSerializer);

// ---------------------------------------------------------------------------
// Register commands (extension → core bridge)
// ---------------------------------------------------------------------------

CommandsRegistry.registerCommand('_autothropic.preview.open', (accessor) => {
	const previewService = accessor.get(IPreviewService);
	previewService.openPreview();
});

CommandsRegistry.registerCommand('_autothropic.preview.setUrl', (accessor, url: string) => {
	const previewService = accessor.get(IPreviewService);
	previewService.setUrl(url);
});

CommandsRegistry.registerCommand('_autothropic.preview.reload', (accessor) => {
	const previewService = accessor.get(IPreviewService);
	previewService.reload();
});

CommandsRegistry.registerCommand('_autothropic.preview.openDevTools', (accessor) => {
	const previewService = accessor.get(IPreviewService);
	previewService.openDevTools();
});

CommandsRegistry.registerCommand('_autothropic.capture.screenshot', async (accessor) => {
	const previewService = accessor.get(IPreviewService);
	const dataUrl = await previewService.captureScreenshot();
	return dataUrl ? { dataUrl } : null;
});

// ---------------------------------------------------------------------------
// Clip buffer commands (renderer-side, using webview.capturePage)
// ---------------------------------------------------------------------------

CommandsRegistry.registerCommand('_autothropic.capture.startClipBuffer', (accessor) => {
	const previewService = accessor.get(IPreviewService);
	previewService.startClipBuffer();
});

CommandsRegistry.registerCommand('_autothropic.capture.stopClipBuffer', (accessor) => {
	const previewService = accessor.get(IPreviewService);
	previewService.stopClipBuffer();
});

CommandsRegistry.registerCommand('_autothropic.capture.getClipThumbnails', async (accessor, seconds: number) => {
	const previewService = accessor.get(IPreviewService);
	return await previewService.getClipThumbnails(seconds);
});

CommandsRegistry.registerCommand('_autothropic.capture.getSuggestedIndices', (accessor, seconds: number, maxFrames: number) => {
	const previewService = accessor.get(IPreviewService);
	return previewService.getSuggestedIndices(seconds, maxFrames);
});

CommandsRegistry.registerCommand('_autothropic.capture.grabSelected', async (accessor, indices: number[]) => {
	const previewService = accessor.get(IPreviewService);
	// Get buffer thumbnails for the selected frames
	const dataUrls = previewService.grabSelectedDataUrls(indices);
	// Try to capture a full-resolution frame to replace the first selected thumbnail
	const fullRes = await previewService.captureFullResFrame();
	if (fullRes && dataUrls.length > 0) {
		// Replace the most recent frame with the full-res capture
		dataUrls[dataUrls.length - 1] = fullRes;
	}
	return { filePaths: [], dataUrls };
});

CommandsRegistry.registerCommand('_autothropic.capture.getClipStatus', (accessor) => {
	const previewService = accessor.get(IPreviewService);
	return previewService.getClipStatus();
});

CommandsRegistry.registerCommand('_autothropic.capture.fullResFrame', async (accessor) => {
	const previewService = accessor.get(IPreviewService);
	return await previewService.captureFullResFrame();
});

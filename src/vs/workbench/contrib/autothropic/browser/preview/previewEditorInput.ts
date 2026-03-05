/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../../common/editor/editorInput.js';
import { EditorInputCapabilities } from '../../../../common/editor.js';
import { URI } from '../../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { PREVIEW_INPUT_ID, PREVIEW_EDITOR_ID } from './preview.js';

export class PreviewEditorInput extends EditorInput {

	static readonly ID = PREVIEW_INPUT_ID;
	static readonly RESOURCE = URI.from({ scheme: 'autothropic-preview', authority: 'preview' });

	private static _instance: PreviewEditorInput | undefined;

	static getInstance(): PreviewEditorInput {
		if (!PreviewEditorInput._instance) {
			PreviewEditorInput._instance = new PreviewEditorInput();
		}
		return PreviewEditorInput._instance;
	}

	override get typeId(): string {
		return PreviewEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return PREVIEW_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly
			| EditorInputCapabilities.Singleton
			| EditorInputCapabilities.Uncloseable;
	}

	override get resource(): URI | undefined {
		return PreviewEditorInput.RESOURCE;
	}

	override getName(): string {
		return 'Preview';
	}

	override getIcon(): ThemeIcon | undefined {
		return Codicon.openPreview;
	}

	override matches(other: EditorInput | unknown): boolean {
		return other instanceof PreviewEditorInput;
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import { Builder, Dimension } from 'vs/base/browser/builder';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { EditorOptions } from 'vs/workbench/common/editor';
import { BaseEditor } from 'vs/workbench/browser/parts/editor/baseEditor';
import { U2DEntityFileInput } from 'vs/workbench/parts/u2d/common/u2dEntityFileInput';
import { U2D_VISUAL_EDITOR_ID } from 'vs/workbench/parts/u2d/common/u2d';

export class U2DVisualEditor extends BaseEditor {

	public static readonly ID = U2D_VISUAL_EDITOR_ID;

	private _webview: any;

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
	) {
		super(U2DVisualEditor.ID, telemetryService, themeService);

		this._webview = <any>document.createElement('iframe');

		this._webview.style.width = '100%';
		this._webview.style.height = '100%';
		this._webview.style.outline = '0';
		this._webview.style.border = 'none';
		this._webview.style.backgroundColor = 'transparent';

		this._webview.src = require.toUrl('./editor.html');
	}

	public setInput(input: U2DEntityFileInput, options?: EditorOptions): TPromise<void> {
		// const oldInput = this.input;
		return super.setInput(input, options);

		// TODO
	}

	protected createEditor(parent: Builder): void {
		parent.append(this._webview);
	}

	public layout(dimension: Dimension): void {

	}

}
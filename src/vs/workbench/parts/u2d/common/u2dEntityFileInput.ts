'use strict';

import URI from 'vs/base/common/uri';
import { FileEditorInput } from 'vs/workbench/parts/files/common/editors/fileEditorInput';
import { U2D_VISUAL_EDITOR_ID } from 'vs/workbench/parts/u2d/common/u2d';

export class U2DEntityFileInput extends FileEditorInput {

	public static isEntityFile(resource: URI): boolean {
		return /\.entity\.json$/i.test(resource.fsPath);
	}

	public getPreferredEditorId(candidates: string[]): string {
		return U2D_VISUAL_EDITOR_ID;
	}

}
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import { onUnexpectedError, illegalArgument } from 'vs/base/common/errors';
import { IDisposable } from 'vs/base/common/lifecycle';
import { CommonEditorRegistry } from 'vs/editor/common/editorCommonExtensions';
import { ISearchConfiguration } from 'vs/platform/search/common/search';
import glob = require('vs/base/common/glob');
import { SymbolInformation } from 'vs/editor/common/modes';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import URI from 'vs/base/common/uri';
import { toResource } from 'vs/workbench/common/editor';

export interface IWorkspaceSymbolProvider {
	provideWorkspaceSymbols(search: string): TPromise<SymbolInformation[]>;
	resolveWorkspaceSymbol?: (item: SymbolInformation) => TPromise<SymbolInformation>;
}

export namespace WorkspaceSymbolProviderRegistry {

	const _supports: IWorkspaceSymbolProvider[] = [];

	export function register(support: IWorkspaceSymbolProvider): IDisposable {

		if (support) {
			_supports.push(support);
		}

		return {
			dispose() {
				if (support) {
					let idx = _supports.indexOf(support);
					if (idx >= 0) {
						_supports.splice(idx, 1);
						support = undefined;
					}
				}
			}
		};
	}

	export function all(): IWorkspaceSymbolProvider[] {
		return _supports.slice(0);
	}
}

export function getWorkspaceSymbols(query: string): TPromise<[IWorkspaceSymbolProvider, SymbolInformation[]][]> {

	const result: [IWorkspaceSymbolProvider, SymbolInformation[]][] = [];

	const promises = WorkspaceSymbolProviderRegistry.all().map(support => {
		return support.provideWorkspaceSymbols(query).then(value => {
			if (Array.isArray(value)) {
				result.push([support, value]);
			}
		}, onUnexpectedError);
	});

	return TPromise.join(promises).then(_ => result);
}

CommonEditorRegistry.registerLanguageCommand('_executeWorkspaceSymbolProvider', function (accessor, args: { query: string; }) {
	let { query } = args;
	if (typeof query !== 'string') {
		throw illegalArgument();
	}
	return getWorkspaceSymbols(query);
});

export interface IWorkbenchSearchConfiguration extends ISearchConfiguration {
	search: {
		quickOpen: {
			includeSymbols: boolean;
		},
		exclude: glob.IExpression,
		useRipgrep: boolean,
		useIgnoreFilesByDefault: boolean
	};
}

/**
 * Helper to return all opened editors with resources not belonging to the currently opened workspace.
 */
export function getOutOfWorkspaceEditorResources(editorGroupService: IEditorGroupService, contextService: IWorkspaceContextService): URI[] {
	const resources: URI[] = [];

	editorGroupService.getStacksModel().groups.forEach(group => {
		const editors = group.getEditors();
		editors.forEach(editor => {
			const fileResource = toResource(editor, { supportSideBySide: true, filter: 'file' });
			if (fileResource && !contextService.isInsideWorkspace(fileResource)) {
				resources.push(fileResource);
			}
		});
	});

	return resources;
}
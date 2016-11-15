/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import uri from 'vs/base/common/uri';
import paths = require('vs/base/common/paths');
import { IconLabel, IIconLabelOptions, IIconLabelCreationOptions } from 'vs/base/browser/ui/iconLabel/iconLabel';
import { IExtensionService } from 'vs/platform/extensions/common/extensions';
import { IModeService } from 'vs/editor/common/services/modeService';
import { IEditorInput } from 'vs/platform/editor/common/editor';
import { getResource } from 'vs/workbench/common/editor';
import { getPathLabel } from 'vs/base/common/labels';
import { PLAINTEXT_MODE_ID } from 'vs/editor/common/modes/modesRegistry';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IMarkerService, IMarkerFilter } from 'vs/platform/markers/common/markers';
import Severity from 'vs/base/common/severity';
import { isEqual, isParent } from 'vs/platform/files/common/files';

export interface IEditorLabel {
	name: string;
	description?: string;
	resource?: uri;
}

export interface IResourceLabelOptions extends IIconLabelOptions {
	isFolder?: boolean;
}

export interface IResourceLabelCreationOptions extends IIconLabelCreationOptions {
	showSeverity?: boolean;
}

export class ResourceLabel extends IconLabel {
	private toDispose: IDisposable[];
	private label: IEditorLabel;
	private options: IResourceLabelOptions;
	private showSeverity: boolean;

	constructor(
		container: HTMLElement,
		options: IResourceLabelCreationOptions,
		@IExtensionService private extensionService: IExtensionService,
		@IWorkspaceContextService protected contextService: IWorkspaceContextService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IModeService private modeService: IModeService,
		@IModelService private modelService: IModelService,
		@IMarkerService private markerService: IMarkerService
	) {
		super(container, options);

		this.toDispose = [];
		this.showSeverity = options && options.showSeverity;

		this.registerListeners();
	}

	private registerListeners(): void {
		this.extensionService.onReady().then(() => this.render()); // update when extensions are loaded with potentially new languages
		this.toDispose.push(this.configurationService.onDidUpdateConfiguration(() => this.render())); // update when file.associations change

		if (this.showSeverity) {
			this.toDispose.push(this.markerService.onMarkerChanged(marker => this.onMarkerChanged(marker))); // update when markers change
		}
	}

	private onMarkerChanged(resources: uri[]): void {
		if (resources.some(r => isEqual(r.fsPath, this.label.resource.fsPath) || isParent(r.fsPath, this.label.resource.fsPath))) {
			let options: { filter: IMarkerFilter };
			if (resources.length === 1) {
				options = { filter: { resource: resources[0] } }; // speed up markers lookup by filtering for the one resource that changed
			}

			this.render(options);
		}
	}

	public setLabel(label: IEditorLabel, options?: IResourceLabelOptions): void {
		this.label = label;
		this.options = options;

		this.render();
	}

	public clear(): void {
		this.label = void 0;
		this.options = void 0;

		this.setValue();
	}

	private render(options?: { filter: IMarkerFilter }): void {
		if (!this.label) {
			return;
		}

		const resource = this.label.resource;

		let title = '';
		if (this.options && this.options.title) {
			title = this.options.title;
		} else if (resource) {
			title = getPathLabel(resource.fsPath);
		}

		const extraClasses = getIconClasses(this.modelService, this.modeService, resource, this.options && this.options.isFolder);
		if (this.options && this.options.extraClasses) {
			extraClasses.push(...this.options.extraClasses);
		}

		let severity: Severity;
		if (this.showSeverity) {
			const markers = this.markerService.read(options ? options.filter : void 0);
			for (let i = 0; i < markers.length; i++) {
				const marker = markers[i];

				if (marker.severity === Severity.Info) {
					continue; // we only want warnings and errors
				}

				if (isEqual(marker.resource.fsPath, resource.fsPath) || isParent(marker.resource.fsPath, resource.fsPath)) {
					severity = marker.severity;

					if (severity === Severity.Error) {
						break;
					}
				}
			}

			if (severity === Severity.Error) {
				title = `${title}\nError(s) found.`;
			} else if (severity === Severity.Warning) {
				title = `${title}\nWarning(s) found.`;
			}
		}

		const italic = this.options && this.options.italic;
		const matches = this.options && this.options.matches;

		this.setValue(this.label.name, this.label.description, { title, extraClasses, italic, matches, severity });
	}

	public dispose(): void {
		super.dispose();

		this.toDispose = dispose(this.toDispose);
		this.label = void 0;
		this.options = void 0;
	}
}

export class EditorLabel extends ResourceLabel {

	public setEditor(editor: IEditorInput, options?: IResourceLabelOptions): void {
		this.setLabel({
			resource: getResource(editor),
			name: editor.getName(),
			description: editor.getDescription()
		}, options);
	}
}

export interface IFileLabelOptions extends IResourceLabelOptions {
	hideLabel?: boolean;
	hidePath?: boolean;
}

export class FileLabel extends ResourceLabel {

	public setFile(resource: uri, options: IFileLabelOptions = Object.create(null)): void {
		this.setLabel({
			resource,
			name: !options.hideLabel ? paths.basename(resource.fsPath) : void 0,
			description: !options.hidePath ? getPathLabel(paths.dirname(resource.fsPath), this.contextService) : void 0
		}, options);
	}
}

export function getIconClasses(modelService: IModelService, modeService: IModeService, resource: uri, isFolder?: boolean): string[] {
	let path: string;
	let configuredLangId: string;
	if (resource) {
		path = resource.fsPath;
		const model = modelService.getModel(resource);
		if (model) {
			const modeId = model.getModeId();
			if (modeId && modeId !== PLAINTEXT_MODE_ID) {
				configuredLangId = modeId; // only take if the mode is specific (aka no just plain text)
			}
		}
	}

	// we always set these base classes even if we do not have a path
	const classes = isFolder ? ['folder-icon'] : ['file-icon'];

	if (path) {
		const basename = paths.basename(path);
		const dotSegments = basename.split('.');

		// Folders
		if (isFolder) {
			if (basename) {
				classes.push(`${basename.toLowerCase()}-name-folder-icon`);
			}
		}

		// Files
		else {

			// Name
			const name = dotSegments[0]; // file.txt => "file", .dockerfile => "", file.some.txt => "file"
			if (name) {
				classes.push(`${cssEscape(name.toLowerCase())}-name-file-icon`);
			}

			// Extension(s)
			const extensions = dotSegments.splice(1);
			if (extensions.length > 0) {
				for (let i = 0; i < extensions.length; i++) {
					classes.push(`${cssEscape(extensions.slice(i).join('.').toLowerCase())}-ext-file-icon`); // add each combination of all found extensions if more than one
				}
			}

			// Configured Language
			configuredLangId = configuredLangId || modeService.getModeIdByFilenameOrFirstLine(path);
			if (configuredLangId) {
				classes.push(`${cssEscape(configuredLangId)}-lang-file-icon`);
			}
		}
	}

	return classes;
}

function cssEscape(val: string): string {
	return val.replace(/\s/g, '\\$&'); // make sure to not introduce CSS classes from files that contain whitespace
}
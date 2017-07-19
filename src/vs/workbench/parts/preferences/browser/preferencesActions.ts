/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import * as nls from 'vs/nls';
import URI from 'vs/base/common/uri';
import { Action } from 'vs/base/common/actions';
import { IModeService } from 'vs/editor/common/services/modeService';
import { IQuickOpenService, IPickOpenEntry, IFilePickOpenEntry } from 'vs/platform/quickOpen/common/quickOpen';
import { IPreferencesService, getSettingsTargetName } from 'vs/workbench/parts/preferences/common/preferences';
import { IWorkspaceContextService } from "vs/platform/workspace/common/workspace";

export class OpenGlobalSettingsAction extends Action {

	public static ID = 'workbench.action.openGlobalSettings';
	public static LABEL = nls.localize('openGlobalSettings', "Open User Settings");

	constructor(
		id: string,
		label: string,
		@IPreferencesService private preferencesService: IPreferencesService
	) {
		super(id, label);
	}

	public run(event?: any): TPromise<any> {
		return this.preferencesService.openGlobalSettings();
	}
}

export class OpenGlobalKeybindingsAction extends Action {

	public static ID = 'workbench.action.openGlobalKeybindings';
	public static LABEL = nls.localize('openGlobalKeybindings', "Open Keyboard Shortcuts");

	constructor(
		id: string,
		label: string,
		@IPreferencesService private preferencesService: IPreferencesService
	) {
		super(id, label);
	}

	public run(event?: any): TPromise<any> {
		return this.preferencesService.openGlobalKeybindingSettings(false);
	}
}

export class OpenGlobalKeybindingsFileAction extends Action {

	public static ID = 'workbench.action.openGlobalKeybindingsFile';
	public static LABEL = nls.localize('openGlobalKeybindingsFile', "Open Keyboard Shortcuts File");

	constructor(
		id: string,
		label: string,
		@IPreferencesService private preferencesService: IPreferencesService
	) {
		super(id, label);
	}

	public run(event?: any): TPromise<any> {
		return this.preferencesService.openGlobalKeybindingSettings(true);
	}
}

export class OpenWorkspaceSettingsAction extends Action {

	public static ID = 'workbench.action.openWorkspaceSettings';
	public static LABEL = nls.localize('openWorkspaceSettings', "Open Workspace Settings");

	constructor(
		id: string,
		label: string,
		@IPreferencesService private preferencesService: IPreferencesService,
		@IWorkspaceContextService private workspaceContextService: IWorkspaceContextService
	) {
		super(id, label);
		this.enabled = this.workspaceContextService.hasWorkspace();
	}

	public run(event?: any): TPromise<any> {
		return this.preferencesService.openWorkspaceSettings();
	}
}

export class OpenFolderSettingsAction extends Action {

	public static ID = 'workbench.action.openFolderSettings';
	public static LABEL = nls.localize('openFolderSettings', "Open Folder Settings");

	constructor(
		id: string,
		label: string,
		@IPreferencesService private preferencesService: IPreferencesService,
		@IWorkspaceContextService private workspaceContextService: IWorkspaceContextService,
		@IQuickOpenService private quickOpenService: IQuickOpenService
	) {
		super(id, label);
		this.enabled = this.workspaceContextService.hasMultiFolderWorkspace();
	}

	public run(): TPromise<any> {
		const picks: IPickOpenEntry[] = this.workspaceContextService.getWorkspace().roots.map((root, index) => {
			return <IPickOpenEntry>{
				label: getSettingsTargetName(root, this.workspaceContextService),
				id: `${index}`
			};
		});

		return this.quickOpenService.pick(picks, { placeHolder: nls.localize('pickFolder', "Select Folder") })
			.then(pick => {
				if (pick) {
					return this.preferencesService.openSettings(this.workspaceContextService.getWorkspace().roots[parseInt(pick.id)]);
				}
				return undefined;
			});

	}
}

export class ConfigureLanguageBasedSettingsAction extends Action {

	public static ID = 'workbench.action.configureLanguageBasedSettings';
	public static LABEL = nls.localize('configureLanguageBasedSettings', "Configure Language Specific Settings...");

	constructor(
		id: string,
		label: string,
		@IModeService private modeService: IModeService,
		@IQuickOpenService private quickOpenService: IQuickOpenService,
		@IPreferencesService private preferencesService: IPreferencesService
	) {
		super(id, label);
	}

	public run(): TPromise<any> {
		const languages = this.modeService.getRegisteredLanguageNames();
		const picks: IPickOpenEntry[] = languages.sort().map((lang, index) => {
			let description: string = nls.localize('languageDescriptionConfigured', "({0})", this.modeService.getModeIdForLanguageName(lang.toLowerCase()));
			// construct a fake resource to be able to show nice icons if any
			let fakeResource: URI;
			const extensions = this.modeService.getExtensions(lang);
			if (extensions && extensions.length) {
				fakeResource = URI.file(extensions[0]);
			} else {
				const filenames = this.modeService.getFilenames(lang);
				if (filenames && filenames.length) {
					fakeResource = URI.file(filenames[0]);
				}
			}
			return <IFilePickOpenEntry>{
				label: lang,
				resource: fakeResource,
				description
			};
		});

		return this.quickOpenService.pick(picks, { placeHolder: nls.localize('pickLanguage', "Select Language") })
			.then(pick => {
				if (pick) {
					return this.modeService.getOrCreateModeByLanguageName(pick.label)
						.then(mode => this.preferencesService.configureSettingsForLanguage(mode.getLanguageIdentifier().language));
				}
				return undefined;
			});

	}
}
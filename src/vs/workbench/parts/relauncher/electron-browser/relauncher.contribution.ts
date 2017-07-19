/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { IWorkbenchContributionsRegistry, IWorkbenchContribution, Extensions as WorkbenchExtensions } from 'vs/workbench/common/contributions';
import { Registry } from 'vs/platform/registry/common/platform';
import { IMessageService } from 'vs/platform/message/common/message';
import { IPreferencesService } from 'vs/workbench/parts/preferences/common/preferences';
import { IWindowsService, IWindowService, IWindowsConfiguration } from 'vs/platform/windows/common/windows';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { localize } from 'vs/nls';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';

interface IConfiguration extends IWindowsConfiguration {
	update: { channel: string; };
	telemetry: { enableCrashReporter: boolean };
}

export class SettingsChangeRelauncher implements IWorkbenchContribution {

	private toDispose: IDisposable[] = [];

	private titleBarStyle: 'native' | 'custom';
	private nativeTabs: boolean;
	private updateChannel: string;
	private enableCrashReporter: boolean;
	private rootCount: number;
	private firstRootPath: string;

	constructor(
		@IWindowsService private windowsService: IWindowsService,
		@IWindowService private windowService: IWindowService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IPreferencesService private preferencesService: IPreferencesService,
		@IEnvironmentService private envService: IEnvironmentService,
		@IMessageService private messageService: IMessageService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService
	) {
		this.rootCount = this.contextService.hasWorkspace() ? this.contextService.getWorkspace().roots.length : 0;
		this.firstRootPath = this.contextService.hasWorkspace() ? this.contextService.getWorkspace().roots[0].fsPath : void 0;
		this.onConfigurationChange(configurationService.getConfiguration<IConfiguration>(), false);

		this.registerListeners();
	}

	private registerListeners(): void {
		this.toDispose.push(this.configurationService.onDidUpdateConfiguration(e => this.onConfigurationChange(this.configurationService.getConfiguration<IConfiguration>(), true)));
		this.toDispose.push(this.contextService.onDidChangeWorkspaceRoots(() => this.onDidChangeWorkspaceRoots()));
	}

	private onConfigurationChange(config: IConfiguration, notify: boolean): void {
		let changed = false;

		// Titlebar style
		if (config.window && config.window.titleBarStyle !== this.titleBarStyle && (config.window.titleBarStyle === 'native' || config.window.titleBarStyle === 'custom')) {
			this.titleBarStyle = config.window.titleBarStyle;
			changed = true;
		}

		// Native tabs
		if (config.window && typeof config.window.nativeTabs === 'boolean' && config.window.nativeTabs !== this.nativeTabs) {
			this.nativeTabs = config.window.nativeTabs;
			changed = true;
		}

		// Update channel
		if (config.update && typeof config.update.channel === 'string' && config.update.channel !== this.updateChannel) {
			this.updateChannel = config.update.channel;
			changed = true;
		}

		// Crash reporter
		if (config.telemetry && typeof config.telemetry.enableCrashReporter === 'boolean' && config.telemetry.enableCrashReporter !== this.enableCrashReporter) {
			this.enableCrashReporter = config.telemetry.enableCrashReporter;
			changed = true;
		}

		// Notify only when changed and we are the focused window (avoids notification spam across windows)
		if (notify && changed) {
			this.doConfirm(
				localize('relaunchSettingMessage', "A setting has changed that requires a restart to take effect."),
				localize('relaunchSettingDetail', "Press the restart button to restart {0} and enable the setting.", this.envService.appNameLong),
				localize('restart', "Restart"),
				() => this.windowsService.relaunch(Object.create(null))
			);
		}
	}

	private onDidChangeWorkspaceRoots(): void {
		const newRootCount = this.contextService.hasWorkspace() ? this.contextService.getWorkspace().roots.length : 0;
		const newFirstRootPath = this.contextService.hasWorkspace() ? this.contextService.getWorkspace().roots[0].fsPath : void 0;

		let reload = false;
		if (this.rootCount === 0 && newRootCount > 0) {
			reload = true; // transition: from 0 folders to 1+
		} else if (this.rootCount > 0 && newRootCount === 0) {
			reload = true; // transition: from 1+ folders to 0
		}

		if (this.firstRootPath !== newFirstRootPath) {
			reload = true; // first root folder changed
		}

		this.rootCount = newRootCount;
		this.firstRootPath = newFirstRootPath;

		if (reload) {
			this.doConfirm(
				localize('relaunchWorkspaceMessage', "A workspace folder was added or removed and that requires a reload to take effect."),
				localize('relaunchWorkspaceDetail', "Press the restart button to reload the window and enable the changes to the workspace.", this.envService.appNameLong),
				localize('reload', "Reload"),
				() => this.windowService.reloadWindow()
			);
		}
	}

	private doConfirm(message: string, detail: string, primaryButton: string, confirmed: () => void): void {
		this.windowService.isFocused().then(focused => {
			if (focused) {
				const confirm = this.messageService.confirm({
					type: 'info',
					message,
					detail,
					primaryButton
				});

				if (confirm) {
					confirmed();
				}
			}
		});
	}

	public getId(): string {
		return 'workbench.relauncher';
	}

	public dispose(): void {
		this.toDispose = dispose(this.toDispose);
	}
}

const workbenchRegistry = <IWorkbenchContributionsRegistry>Registry.as(WorkbenchExtensions.Workbench);
workbenchRegistry.registerWorkbenchContribution(SettingsChangeRelauncher);

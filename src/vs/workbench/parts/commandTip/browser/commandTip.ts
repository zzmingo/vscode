/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./commandTip';

import { $, Builder } from 'vs/base/browser/builder';
import { Action } from 'vs/base/common/actions';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { onUnexpectedError } from 'vs/base/common/errors';
import Severity from 'vs/base/common/severity';
import { isKeybindingFile } from 'vs/editor/contrib/defineKeybinding/browser/defineKeybinding';
import * as nls from 'vs/nls';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { ICommandService } from 'vs/platform/commands/common/commands';

import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { Extensions, IConfigurationRegistry } from 'vs/platform/configuration/common/configurationRegistry';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { IMessageService } from 'vs/platform/message/common/message';
import { Registry } from 'vs/platform/platform';

import { OpenGlobalSettingsAction } from 'vs/workbench/browser/actions/openSettings';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from 'vs/workbench/common/contributions';
import { IEditorStacksModel } from 'vs/workbench/common/editor';
import { FileEditorInput } from 'vs/workbench/parts/files/common/files';
import { IConfigurationEditingService, ConfigurationTarget } from 'vs/workbench/services/configuration/common/configurationEditing';
import { IEditorGroupService } from 'vs/workbench/services/group/common/groupService';
import { Parts, IPartService } from 'vs/workbench/services/part/common/partService';

const COMMAND_LABEL = nls.localize('commandTip.showCommands', "Show All Commands");
const COMMAND_ID = 'workbench.action.showCommands';

const CLOSED_MESSAGE = nls.localize('commandTip.closed', "The tip can be enabled again in the user settings.");

const CONFIGURATION_KEY = 'commandTip.show';

interface ICommandTipConfiguration {
	show: boolean;
}

export class CommandTip implements IWorkbenchContribution {

	private hint: Builder;
	private show = false;

	private stacks: IEditorStacksModel;
	private toDispose: IDisposable[] = [];

	constructor(
		@ILifecycleService lifecycleService: ILifecycleService,
		@ICommandService private commandService: ICommandService,
		@IPartService private partService: IPartService,
		@IEditorGroupService editorGroupService: IEditorGroupService,
		@IKeybindingService private keybindingService: IKeybindingService,
		@IMessageService private messageService: IMessageService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IConfigurationEditingService private configurationEditingService: IConfigurationEditingService,
		@ITelemetryService telemetryService: ITelemetryService
	) {
		this.toDispose.push(lifecycleService.onShutdown(this.dispose, this));
		this.stacks = editorGroupService.getStacksModel();
		this.registerConfiguration(telemetryService);
		this.partService.joinCreation().then(() => {
			this.toDispose.push(this.configurationService.onDidUpdateConfiguration(() => this.update()));
			this.toDispose.push(this.stacks.onModelChanged(() => this.update()));
			this.update();
		});
	}

	private update(): void {
		const { show } = this.configurationService.getConfiguration<ICommandTipConfiguration>('commandTip');
		const doShow = show && !this.avoidEditor();
		if (doShow !== this.show) {
			this.show = doShow;
			if (doShow) {
				if (!this.hint) {
					this.hint = this.create();
				} else {
					this.hint.display(null);
				}
			} else if (this.hint) {
				this.hint.display('none');
			}
		}
	}

	private avoidEditor(): boolean {
		const groups = this.stacks.groups;
		const right = groups.length && groups[groups.length - 1].activeEditor;
		return right instanceof FileEditorInput ? isKeybindingFile(right.getResource()) : false;
	}

	public getId(): string {
		return 'vs.commandTip';
	}

	private registerConfiguration(telemetryService: ITelemetryService): void {
		const configurationRegistry = <IConfigurationRegistry>Registry.as(Extensions.Configuration);
		configurationRegistry.registerConfiguration({
			'id': 'commandTip',
			'order': 111,
			'title': nls.localize('commandTip.configurationTitle', "Command Tip"),
			'type': 'object',
			'properties': {
				[CONFIGURATION_KEY]: {
					'type': 'boolean',
					'description': nls.localize('commandTip.showDescription', "Show the command tip."),
					'default': telemetryService.getExperiments().showCommandTip
				}
			}
		});
	}

	private create(): Builder {
		const container = this.partService.getContainer(Parts.EDITOR_PART);
		const hint = $().div({ 'class': 'command-tip' });
		const label = $(hint).div({ 'class': 'command-tip-label' });
		const close = $(hint).div({ 'class': 'command-tip-close' });

		this.toDispose.push(hint.on('click', () => {
			this.commandService.executeCommand(COMMAND_ID)
				.then(null, onUnexpectedError);
		}));
		this.toDispose.push(close.on('click', e => {
			this.configurationEditingService.writeConfiguration(ConfigurationTarget.USER, { key: CONFIGURATION_KEY, value: false })
				.then(null, onUnexpectedError);
			this.showClosedMessage();
			e.cancelBubble = true;
		}));

		const update = () => {
			const keybindings = this.keybindingService.lookupKeybindings(COMMAND_ID);
			label.text(keybindings.length ? `${COMMAND_LABEL} (${this.keybindingService.getLabelFor(keybindings[0])})` : COMMAND_LABEL);
		};
		update();
		hint.build(container);
		this.toDispose.push(this.keybindingService.onDidUpdateKeybindings(update));
		return hint;
	}

	private showClosedMessage(): void {
		const okAction = new Action(
			'commandTip.ok',
			nls.localize('commandTip.ok', "OK")
		);
		const settingsAction = new Action(
			'commandTip.openSettings',
			nls.localize('commandTip.openSettings', "Open Settings"),
			null,
			true,
			() => this.commandService.executeCommand(OpenGlobalSettingsAction.ID)
		);

		this.messageService.show(Severity.Info, {
			message: CLOSED_MESSAGE,
			actions: [settingsAction, okAction]
		});
	}

	public dispose(): void {
		this.toDispose = dispose(this.toDispose);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(CommandTip);

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as nls from 'vs/nls';
import dom = require('vs/base/browser/dom');
import URI from 'vs/base/common/uri';
import { Builder, Dimension } from 'vs/base/browser/builder';
import { Panel, PanelRegistry, PanelDescriptor, Extensions } from 'vs/workbench/browser/panel';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService, ITheme, DARK, HIGH_CONTRAST, LIGHT } from 'vs/platform/theme/common/themeService';
import { ITaskService } from 'vs/workbench/parts/tasks/common/taskService';
import { Registry } from 'vs/platform/registry/common/platform';
import { TPromise } from 'vs/base/common/winjs.base';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { buttonBackground, buttonForeground, textLinkForeground, selectBackground } from 'vs/platform/theme/common/colorRegistry';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IOpenerService } from 'vs/platform/opener/common/opener';

const TASK_PANEL_ID = 'workbench.panel.task';

export class TaskPanel extends Panel {

	private taskExperimentPart5 = 'workbench.tasks.feedbackAnswered';
	private _builder: Builder;

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService protected themeService: IThemeService,
		@ITaskService private taskService: ITaskService,
		@IInstantiationService private _instantiationService: IInstantiationService,
		@ICommandService private commandService: ICommandService,
		@IStorageService private storageService: IStorageService,
		@IOpenerService private openerService: IOpenerService,
	) {
		super(TASK_PANEL_ID, telemetryService, themeService);
	}

	public create(parent: Builder): TPromise<any> {
		super.create(parent);
		dom.addClass(parent.getHTMLElement(), 'task-panel');

		this._builder = parent.innerHtml(getHtml());
		const yesButton = this._builder.select('.task-panel-yes-telemetry');
		const noButton = this._builder.select('.task-panel-no-telemetry');
		const githubLink = this._builder.select('.task-panel-linkstyle');
		const clickFeedback = this._builder.select('.task-panel-header-item');
		const thanks = this._builder.select('.task-panel-thanks');

		if (this.storageService.get(this.taskExperimentPart5)) {
			clickFeedback.addClass('task-panel-hidden');
			thanks.removeClass('task-panel-hidden');
		}

		yesButton.on('click', e => {
			if (!this.storageService.get(this.taskExperimentPart5)) {
				this.telemetryService.publicLog('taskPanel.yes');
				this.storageService.store(this.taskExperimentPart5, true, StorageScope.GLOBAL);
			}
			clickFeedback.addClass('task-panel-hidden');
			thanks.removeClass('task-panel-hidden');
		});

		noButton.on('click', e => {
			if (!this.storageService.get(this.taskExperimentPart5)) {
				this.telemetryService.publicLog('taskPanel.no');
				this.storageService.store(this.taskExperimentPart5, true, StorageScope.GLOBAL);
			}
			clickFeedback.addClass('task-panel-hidden');
			thanks.removeClass('task-panel-hidden');
		});

		githubLink.on('click', e => {
			const node = event.target as HTMLAnchorElement;
			if (node.href) {
				this.openerService.open(URI.parse(node.href));
			}
		});
		this._register(this.themeService.onThemeChange(theme => this._updateTheme(theme)));
		this._updateTheme();

		return TPromise.as(void 0);
	}

	public layout(dimension?: Dimension): void { }

	private _updateTheme(theme?: ITheme): void {
		const githubLink = this._builder.select('.task-panel-linkstyle');
		const buttons = this._builder.select('.task-panel-mockup-button');
		const taskItems = this._builder.select('.task-panel-example-item');
		const thumbButtons = this._builder.select('.task-panel-feedback-button');

		if (!theme) {
			theme = this.themeService.getTheme();
		}

		if (theme.getColor(buttonBackground)) {
			buttons.style('background-color', theme.getColor(buttonBackground).toString());
		} else {
			buttons.style('background-color', null);
		}
		buttons.style('color', theme.getColor(buttonForeground).toString());
		githubLink.style('color', theme.getColor(textLinkForeground).toString());
		taskItems.style('background-color', theme.getColor(selectBackground).toString());

		if ((theme.type === DARK || theme.type === HIGH_CONTRAST) && thumbButtons.hasClass('light')) {
			thumbButtons.removeClass('light');
			thumbButtons.addClass('dark');
		} else if (theme.type === LIGHT && thumbButtons.hasClass('dark')) {
			thumbButtons.removeClass('dark');
			thumbButtons.addClass('light');
		}
	}
}

(<PanelRegistry>Registry.as(Extensions.Panels)).registerPanel(new PanelDescriptor(
	'vs/workbench/parts/tasks/electron-browser/taskPanel',
	'TaskPanel',
	TASK_PANEL_ID,
	nls.localize('tasks', "Tasks"),
	'task',
	50
));

function getHtml() {
	return `
<div class="task-panel-container">
	<p> We're thinking of adding a task panel in this space. If you would like to learn more about how to use tasks, click <a class="task-panel-linkstyle" href="https://code.visualstudio.com/docs/editor/tasks">here</a>.</p>
	<p> Some things you might be able to do here: </br>
	<ul>
		<li> See a list of autodetected and manually configured tasks </li>
		<li> Run/Restart/Stop tasks with a click of a button</li>
		<li> Show a summary of each completed task (ie: execution time, exit code, foldable output)</li>
		<li> Configure a task without touching the json file </li>
	</ul></p>
	<p> Here's a rough idea of what a task item might look like. By no means is this the final layout so please do not judge the look.</p>
	<div class="task-panel-example-item">
		<p class="task-panel-oneliner"> Task1: tsc -watch <span class="task-panel-right-aligned"> Running (0 Errors)&nbsp;
			<span class="task-panel-mockup-button">Show Output</span><span class="task-panel-mockup-button">Stop</span><span class="task-panel-mockup-button">Restart</span></span>
		</p>
	</div>
	<p class="task-panel-feedback"> If you are interested in further discussion or have feedback of your own, please see the github issue
		<a class="task-panel-linkstyle" href="https://github.com/Microsoft/vscode/issues/28235"> here</a>.
	</p>
</div>
<div class="task-panel-text">
	<div class="task-panel-header-item task-panel-centered">Do you like the idea of a task panel?
		<span class="task-panel-feedback-button task-panel-yes-telemetry light"></span>
		<span class="task-panel-feedback-button task-panel-no-telemetry light"></span>
	</div>
	<div class="task-panel-header-item task-panel-centered task-panel-thanks task-panel-hidden"> Thanks for the feedback! <3 </div>
</div>
`;
};
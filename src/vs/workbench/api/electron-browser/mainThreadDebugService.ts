/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { IDebugService, IConfig } from 'vs/workbench/parts/debug/common/debug';
import { IThreadService } from 'vs/workbench/services/thread/common/threadService';
import { TPromise } from 'vs/base/common/winjs.base';
import { ExtHostContext, ExtHostDebugServiceShape, MainThreadDebugServiceShape, DebugSessionUUID } from '../node/extHost.protocol';

export class MainThreadDebugService extends MainThreadDebugServiceShape {

	private _proxy: ExtHostDebugServiceShape;
	private _toDispose: IDisposable[];

	constructor(
		@IThreadService threadService: IThreadService,
		@IDebugService private debugService: IDebugService
	) {
		super();

		this._proxy = threadService.get(ExtHostContext.ExtHostDebugService);
		this._toDispose = [];
		this._toDispose.push(debugService.onDidNewProcess(proc => this._proxy.$acceptDebugSessionStarted(<DebugSessionUUID>proc.getId(), proc.configuration.type, proc.name)));
		this._toDispose.push(debugService.onDidEndProcess(proc => this._proxy.$acceptDebugSessionTerminated(<DebugSessionUUID>proc.getId(), proc.configuration.type, proc.name)));
		this._toDispose.push(debugService.getViewModel().onDidFocusProcess(proc => {
			if (proc) {
				this._proxy.$acceptDebugSessionActiveChanged(<DebugSessionUUID>proc.getId(), proc.configuration.type, proc.name);
			} else {
				this._proxy.$acceptDebugSessionActiveChanged(undefined);
			}
		}));
		this._toDispose.push(debugService.onDidCustomEvent(event => {
			if (event.body && event.body.sessionId) {
				const process = this.debugService.findProcessByUUID(event.body.sessionId);	// TODO
				this._proxy.$acceptDebugSessionCustomEvent(event.body.sessionId, process.configuration.type, process.configuration.name, event);
			}
		}));
	}

	public dispose(): void {
		this._toDispose = dispose(this._toDispose);
	}

	public $startDebugging(nameOrConfiguration: string | IConfig): TPromise<boolean> {

		if (typeof nameOrConfiguration === 'string') {
			return this.debugService.startDebugging(nameOrConfiguration).then(x => {
				return true;
			}, err => {
				return TPromise.wrapError(err && err.message ? err.message : 'cannot start debugging');
			});
		} else {
			return TPromise.wrapError(new Error('startDebugging with configuration object not yet implemented'));
		}
	}

	public $startDebugSession(configuration: IConfig): TPromise<DebugSessionUUID> {
		if (configuration.request !== 'launch' && configuration.request !== 'attach') {
			return TPromise.wrapError(new Error(`only 'launch' or 'attach' allowed for 'request' attribute`));
		}
		return this.debugService.createProcess(configuration).then(process => {
			if (process) {
				return <DebugSessionUUID>process.getId();
			}
			return TPromise.wrapError(new Error('cannot create debug session'));
		}, err => {
			return TPromise.wrapError(err && err.message ? err.message : 'cannot start debug session');
		});
	}

	public $customDebugAdapterRequest(sessionId: DebugSessionUUID, request: string, args: any): TPromise<any> {
		const process = this.debugService.findProcessByUUID(sessionId);
		if (process) {
			return process.session.custom(request, args).then(response => {
				if (response.success) {
					return response.body;
				} else {
					return TPromise.wrapError(new Error(response.message));
				}
			});
		}
		return TPromise.wrapError(new Error('debug session not found'));
	}
}

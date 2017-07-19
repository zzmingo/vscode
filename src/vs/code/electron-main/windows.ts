/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as path from 'path';
import * as fs from 'original-fs';
import { localize } from "vs/nls";
import * as arrays from 'vs/base/common/arrays';
import { assign, mixin } from 'vs/base/common/objects';
import { IBackupMainService } from 'vs/platform/backup/common/backup';
import { IEnvironmentService, ParsedArgs } from 'vs/platform/environment/common/environment';
import { IStorageService } from 'vs/platform/storage/node/storage';
import { CodeWindow, IWindowState as ISingleWindowState, defaultWindowState, WindowMode } from 'vs/code/electron-main/window';
import { ipcMain as ipc, screen, BrowserWindow, dialog, systemPreferences } from 'electron';
import { IPathWithLineAndColumn, parseLineAndColumnAware } from 'vs/code/node/paths';
import { ILifecycleService, UnloadReason, IWindowUnloadEvent } from 'vs/platform/lifecycle/electron-main/lifecycleMain';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ILogService } from 'vs/platform/log/common/log';
import { IWindowSettings, OpenContext, IPath, IWindowConfiguration, INativeOpenDialogOptions } from 'vs/platform/windows/common/windows';
import { getLastActiveWindow, findBestWindowOrFolderForFile, findWindowOnWorkspace } from 'vs/code/node/windowsFinder';
import CommonEvent, { Emitter } from 'vs/base/common/event';
import product from 'vs/platform/node/product';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { isEqual } from 'vs/base/common/paths';
import { IWindowsMainService, IOpenConfiguration, IWindowsCountChangedEvent } from "vs/platform/windows/electron-main/windows";
import { IHistoryMainService } from "vs/platform/history/common/history";
import { IProcessEnvironment, isLinux, isMacintosh, isWindows } from 'vs/base/common/platform';
import { TPromise } from "vs/base/common/winjs.base";
import { IWorkspacesMainService, IWorkspaceIdentifier, ISingleFolderWorkspaceIdentifier, IWorkspaceSavedEvent, WORKSPACE_FILTER, isSingleFolderWorkspaceIdentifier } from "vs/platform/workspaces/common/workspaces";
import { IInstantiationService } from "vs/platform/instantiation/common/instantiation";
import { mnemonicButtonLabel } from "vs/base/common/labels";
import URI from "vs/base/common/uri";

enum WindowError {
	UNRESPONSIVE,
	CRASHED
}

interface INewWindowState extends ISingleWindowState {
	hasDefaultState?: boolean;
}

interface ILegacyWindowState extends IWindowState {
	workspacePath?: string;
}

interface IWindowState {
	workspace?: IWorkspaceIdentifier;
	folderPath?: string;
	backupPath: string;
	uiState: ISingleWindowState;
}

interface ILegacyWindowsState extends IWindowsState {
	openedFolders?: IWindowState[];
}

interface IWindowsState {
	lastActiveWindow?: IWindowState;
	lastPluginDevelopmentHostWindow?: IWindowState;
	openedWindows: IWindowState[];
}

type RestoreWindowsSetting = 'all' | 'folders' | 'one' | 'none';

interface IOpenBrowserWindowOptions {
	userEnv?: IProcessEnvironment;
	cli?: ParsedArgs;

	workspace?: IWorkspaceIdentifier;
	folderPath?: string;

	initialStartup?: boolean;

	filesToOpen?: IPath[];
	filesToCreate?: IPath[];
	filesToDiff?: IPath[];

	forceNewWindow?: boolean;
	windowToUse?: CodeWindow;

	emptyWindowBackupFolder?: string;
}

interface IWindowToOpen extends IPath {

	// the workspace for a Code instance to open
	workspace?: IWorkspaceIdentifier;

	// the folder path for a Code instance to open
	folderPath?: string;

	// the backup spath for a Code instance to use
	backupPath?: string;

	// indicator to create the file path in the Code instance
	createFilePath?: boolean;
}

export class WindowsManager implements IWindowsMainService {

	_serviceBrand: any;

	private static windowsStateStorageKey = 'windowsState';

	private static WINDOWS: CodeWindow[] = [];

	private initialUserEnv: IProcessEnvironment;

	private windowsState: IWindowsState;
	private lastClosedWindowState: IWindowState;

	private fileDialog: FileDialog;

	private _onWindowReady = new Emitter<CodeWindow>();
	onWindowReady: CommonEvent<CodeWindow> = this._onWindowReady.event;

	private _onWindowClose = new Emitter<number>();
	onWindowClose: CommonEvent<number> = this._onWindowClose.event;

	private _onWindowReload = new Emitter<number>();
	onWindowReload: CommonEvent<number> = this._onWindowReload.event;

	private _onWindowsCountChanged = new Emitter<IWindowsCountChangedEvent>();
	onWindowsCountChanged: CommonEvent<IWindowsCountChangedEvent> = this._onWindowsCountChanged.event;

	constructor(
		@ILogService private logService: ILogService,
		@IStorageService private storageService: IStorageService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@ILifecycleService private lifecycleService: ILifecycleService,
		@IBackupMainService private backupService: IBackupMainService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IHistoryMainService private historyService: IHistoryMainService,
		@IWorkspacesMainService private workspacesService: IWorkspacesMainService,
		@IInstantiationService private instantiationService: IInstantiationService
	) {
		this.windowsState = this.storageService.getItem<IWindowsState>(WindowsManager.windowsStateStorageKey) || { openedWindows: [] };
		this.fileDialog = new FileDialog(environmentService, telemetryService, storageService, this);

		this.migrateLegacyWindowState();
	}

	private migrateLegacyWindowState(): void {
		const state: ILegacyWindowsState = this.windowsState;

		// TODO@Ben migration from previous openedFolders to new openedWindows property
		if (Array.isArray(state.openedFolders) && state.openedFolders.length > 0) {
			state.openedWindows = state.openedFolders;
			state.openedFolders = void 0;
		} else if (!state.openedWindows) {
			state.openedWindows = [];
		}

		// TODO@Ben migration from previous workspacePath in window state to folderPath
		const states: ILegacyWindowState[] = [];
		states.push(state.lastActiveWindow);
		states.push(state.lastPluginDevelopmentHostWindow);
		states.push(...state.openedWindows);
		states.forEach(state => {
			if (state && typeof state.workspacePath === 'string') {
				state.folderPath = state.workspacePath;
				state.workspacePath = void 0;
			}
		});
	}

	public ready(initialUserEnv: IProcessEnvironment): void {
		this.initialUserEnv = initialUserEnv;

		this.registerListeners();
	}

	private registerListeners(): void {

		// React to workbench loaded events from windows
		ipc.on('vscode:workbenchLoaded', (event, windowId: number) => {
			this.logService.log('IPC#vscode-workbenchLoaded');

			const win = this.getWindowById(windowId);
			if (win) {
				win.setReady();

				// Event
				this._onWindowReady.fire(win);
			}
		});

		// React to HC color scheme changes (Windows)
		if (isWindows) {
			systemPreferences.on('inverted-color-scheme-changed', () => {
				if (systemPreferences.isInvertedColorScheme()) {
					this.sendToAll('vscode:enterHighContrast');
				} else {
					this.sendToAll('vscode:leaveHighContrast');
				}
			});
		}

		// Handle various lifecycle events around windows
		this.lifecycleService.onBeforeWindowUnload(e => this.onBeforeWindowUnload(e));
		this.lifecycleService.onBeforeWindowClose(win => this.onBeforeWindowClose(win as CodeWindow));
		this.lifecycleService.onBeforeQuit(() => this.onBeforeQuit());

		// Handle workspace save event
		this.workspacesService.onWorkspaceSaved(e => this.onWorkspaceSaved(e));
	}

	// Note that onBeforeQuit() and onBeforeWindowClose() are fired in different order depending on the OS:
	// - macOS: since the app will not quit when closing the last window, you will always first get
	//          the onBeforeQuit() event followed by N onbeforeWindowClose() events for each window
	// - other: on other OS, closing the last window will quit the app so the order depends on the
	//          user interaction: closing the last window will first trigger onBeforeWindowClose()
	//          and then onBeforeQuit(). Using the quit action however will first issue onBeforeQuit()
	//          and then onBeforeWindowClose().
	private onBeforeQuit(): void {
		const currentWindowsState: ILegacyWindowsState = {
			openedWindows: [],
			openedFolders: [], // TODO@Ben migration so that old clients do not fail over data (prevents NPEs)
			lastPluginDevelopmentHostWindow: this.windowsState.lastPluginDevelopmentHostWindow,
			lastActiveWindow: this.lastClosedWindowState
		};

		// 1.) Find a last active window (pick any other first window otherwise)
		if (!currentWindowsState.lastActiveWindow) {
			let activeWindow = this.getLastActiveWindow();
			if (!activeWindow || activeWindow.isExtensionDevelopmentHost) {
				activeWindow = WindowsManager.WINDOWS.filter(w => !w.isExtensionDevelopmentHost)[0];
			}

			if (activeWindow) {
				currentWindowsState.lastActiveWindow = this.toWindowState(activeWindow);
			}
		}

		// 2.) Find extension host window
		const extensionHostWindow = WindowsManager.WINDOWS.filter(w => w.isExtensionDevelopmentHost && !w.isExtensionTestHost)[0];
		if (extensionHostWindow) {
			currentWindowsState.lastPluginDevelopmentHostWindow = this.toWindowState(extensionHostWindow);
		}

		// 3.) All windows (except extension host) for N >= 2 to support restoreWindows: all or for auto update
		//
		// Carefull here: asking a window for its window state after it has been closed returns bogus values (width: 0, height: 0)
		// so if we ever want to persist the UI state of the last closed window (window count === 1), it has
		// to come from the stored lastClosedWindowState on Win/Linux at least
		if (this.getWindowCount() > 1) {
			currentWindowsState.openedWindows = WindowsManager.WINDOWS.filter(w => !w.isExtensionDevelopmentHost).map(w => this.toWindowState(w));
		}

		// Persist
		this.storageService.setItem(WindowsManager.windowsStateStorageKey, currentWindowsState);
	}

	// See note on #onBeforeQuit() for details how these events are flowing
	private onBeforeWindowClose(win: CodeWindow): void {
		if (this.lifecycleService.isQuitRequested()) {
			return; // during quit, many windows close in parallel so let it be handled in the before-quit handler
		}

		// On Window close, update our stored UI state of this window
		const state: IWindowState = this.toWindowState(win);
		if (win.isExtensionDevelopmentHost && !win.isExtensionTestHost) {
			this.windowsState.lastPluginDevelopmentHostWindow = state; // do not let test run window state overwrite our extension development state
		}

		// Any non extension host window with same workspace or folder
		else if (!win.isExtensionDevelopmentHost && (!!win.openedWorkspace || !!win.openedFolderPath)) {
			this.windowsState.openedWindows.forEach(o => {
				const sameWorkspace = win.openedWorkspace && o.workspace && o.workspace.id === win.openedWorkspace.id;
				const sameFolder = win.openedFolderPath && isEqual(o.folderPath, win.openedFolderPath, !isLinux /* ignorecase */);

				if (sameWorkspace || sameFolder) {
					o.uiState = state.uiState;
				}
			});
		}

		// On Windows and Linux closing the last window will trigger quit. Since we are storing all UI state
		// before quitting, we need to remember the UI state of this window to be able to persist it.
		// On macOS we keep the last closed window state ready in case the user wants to quit right after or
		// wants to open another window, in which case we use this state over the persisted one.
		if (this.getWindowCount() === 1) {
			this.lastClosedWindowState = state;
		}
	}

	private toWindowState(win: CodeWindow): IWindowState {
		return {
			workspace: win.openedWorkspace,
			folderPath: win.openedFolderPath,
			backupPath: win.backupPath,
			uiState: win.serializeWindowState()
		};
	}

	public open(openConfig: IOpenConfiguration): CodeWindow[] {
		const windowsToOpen = this.getWindowsToOpen(openConfig);

		let filesToOpen = windowsToOpen.filter(path => !!path.filePath && !path.createFilePath);
		let filesToCreate = windowsToOpen.filter(path => !!path.filePath && path.createFilePath);
		let filesToDiff: IPath[];
		if (openConfig.diffMode && filesToOpen.length === 2) {
			filesToDiff = filesToOpen;
			filesToOpen = [];
			filesToCreate = []; // diff ignores other files that do not exist
		} else {
			filesToDiff = [];
		}

		//
		// These are windows to open to show workspaces
		//
		const workspacesToOpen = arrays.distinct(windowsToOpen.filter(win => !!win.workspace).map(win => win.workspace), workspace => workspace.id); // prevent duplicates

		//
		// These are windows to open to show either folders or files (including diffing files or creating them)
		//
		const foldersToOpen = arrays.distinct(windowsToOpen.filter(win => win.folderPath && !win.filePath).map(win => win.folderPath), folder => isLinux ? folder : folder.toLowerCase()); // prevent duplicates

		//
		// These are windows to restore because of hot-exit or from previous session (only performed once on startup!)
		//
		let foldersToRestore: string[] = [];
		let workspacesToRestore: IWorkspaceIdentifier[] = [];
		let emptyToRestore: string[] = [];
		if (openConfig.initialStartup && !openConfig.cli.extensionDevelopmentPath) {
			foldersToRestore = this.backupService.getFolderBackupPaths();

			workspacesToRestore = this.backupService.getWorkspaceBackups();				// collect from workspaces with hot-exit backups
			workspacesToRestore.push(...this.doGetUntitledWorkspacesFromLastSession());	// collect from previous window session

			emptyToRestore = this.backupService.getEmptyWindowBackupPaths();
			emptyToRestore.push(...windowsToOpen.filter(w => !w.workspace && !w.folderPath && w.backupPath).map(w => path.basename(w.backupPath))); // add empty windows with backupPath
			emptyToRestore = arrays.distinct(emptyToRestore); // prevent duplicates
		}

		//
		// These are empty windows to open
		//
		const emptyToOpen = windowsToOpen.filter(win => !win.workspace && !win.folderPath && !win.filePath && !win.backupPath).length;

		// Open based on config
		const usedWindows = this.doOpen(openConfig, workspacesToOpen, workspacesToRestore, foldersToOpen, foldersToRestore, emptyToRestore, emptyToOpen, filesToOpen, filesToCreate, filesToDiff);

		// Make sure the last active window gets focus if we opened multiple
		if (usedWindows.length > 1 && this.windowsState.lastActiveWindow) {
			let lastActiveWindw = usedWindows.filter(w => w.backupPath === this.windowsState.lastActiveWindow.backupPath);
			if (lastActiveWindw.length) {
				lastActiveWindw[0].focus();
			}
		}

		// Remember in recent document list (unless this opens for extension development)
		// Also do not add paths when files are opened for diffing, only if opened individually
		if (!usedWindows.some(w => w.isExtensionDevelopmentHost) && !openConfig.cli.diff) {
			const recentlyOpenedWorkspaces: (IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier)[] = [];
			const recentlyOpenedFiles: string[] = [];

			windowsToOpen.forEach(win => {
				if (win.workspace || win.folderPath) {
					recentlyOpenedWorkspaces.push(win.workspace || win.folderPath);
				} else if (win.filePath) {
					recentlyOpenedFiles.push(win.filePath);
				}
			});

			this.historyService.addRecentlyOpened(recentlyOpenedWorkspaces, recentlyOpenedFiles);
		}

		// If we got started with --wait from the CLI, we need to signal to the outside when the window
		// used for the edit operation is closed so that the waiting process can continue. We do this by
		// deleting the waitMarkerFilePath.
		if (openConfig.context === OpenContext.CLI && openConfig.cli.wait && openConfig.cli.waitMarkerFilePath && usedWindows.length === 1 && usedWindows[0]) {
			this.waitForWindowClose(usedWindows[0].id).done(() => fs.unlink(openConfig.cli.waitMarkerFilePath, error => void 0));
		}

		return usedWindows;
	}

	private doOpen(
		openConfig: IOpenConfiguration,
		workspacesToOpen: IWorkspaceIdentifier[],
		workspacesToRestore: IWorkspaceIdentifier[],
		foldersToOpen: string[],
		foldersToRestore: string[],
		emptyToRestore: string[],
		emptyToOpen: number,
		filesToOpen: IPath[],
		filesToCreate: IPath[],
		filesToDiff: IPath[]
	) {

		// Settings can decide if files/folders open in new window or not
		let { openFolderInNewWindow, openFilesInNewWindow } = this.shouldOpenNewWindow(openConfig);

		// Handle files to open/diff or to create when we dont open a folder and we do not restore any folder/untitled from hot-exit
		const usedWindows: CodeWindow[] = [];
		if (!foldersToOpen.length && !foldersToRestore.length && !emptyToRestore.length && (filesToOpen.length > 0 || filesToCreate.length > 0 || filesToDiff.length > 0)) {

			// Find suitable window or folder path to open files in
			const fileToCheck = filesToOpen[0] || filesToCreate[0] || filesToDiff[0];
			const bestWindowOrFolder = findBestWindowOrFolderForFile({
				windows: WindowsManager.WINDOWS,
				newWindow: openFilesInNewWindow,
				reuseWindow: openConfig.forceReuseWindow,
				context: openConfig.context,
				filePath: fileToCheck && fileToCheck.filePath,
				userHome: this.environmentService.userHome,
				workspaceResolver: workspace => this.workspacesService.resolveWorkspaceSync(workspace.configPath)
			});

			// We found a window to open the files in
			if (bestWindowOrFolder instanceof CodeWindow) {

				// Window is workspace
				if (bestWindowOrFolder.openedWorkspace) {
					workspacesToOpen.push(bestWindowOrFolder.openedWorkspace);
				}

				// Window is single folder
				else if (bestWindowOrFolder.openedFolderPath) {
					foldersToOpen.push(bestWindowOrFolder.openedFolderPath);
				}

				// Window is empty
				else {

					// Do open files
					usedWindows.push(this.doOpenFilesInExistingWindow(bestWindowOrFolder, filesToOpen, filesToCreate, filesToDiff));

					// Reset these because we handled them
					filesToOpen = [];
					filesToCreate = [];
					filesToDiff = [];
				}
			}

			// We found a suitable folder to open: add it to foldersToOpen
			else if (typeof bestWindowOrFolder === 'string') {
				foldersToOpen.push(bestWindowOrFolder);
			}

			// Finally, if no window or folder is found, just open the files in an empty window
			else {
				usedWindows.push(this.openInBrowserWindow({
					userEnv: openConfig.userEnv,
					cli: openConfig.cli,
					initialStartup: openConfig.initialStartup,
					filesToOpen,
					filesToCreate,
					filesToDiff,
					forceNewWindow: true
				}));

				// Reset these because we handled them
				filesToOpen = [];
				filesToCreate = [];
				filesToDiff = [];
			}
		}

		// Handle workspaces to open (instructed and to restore)
		const allWorkspacesToOpen = arrays.distinct([...workspacesToOpen, ...workspacesToRestore], workspace => workspace.id); // prevent duplicates
		if (allWorkspacesToOpen.length > 0) {

			// Check for existing instances that have same workspace ID but different configuration path
			// For now we reload that window with the new configuration so that the configuration path change
			// can travel properly.
			allWorkspacesToOpen.forEach(workspaceToOpen => {
				const existingWindow = findWindowOnWorkspace(WindowsManager.WINDOWS, workspaceToOpen);
				if (existingWindow && existingWindow.openedWorkspace.configPath !== workspaceToOpen.configPath) {
					usedWindows.push(this.doOpenFolderOrWorkspace(openConfig, { workspace: workspaceToOpen }, false, filesToOpen, filesToCreate, filesToDiff, existingWindow));

					// Reset these because we handled them
					filesToOpen = [];
					filesToCreate = [];
					filesToDiff = [];

					openFolderInNewWindow = true; // any other folders to open must open in new window then
				}
			});

			// Check for existing instances
			const windowsOnWorkspace = arrays.coalesce(allWorkspacesToOpen.map(workspaceToOpen => findWindowOnWorkspace(WindowsManager.WINDOWS, workspaceToOpen)));
			if (windowsOnWorkspace.length > 0) {
				const windowOnWorkspace = windowsOnWorkspace[0];

				// Do open files
				usedWindows.push(this.doOpenFilesInExistingWindow(windowOnWorkspace, filesToOpen, filesToCreate, filesToDiff));

				// Reset these because we handled them
				filesToOpen = [];
				filesToCreate = [];
				filesToDiff = [];

				openFolderInNewWindow = true; // any other folders to open must open in new window then
			}

			// Open remaining ones
			allWorkspacesToOpen.forEach(workspaceToOpen => {
				if (windowsOnWorkspace.some(win => win.openedWorkspace.id === workspaceToOpen.id)) {
					return; // ignore folders that are already open
				}

				// Do open folder
				usedWindows.push(this.doOpenFolderOrWorkspace(openConfig, { workspace: workspaceToOpen }, openFolderInNewWindow, filesToOpen, filesToCreate, filesToDiff));

				// Reset these because we handled them
				filesToOpen = [];
				filesToCreate = [];
				filesToDiff = [];

				openFolderInNewWindow = true; // any other folders to open must open in new window then
			});
		}

		// Handle folders to open (instructed and to restore)
		const allFoldersToOpen = arrays.distinct([...foldersToOpen, ...foldersToRestore], folder => isLinux ? folder : folder.toLowerCase()); // prevent duplicates
		if (allFoldersToOpen.length > 0) {

			// Check for existing instances
			const windowsOnFolderPath = arrays.coalesce(allFoldersToOpen.map(folderToOpen => findWindowOnWorkspace(WindowsManager.WINDOWS, folderToOpen)));
			if (windowsOnFolderPath.length > 0) {
				const windowOnFolderPath = windowsOnFolderPath[0];

				// Do open files
				usedWindows.push(this.doOpenFilesInExistingWindow(windowOnFolderPath, filesToOpen, filesToCreate, filesToDiff));

				// Reset these because we handled them
				filesToOpen = [];
				filesToCreate = [];
				filesToDiff = [];

				openFolderInNewWindow = true; // any other folders to open must open in new window then
			}

			// Open remaining ones
			allFoldersToOpen.forEach(folderToOpen => {
				if (windowsOnFolderPath.some(win => isEqual(win.openedFolderPath, folderToOpen, !isLinux /* ignorecase */))) {
					return; // ignore folders that are already open
				}

				// Do open folder
				usedWindows.push(this.doOpenFolderOrWorkspace(openConfig, { folderPath: folderToOpen }, openFolderInNewWindow, filesToOpen, filesToCreate, filesToDiff));

				// Reset these because we handled them
				filesToOpen = [];
				filesToCreate = [];
				filesToDiff = [];

				openFolderInNewWindow = true; // any other folders to open must open in new window then
			});
		}

		// Handle empty to restore
		if (emptyToRestore.length > 0) {
			emptyToRestore.forEach(emptyWindowBackupFolder => {
				usedWindows.push(this.openInBrowserWindow({
					userEnv: openConfig.userEnv,
					cli: openConfig.cli,
					initialStartup: openConfig.initialStartup,
					filesToOpen,
					filesToCreate,
					filesToDiff,
					forceNewWindow: true,
					emptyWindowBackupFolder
				}));

				// Reset these because we handled them
				filesToOpen = [];
				filesToCreate = [];
				filesToDiff = [];

				openFolderInNewWindow = true; // any other folders to open must open in new window then
			});
		}

		// Handle empty to open (only if no other window opened)
		if (usedWindows.length === 0) {
			for (let i = 0; i < emptyToOpen; i++) {
				usedWindows.push(this.openInBrowserWindow({
					userEnv: openConfig.userEnv,
					cli: openConfig.cli,
					initialStartup: openConfig.initialStartup,
					forceNewWindow: openFolderInNewWindow
				}));

				openFolderInNewWindow = true; // any other window to open must open in new window then
			}
		}

		return arrays.distinct(usedWindows);
	}

	private doOpenFilesInExistingWindow(window: CodeWindow, filesToOpen: IPath[], filesToCreate: IPath[], filesToDiff: IPath[]): CodeWindow {
		window.focus(); // make sure window has focus

		window.ready().then(readyWindow => {
			readyWindow.send('vscode:openFiles', { filesToOpen, filesToCreate, filesToDiff });
		});

		return window;
	}

	private doOpenFolderOrWorkspace(openConfig: IOpenConfiguration, folderOrWorkspace: IWindowToOpen, openInNewWindow: boolean, filesToOpen: IPath[], filesToCreate: IPath[], filesToDiff: IPath[], windowToUse?: CodeWindow): CodeWindow {
		const browserWindow = this.openInBrowserWindow({
			userEnv: openConfig.userEnv,
			cli: openConfig.cli,
			initialStartup: openConfig.initialStartup,
			workspace: folderOrWorkspace.workspace,
			folderPath: folderOrWorkspace.folderPath,
			filesToOpen,
			filesToCreate,
			filesToDiff,
			forceNewWindow: openInNewWindow,
			windowToUse
		});

		return browserWindow;
	}

	private getWindowsToOpen(openConfig: IOpenConfiguration): IWindowToOpen[] {
		let windowsToOpen: IWindowToOpen[];

		// Extract paths: from API
		if (openConfig.pathsToOpen && openConfig.pathsToOpen.length > 0) {
			windowsToOpen = this.doExtractPathsFromAPI(openConfig.pathsToOpen, openConfig.cli && openConfig.cli.goto);
		}

		// Check for force empty
		else if (openConfig.forceEmpty) {
			windowsToOpen = [Object.create(null)];
		}

		// Extract paths: from CLI
		else if (openConfig.cli._.length > 0) {
			windowsToOpen = this.doExtractPathsFromCLI(openConfig.cli);
		}

		// Extract windows: from previous session
		else {
			windowsToOpen = this.doGetWindowsFromLastSession();
		}

		return windowsToOpen;
	}

	private doExtractPathsFromAPI(paths: string[], gotoLineMode: boolean): IPath[] {
		let pathsToOpen = paths.map(pathToOpen => {
			const path = this.parsePath(pathToOpen, false, gotoLineMode);

			// Warn if the requested path to open does not exist
			if (!path) {
				const options: Electron.ShowMessageBoxOptions = {
					title: product.nameLong,
					type: 'info',
					buttons: [localize('ok', "OK")],
					message: localize('pathNotExistTitle', "Path does not exist"),
					detail: localize('pathNotExistDetail', "The path '{0}' does not seem to exist anymore on disk.", pathToOpen),
					noLink: true
				};

				const activeWindow = BrowserWindow.getFocusedWindow();
				if (activeWindow) {
					dialog.showMessageBox(activeWindow, options);
				} else {
					dialog.showMessageBox(options);
				}
			}

			return path;
		});

		// get rid of nulls
		pathsToOpen = arrays.coalesce(pathsToOpen);

		return pathsToOpen;
	}

	private doExtractPathsFromCLI(cli: ParsedArgs): IPath[] {
		const pathsToOpen = arrays.coalesce(cli._.map(candidate => this.parsePath(candidate, true /* ignoreFileNotFound */, cli.goto)));
		if (pathsToOpen.length > 0) {
			return pathsToOpen;
		}

		// No path provided, return empty to open empty
		return [Object.create(null)];
	}

	private doGetWindowsFromLastSession(): IWindowToOpen[] {
		const restoreWindows = this.getRestoreWindowsSetting();
		const lastActiveWindow = this.windowsState.lastActiveWindow;

		switch (restoreWindows) {

			// none: we always open an empty window
			case 'none':
				return [Object.create(null)];

			// one: restore last opened workspace/folder or empty window
			case 'one':
				if (lastActiveWindow) {

					// workspace
					const candidateWorkspace = lastActiveWindow.workspace;
					if (candidateWorkspace) {
						const validatedWorkspace = this.parsePath(candidateWorkspace.configPath);
						if (validatedWorkspace && validatedWorkspace.workspace) {
							return [validatedWorkspace];
						}
					}

					// folder (if path is valid)
					else if (lastActiveWindow.folderPath) {
						const validatedFolder = this.parsePath(lastActiveWindow.folderPath);
						if (validatedFolder && validatedFolder.folderPath) {
							return [validatedFolder];
						}
					}

					// otherwise use backup path to restore empty windows
					else if (lastActiveWindow.backupPath) {
						return [{ backupPath: lastActiveWindow.backupPath }];
					}
				}
				break;

			// all: restore all windows
			// folders: restore last opened folders only
			case 'all':
			case 'folders':
				const windowsToOpen: IWindowToOpen[] = [];

				// Workspaces
				const workspaceCandidates = this.windowsState.openedWindows.filter(w => !!w.workspace).map(w => w.workspace);
				if (lastActiveWindow && lastActiveWindow.workspace) {
					workspaceCandidates.push(lastActiveWindow.workspace);
				}
				windowsToOpen.push(...workspaceCandidates.map(candidate => this.parsePath(candidate.configPath)).filter(window => window && window.workspace));

				// Folders
				const folderCandidates = this.windowsState.openedWindows.filter(w => !!w.folderPath).map(w => w.folderPath);
				if (lastActiveWindow && lastActiveWindow.folderPath) {
					folderCandidates.push(lastActiveWindow.folderPath);
				}
				windowsToOpen.push(...folderCandidates.map(candidate => this.parsePath(candidate)).filter(window => window && window.folderPath));

				// Windows that were Empty
				if (restoreWindows === 'all') {
					const lastOpenedEmpty = this.windowsState.openedWindows.filter(w => !w.workspace && !w.folderPath && w.backupPath).map(w => w.backupPath);
					const lastActiveEmpty = lastActiveWindow && !lastActiveWindow.workspace && !lastActiveWindow.folderPath && lastActiveWindow.backupPath;
					if (lastActiveEmpty) {
						lastOpenedEmpty.push(lastActiveEmpty);
					}

					windowsToOpen.push(...lastOpenedEmpty.map(backupPath => ({ backupPath })));
				}

				if (windowsToOpen.length > 0) {
					return windowsToOpen;
				}

				break;
		}

		// Always fallback to empty window
		return [Object.create(null)];
	}

	private doGetUntitledWorkspacesFromLastSession(): IWorkspaceIdentifier[] {
		const candidates: IWorkspaceIdentifier[] = [];

		if (this.isUntitledWorkspace(this.windowsState.lastActiveWindow)) {
			candidates.push(this.windowsState.lastActiveWindow.workspace);
		}

		for (let i = 0; i < this.windowsState.openedWindows.length; i++) {
			const state = this.windowsState.openedWindows[i];
			if (this.isUntitledWorkspace(state)) {
				candidates.push(state.workspace);
			}
		}

		// Validate all workspace paths and only return the workspaces that are valid
		return arrays.coalesce(candidates.map(candidate => this.parsePath(candidate.configPath)).map(window => window && window.workspace));
	}

	private isUntitledWorkspace(state: IWindowState): boolean {
		return state && state.workspace && this.workspacesService.isUntitledWorkspace(state.workspace);
	}

	private getRestoreWindowsSetting(): RestoreWindowsSetting {
		let restoreWindows: RestoreWindowsSetting;
		if (this.lifecycleService.wasRestarted) {
			restoreWindows = 'all'; // always reopen all windows when an update was applied
		} else {
			const windowConfig = this.configurationService.getConfiguration<IWindowSettings>('window');
			restoreWindows = ((windowConfig && windowConfig.restoreWindows) || 'one') as RestoreWindowsSetting;

			if (restoreWindows === 'one' /* default */ && windowConfig && windowConfig.reopenFolders) {
				restoreWindows = windowConfig.reopenFolders; // TODO@Ben migration
			}

			if (['all', 'folders', 'one', 'none'].indexOf(restoreWindows) === -1) {
				restoreWindows = 'one';
			}
		}

		return restoreWindows;
	}

	private parsePath(anyPath: string, ignoreFileNotFound?: boolean, gotoLineMode?: boolean): IWindowToOpen {
		if (!anyPath) {
			return null;
		}

		let parsedPath: IPathWithLineAndColumn;
		if (gotoLineMode) {
			parsedPath = parseLineAndColumnAware(anyPath);
			anyPath = parsedPath.path;
		}

		const candidate = path.normalize(anyPath);
		try {
			const candidateStat = fs.statSync(candidate);
			if (candidateStat) {
				if (candidateStat.isFile()) {

					// Workspace
					const workspace = this.workspacesService.resolveWorkspaceSync(candidate);
					if (workspace) {
						return { workspace: { id: workspace.id, configPath: candidate } };
					}

					// File
					return {
						filePath: candidate,
						lineNumber: gotoLineMode ? parsedPath.line : void 0,
						columnNumber: gotoLineMode ? parsedPath.column : void 0
					};
				}

				// Folder
				return {
					folderPath: candidate
				};
			}
		} catch (error) {
			this.historyService.removeFromRecentlyOpened([candidate]); // since file does not seem to exist anymore, remove from recent

			if (ignoreFileNotFound) {
				return { filePath: candidate, createFilePath: true }; // assume this is a file that does not yet exist
			}
		}

		return null;
	}

	private shouldOpenNewWindow(openConfig: IOpenConfiguration): { openFolderInNewWindow: boolean; openFilesInNewWindow: boolean; } {

		// let the user settings override how folders are open in a new window or same window unless we are forced
		const windowConfig = this.configurationService.getConfiguration<IWindowSettings>('window');
		const openFolderInNewWindowConfig = (windowConfig && windowConfig.openFoldersInNewWindow) || 'default' /* default */;
		const openFilesInNewWindowConfig = (windowConfig && windowConfig.openFilesInNewWindow) || 'off' /* default */;

		let openFolderInNewWindow = (openConfig.preferNewWindow || openConfig.forceNewWindow) && !openConfig.forceReuseWindow;
		if (!openConfig.forceNewWindow && !openConfig.forceReuseWindow && (openFolderInNewWindowConfig === 'on' || openFolderInNewWindowConfig === 'off')) {
			openFolderInNewWindow = (openFolderInNewWindowConfig === 'on');
		}

		// let the user settings override how files are open in a new window or same window unless we are forced (not for extension development though)
		let openFilesInNewWindow: boolean;
		if (openConfig.forceNewWindow || openConfig.forceReuseWindow) {
			openFilesInNewWindow = openConfig.forceNewWindow && !openConfig.forceReuseWindow;
		} else {
			if (openConfig.context === OpenContext.DOCK) {
				openFilesInNewWindow = true; // only on macOS do we allow to open files in a new window if this is triggered via DOCK context
			}

			if (!openConfig.cli.extensionDevelopmentPath && (openFilesInNewWindowConfig === 'on' || openFilesInNewWindowConfig === 'off')) {
				openFilesInNewWindow = (openFilesInNewWindowConfig === 'on');
			}
		}

		return { openFolderInNewWindow, openFilesInNewWindow };
	}

	public openExtensionDevelopmentHostWindow(openConfig: IOpenConfiguration): void {

		// Reload an existing extension development host window on the same path
		// We currently do not allow more than one extension development window
		// on the same extension path.
		let res = WindowsManager.WINDOWS.filter(w => w.config && isEqual(w.config.extensionDevelopmentPath, openConfig.cli.extensionDevelopmentPath, !isLinux /* ignorecase */));
		if (res && res.length === 1) {
			this.reload(res[0], openConfig.cli);
			res[0].focus(); // make sure it gets focus and is restored

			return;
		}

		// Fill in previously opened folder unless an explicit path is provided and we are not unit testing
		if (openConfig.cli._.length === 0 && !openConfig.cli.extensionTestsPath) {
			const folderToOpen = this.windowsState.lastPluginDevelopmentHostWindow && this.windowsState.lastPluginDevelopmentHostWindow.folderPath;
			if (folderToOpen) {
				openConfig.cli._ = [folderToOpen];
			}
		}

		// Make sure we are not asked to open a path that is already opened
		if (openConfig.cli._.length > 0) {
			res = WindowsManager.WINDOWS.filter(w => w.openedFolderPath && openConfig.cli._.indexOf(w.openedFolderPath) >= 0);
			if (res.length) {
				openConfig.cli._ = [];
			}
		}

		// Open it
		this.open({ context: openConfig.context, cli: openConfig.cli, forceNewWindow: true, forceEmpty: openConfig.cli._.length === 0, userEnv: openConfig.userEnv });
	}

	private openInBrowserWindow(options: IOpenBrowserWindowOptions): CodeWindow {

		// Build IWindowConfiguration from config and options
		const configuration: IWindowConfiguration = mixin({}, options.cli); // inherit all properties from CLI
		configuration.appRoot = this.environmentService.appRoot;
		configuration.execPath = process.execPath;
		configuration.userEnv = assign({}, this.initialUserEnv, options.userEnv || {});
		configuration.isInitialStartup = options.initialStartup;
		configuration.workspace = options.workspace;
		configuration.folderPath = options.folderPath;
		configuration.filesToOpen = options.filesToOpen;
		configuration.filesToCreate = options.filesToCreate;
		configuration.filesToDiff = options.filesToDiff;
		configuration.nodeCachedDataDir = this.environmentService.nodeCachedDataDir;

		// if we know the backup folder upfront (for empty windows to restore), we can set it
		// directly here which helps for restoring UI state associated with that window.
		// For all other cases we first call into registerEmptyWindowBackupSync() to set it before
		// loading the window.
		if (options.emptyWindowBackupFolder) {
			configuration.backupPath = path.join(this.environmentService.backupHome, options.emptyWindowBackupFolder);
		}

		let codeWindow: CodeWindow;
		if (!options.forceNewWindow) {
			codeWindow = options.windowToUse || this.getLastActiveWindow();
			if (codeWindow) {
				codeWindow.focus();
			}
		}

		// New window
		if (!codeWindow) {
			const windowConfig = this.configurationService.getConfiguration<IWindowSettings>('window');
			const state = this.getNewWindowState(configuration);

			// Window state is not from a previous session: only allow fullscreen if we inherit it or user wants fullscreen
			let allowFullscreen: boolean;
			if (state.hasDefaultState) {
				allowFullscreen = (windowConfig && windowConfig.newWindowDimensions && ['fullscreen', 'inherit'].indexOf(windowConfig.newWindowDimensions) >= 0);
			}

			// Window state is from a previous session: only allow fullscreen when we got updated or user wants to restore
			else {
				allowFullscreen = this.lifecycleService.wasRestarted || (windowConfig && windowConfig.restoreFullscreen);
			}

			if (state.mode === WindowMode.Fullscreen && !allowFullscreen) {
				state.mode = WindowMode.Normal;
			}

			codeWindow = this.instantiationService.createInstance(CodeWindow, {
				state,
				extensionDevelopmentPath: configuration.extensionDevelopmentPath,
				isExtensionTestHost: !!configuration.extensionTestsPath
			});

			// Add to our list of windows
			WindowsManager.WINDOWS.push(codeWindow);

			// Indicate number change via event
			this._onWindowsCountChanged.fire({ oldCount: WindowsManager.WINDOWS.length - 1, newCount: WindowsManager.WINDOWS.length });

			// Window Events
			codeWindow.win.webContents.removeAllListeners('devtools-reload-page'); // remove built in listener so we can handle this on our own
			codeWindow.win.webContents.on('devtools-reload-page', () => this.reload(codeWindow));
			codeWindow.win.webContents.on('crashed', () => this.onWindowError(codeWindow, WindowError.CRASHED));
			codeWindow.win.on('unresponsive', () => this.onWindowError(codeWindow, WindowError.UNRESPONSIVE));
			codeWindow.win.on('closed', () => this.onWindowClosed(codeWindow));

			// Lifecycle
			this.lifecycleService.registerWindow(codeWindow);
		}

		// Existing window
		else {

			// Some configuration things get inherited if the window is being reused and we are
			// in extension development host mode. These options are all development related.
			const currentWindowConfig = codeWindow.config;
			if (!configuration.extensionDevelopmentPath && currentWindowConfig && !!currentWindowConfig.extensionDevelopmentPath) {
				configuration.extensionDevelopmentPath = currentWindowConfig.extensionDevelopmentPath;
				configuration.verbose = currentWindowConfig.verbose;
				configuration.debugBrkPluginHost = currentWindowConfig.debugBrkPluginHost;
				configuration.debugId = currentWindowConfig.debugId;
				configuration.debugPluginHost = currentWindowConfig.debugPluginHost;
				configuration['extensions-dir'] = currentWindowConfig['extensions-dir'];
			}
		}

		// Only load when the window has not vetoed this
		this.lifecycleService.unload(codeWindow, UnloadReason.LOAD).done(veto => {
			if (!veto) {

				// Register window for backups
				if (!configuration.extensionDevelopmentPath) {
					if (configuration.workspace) {
						configuration.backupPath = this.backupService.registerWorkspaceBackupSync(configuration.workspace);
					} else if (configuration.folderPath) {
						configuration.backupPath = this.backupService.registerFolderBackupSync(configuration.folderPath);
					} else {
						configuration.backupPath = this.backupService.registerEmptyWindowBackupSync(options.emptyWindowBackupFolder);
					}
				}

				// Load it
				codeWindow.load(configuration);
			}
		});

		return codeWindow;
	}

	private getNewWindowState(configuration: IWindowConfiguration): INewWindowState {
		const lastActive = this.getLastActiveWindow();

		// Restore state unless we are running extension tests
		if (!configuration.extensionTestsPath) {

			// extension development host Window - load from stored settings if any
			if (!!configuration.extensionDevelopmentPath && this.windowsState.lastPluginDevelopmentHostWindow) {
				return this.windowsState.lastPluginDevelopmentHostWindow.uiState;
			}

			// Known Workspace - load from stored settings
			if (configuration.workspace) {
				const stateForWorkspace = this.windowsState.openedWindows.filter(o => o.workspace && o.workspace.id === configuration.workspace.id).map(o => o.uiState);
				if (stateForWorkspace.length) {
					return stateForWorkspace[0];
				}
			}

			// Known Folder - load from stored settings
			if (configuration.folderPath) {
				const stateForFolder = this.windowsState.openedWindows.filter(o => isEqual(o.folderPath, configuration.folderPath, !isLinux /* ignorecase */)).map(o => o.uiState);
				if (stateForFolder.length) {
					return stateForFolder[0];
				}
			}

			// Empty windows with backups
			else if (configuration.backupPath) {
				const stateForEmptyWindow = this.windowsState.openedWindows.filter(o => o.backupPath === configuration.backupPath).map(o => o.uiState);
				if (stateForEmptyWindow.length) {
					return stateForEmptyWindow[0];
				}
			}

			// First Window
			const lastActiveState = this.lastClosedWindowState || this.windowsState.lastActiveWindow;
			if (!lastActive && lastActiveState) {
				return lastActiveState.uiState;
			}
		}

		//
		// In any other case, we do not have any stored settings for the window state, so we come up with something smart
		//

		// We want the new window to open on the same display that the last active one is in
		let displayToUse: Electron.Display;
		const displays = screen.getAllDisplays();

		// Single Display
		if (displays.length === 1) {
			displayToUse = displays[0];
		}

		// Multi Display
		else {

			// on mac there is 1 menu per window so we need to use the monitor where the cursor currently is
			if (isMacintosh) {
				const cursorPoint = screen.getCursorScreenPoint();
				displayToUse = screen.getDisplayNearestPoint(cursorPoint);
			}

			// if we have a last active window, use that display for the new window
			if (!displayToUse && lastActive) {
				displayToUse = screen.getDisplayMatching(lastActive.getBounds());
			}

			// fallback to primary display or first display
			if (!displayToUse) {
				displayToUse = screen.getPrimaryDisplay() || displays[0];
			}
		}

		let state = defaultWindowState() as INewWindowState;
		state.x = displayToUse.bounds.x + (displayToUse.bounds.width / 2) - (state.width / 2);
		state.y = displayToUse.bounds.y + (displayToUse.bounds.height / 2) - (state.height / 2);

		// Check for newWindowDimensions setting and adjust accordingly
		const windowConfig = this.configurationService.getConfiguration<IWindowSettings>('window');
		let ensureNoOverlap = true;
		if (windowConfig && windowConfig.newWindowDimensions) {
			if (windowConfig.newWindowDimensions === 'maximized') {
				state.mode = WindowMode.Maximized;
				ensureNoOverlap = false;
			} else if (windowConfig.newWindowDimensions === 'fullscreen') {
				state.mode = WindowMode.Fullscreen;
				ensureNoOverlap = false;
			} else if (windowConfig.newWindowDimensions === 'inherit' && lastActive) {
				const lastActiveState = lastActive.serializeWindowState();
				if (lastActiveState.mode === WindowMode.Fullscreen) {
					state.mode = WindowMode.Fullscreen; // only take mode (fixes https://github.com/Microsoft/vscode/issues/19331)
				} else {
					state = lastActiveState;
				}

				ensureNoOverlap = false;
			}
		}

		if (ensureNoOverlap) {
			state = this.ensureNoOverlap(state);
		}

		state.hasDefaultState = true; // flag as default state

		return state;
	}

	private ensureNoOverlap(state: ISingleWindowState): ISingleWindowState {
		if (WindowsManager.WINDOWS.length === 0) {
			return state;
		}

		const existingWindowBounds = WindowsManager.WINDOWS.map(win => win.getBounds());
		while (existingWindowBounds.some(b => b.x === state.x || b.y === state.y)) {
			state.x += 30;
			state.y += 30;
		}

		return state;
	}

	public reload(win: CodeWindow, cli?: ParsedArgs): void {

		// Only reload when the window has not vetoed this
		this.lifecycleService.unload(win, UnloadReason.RELOAD).done(veto => {
			if (!veto) {
				win.reload(cli);

				// Emit
				this._onWindowReload.fire(win.id);
			}
		});
	}

	public closeWorkspace(win: CodeWindow): void {
		this.openInBrowserWindow({
			cli: this.environmentService.args,
			windowToUse: win
		});
	}

	public newWorkspace(window: CodeWindow = this.getLastActiveWindow()): void {
		const folders = dialog.showOpenDialog(window ? window.win : void 0, {
			buttonLabel: mnemonicButtonLabel(localize({ key: 'select', comment: ['&& denotes a mnemonic'] }, "&&Select")),
			title: localize('selectWorkspace', "Select Folders for Workspace"),
			properties: ['multiSelections', 'openDirectory', 'createDirectory'],
			defaultPath: this.getWorkspaceDialogDefaultPath(window ? (window.openedWorkspace || window.openedFolderPath) : void 0)
		});

		if (folders && folders.length) {
			this.workspacesService.createWorkspace(folders.map(folder => URI.file(folder).toString(true /* encoding */))).then(workspace => {
				this.open({ context: OpenContext.DIALOG, cli: this.environmentService.args, pathsToOpen: [workspace.configPath] });
			});
		}
	}

	public openWorkspace(window: CodeWindow = this.getLastActiveWindow()): void {
		let defaultPath: string;
		if (window && window.openedWorkspace && !this.workspacesService.isUntitledWorkspace(window.openedWorkspace)) {
			defaultPath = path.dirname(window.openedWorkspace.configPath);
		} else {
			defaultPath = this.getWorkspaceDialogDefaultPath(window ? (window.openedWorkspace || window.openedFolderPath) : void 0);
		}

		this.pickFileAndOpen({
			windowId: window ? window.id : void 0,
			dialogOptions: {
				buttonLabel: mnemonicButtonLabel(localize({ key: 'openWorkspace', comment: ['&& denotes a mnemonic'] }, "&&Open")),
				title: localize('openWorkspaceTitle', "Open Workspace"),
				filters: WORKSPACE_FILTER,
				properties: ['openFile'],
				defaultPath
			}
		});
	}

	private getWorkspaceDialogDefaultPath(workspace?: IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier): string {
		let defaultPath: string;
		if (workspace) {
			if (isSingleFolderWorkspaceIdentifier(workspace)) {
				defaultPath = path.dirname(workspace);
			} else {
				const resolvedWorkspace = this.workspacesService.resolveWorkspaceSync(workspace.configPath);
				if (resolvedWorkspace) {
					defaultPath = path.dirname(URI.parse(resolvedWorkspace.folders[0]).fsPath);
				}
			}
		}

		return defaultPath;
	}

	private onBeforeWindowUnload(e: IWindowUnloadEvent): void {
		const windowClosing = e.reason === UnloadReason.CLOSE;
		const windowLoading = e.reason === UnloadReason.LOAD;
		if (!windowClosing && !windowLoading) {
			return; // only interested when window is closing or loading
		}

		const workspace = e.window.openedWorkspace;
		if (!workspace || !this.workspacesService.isUntitledWorkspace(workspace)) {
			return; // only care about untitled workspaces to ask for saving
		}

		if (windowClosing && !isMacintosh && this.getWindowCount() === 1) {
			return; // Windows/Linux: quits when last window is closed, so do not ask then
		}

		this.promptToSaveUntitledWorkspace(e, workspace);
	}

	private promptToSaveUntitledWorkspace(e: IWindowUnloadEvent, workspace: IWorkspaceIdentifier): void {
		enum ConfirmResult {
			SAVE,
			DONT_SAVE,
			CANCEL
		}

		const save = { label: mnemonicButtonLabel(localize({ key: 'save', comment: ['&& denotes a mnemonic'] }, "&&Save")), result: ConfirmResult.SAVE };
		const dontSave = { label: mnemonicButtonLabel(localize({ key: 'doNotSave', comment: ['&& denotes a mnemonic'] }, "Do&&n't Save")), result: ConfirmResult.DONT_SAVE };
		const cancel = { label: localize('cancel', "Cancel"), result: ConfirmResult.CANCEL };

		const buttons: { label: string; result: ConfirmResult; }[] = [];
		if (isWindows) {
			buttons.push(save, dontSave, cancel);
		} else if (isLinux) {
			buttons.push(dontSave, cancel, save);
		} else {
			buttons.push(save, cancel, dontSave);
		}

		const options: Electron.ShowMessageBoxOptions = {
			title: this.environmentService.appNameLong,
			message: localize('saveWorkspaceMessage', "Do you want to save the workspace opened in this window?"),
			detail: localize('saveWorkspaceDetail', "Your workspace will be deleted if you don't save it."),
			noLink: true,
			type: 'warning',
			buttons: buttons.map(button => button.label),
			cancelId: buttons.indexOf(cancel)
		};

		if (isLinux) {
			options.defaultId = 2;
		}

		const res = dialog.showMessageBox(e.window.win, options);

		switch (buttons[res].result) {

			// Cancel: veto unload
			case ConfirmResult.CANCEL:
				e.veto(true);
				break;

			// Don't Save: delete workspace
			case ConfirmResult.DONT_SAVE:
				this.workspacesService.deleteUntitledWorkspaceSync(workspace);
				e.veto(false);
				break;

			// Save: save workspace, but do not veto unload
			case ConfirmResult.SAVE: {
				const target = dialog.showSaveDialog(e.window.win, {
					buttonLabel: mnemonicButtonLabel(localize({ key: 'save', comment: ['&& denotes a mnemonic'] }, "&&Save")),
					title: localize('saveWorkspace', "Save Workspace"),
					filters: WORKSPACE_FILTER,
					defaultPath: this.getWorkspaceDialogDefaultPath(workspace)
				});

				if (target) {
					e.veto(this.workspacesService.saveWorkspace(workspace, target).then(() => false, () => false));
				} else {
					e.veto(true); // keep veto if no target was provided
				}
			}
		}
	}

	private onWorkspaceSaved(e: IWorkspaceSavedEvent): void {

		// A workspace was saved to a different config location. Make sure to update our
		// window states with this new location.
		const states = [this.lastClosedWindowState, this.windowsState.lastActiveWindow, this.windowsState.lastPluginDevelopmentHostWindow, ...this.windowsState.openedWindows];
		states.forEach(state => {
			if (state && state.workspace && state.workspace.id === e.workspace.id && state.workspace.configPath !== e.workspace.configPath) {
				state.workspace.configPath = e.workspace.configPath;
			}
		});
	}

	public focusLastActive(cli: ParsedArgs, context: OpenContext): CodeWindow {
		const lastActive = this.getLastActiveWindow();
		if (lastActive) {
			lastActive.focus();

			return lastActive;
		}

		// No window - open new empty one
		return this.open({ context, cli, forceEmpty: true })[0];
	}

	public getLastActiveWindow(): CodeWindow {
		return getLastActiveWindow(WindowsManager.WINDOWS);
	}

	public openNewWindow(context: OpenContext): void {
		this.open({ context, cli: this.environmentService.args, forceNewWindow: true, forceEmpty: true });
	}

	public waitForWindowClose(windowId: number): TPromise<void> {
		return new TPromise<void>(c => {
			const toDispose = this.onWindowClose(id => {
				if (id === windowId) {
					toDispose.dispose();
					c(null);
				}
			});
		});
	}

	public sendToFocused(channel: string, ...args: any[]): void {
		const focusedWindow = this.getFocusedWindow() || this.getLastActiveWindow();

		if (focusedWindow) {
			focusedWindow.sendWhenReady(channel, ...args);
		}
	}

	public sendToAll(channel: string, payload?: any, windowIdsToIgnore?: number[]): void {
		WindowsManager.WINDOWS.forEach(w => {
			if (windowIdsToIgnore && windowIdsToIgnore.indexOf(w.id) >= 0) {
				return; // do not send if we are instructed to ignore it
			}

			w.sendWhenReady(channel, payload);
		});
	}

	public getFocusedWindow(): CodeWindow {
		const win = BrowserWindow.getFocusedWindow();
		if (win) {
			return this.getWindowById(win.id);
		}

		return null;
	}

	public getWindowById(windowId: number): CodeWindow {
		const res = WindowsManager.WINDOWS.filter(w => w.id === windowId);
		if (res && res.length === 1) {
			return res[0];
		}

		return null;
	}

	public getWindows(): CodeWindow[] {
		return WindowsManager.WINDOWS;
	}

	public getWindowCount(): number {
		return WindowsManager.WINDOWS.length;
	}

	private onWindowError(codeWindow: CodeWindow, error: WindowError): void {
		this.logService.error(error === WindowError.CRASHED ? '[VS Code]: render process crashed!' : '[VS Code]: detected unresponsive');

		// Unresponsive
		if (error === WindowError.UNRESPONSIVE) {
			dialog.showMessageBox(codeWindow.win, {
				title: product.nameLong,
				type: 'warning',
				buttons: [localize('reopen', "Reopen"), localize('wait', "Keep Waiting"), localize('close', "Close")],
				message: localize('appStalled', "The window is no longer responding"),
				detail: localize('appStalledDetail', "You can reopen or close the window or keep waiting."),
				noLink: true
			}, result => {
				if (!codeWindow.win) {
					return; // Return early if the window has been going down already
				}

				if (result === 0) {
					codeWindow.reload();
				} else if (result === 2) {
					this.onBeforeWindowClose(codeWindow); // 'close' event will not be fired on destroy(), so run it manually
					codeWindow.win.destroy(); // make sure to destroy the window as it is unresponsive
				}
			});
		}

		// Crashed
		else {
			dialog.showMessageBox(codeWindow.win, {
				title: product.nameLong,
				type: 'warning',
				buttons: [localize('reopen', "Reopen"), localize('close', "Close")],
				message: localize('appCrashed', "The window has crashed"),
				detail: localize('appCrashedDetail', "We are sorry for the inconvenience! You can reopen the window to continue where you left off."),
				noLink: true
			}, result => {
				if (!codeWindow.win) {
					return; // Return early if the window has been going down already
				}

				if (result === 0) {
					codeWindow.reload();
				} else if (result === 1) {
					this.onBeforeWindowClose(codeWindow); // 'close' event will not be fired on destroy(), so run it manually
					codeWindow.win.destroy(); // make sure to destroy the window as it has crashed
				}
			});
		}
	}

	private onWindowClosed(win: CodeWindow): void {

		// Tell window
		win.dispose();

		// Remove from our list so that Electron can clean it up
		const index = WindowsManager.WINDOWS.indexOf(win);
		WindowsManager.WINDOWS.splice(index, 1);

		// Emit
		this._onWindowsCountChanged.fire({ oldCount: WindowsManager.WINDOWS.length + 1, newCount: WindowsManager.WINDOWS.length });
		this._onWindowClose.fire(win.id);
	}

	public pickFileFolderAndOpen(options: INativeOpenDialogOptions): void {
		this.doPickAndOpen(options, true /* pick folders */, true /* pick files */);
	}

	public pickFolderAndOpen(options: INativeOpenDialogOptions): void {
		this.doPickAndOpen(options, true /* pick folders */, false /* pick files */);
	}

	public pickFileAndOpen(options: INativeOpenDialogOptions): void {
		this.doPickAndOpen(options, false /* pick folders */, true /* pick files */);
	}

	private doPickAndOpen(options: INativeOpenDialogOptions, pickFolders: boolean, pickFiles: boolean): void {
		const internalOptions = options as IInternalNativeOpenDialogOptions;

		internalOptions.pickFolders = pickFolders;
		internalOptions.pickFiles = pickFiles;

		if (!internalOptions.dialogOptions) {
			internalOptions.dialogOptions = Object.create(null);
		}

		if (!internalOptions.dialogOptions.title) {
			if (pickFolders && pickFiles) {
				internalOptions.dialogOptions.title = localize('open', "Open");
			} else if (pickFolders) {
				internalOptions.dialogOptions.title = localize('openFolder', "Open Folder");
			} else {
				internalOptions.dialogOptions.title = localize('openFile', "Open File");
			}
		}

		if (!internalOptions.telemetryEventName) {
			if (pickFolders && pickFiles) {
				internalOptions.telemetryEventName = 'openFileFolder';
			} else if (pickFolders) {
				internalOptions.telemetryEventName = 'openFolder';
			} else {
				internalOptions.telemetryEventName = 'openFile';
			}
		}

		this.fileDialog.pickAndOpen(internalOptions);
	}

	public quit(): void {

		// If the user selected to exit from an extension development host window, do not quit, but just
		// close the window unless this is the last window that is opened.
		const codeWindow = this.getFocusedWindow();
		if (codeWindow && codeWindow.isExtensionDevelopmentHost && this.getWindowCount() > 1) {
			codeWindow.win.close();
		}

		// Otherwise: normal quit
		else {
			setTimeout(() => {
				this.lifecycleService.quit();
			}, 10 /* delay to unwind callback stack (IPC) */);
		}
	}
}

interface IInternalNativeOpenDialogOptions extends INativeOpenDialogOptions {
	pickFolders?: boolean;
	pickFiles?: boolean;
}

class FileDialog {

	private static workingDirPickerStorageKey = 'pickerWorkingDir';

	constructor(
		private environmentService: IEnvironmentService,
		private telemetryService: ITelemetryService,
		private storageService: IStorageService,
		private windowsMainService: IWindowsMainService
	) {
	}

	public pickAndOpen(options: INativeOpenDialogOptions): void {
		this.getFileOrFolderPaths(options, (paths: string[]) => {
			const numberOfPaths = paths ? paths.length : 0;

			// Telemetry
			if (options.telemetryEventName) {
				this.telemetryService.publicLog(options.telemetryEventName, {
					...options.telemetryExtraData,
					outcome: numberOfPaths ? 'success' : 'canceled',
					numberOfPaths
				});
			}

			// Open
			if (numberOfPaths) {
				this.windowsMainService.open({ context: OpenContext.DIALOG, cli: this.environmentService.args, pathsToOpen: paths, forceNewWindow: options.forceNewWindow });
			}
		});
	}

	public getFileOrFolderPaths(options: IInternalNativeOpenDialogOptions, clb: (paths: string[]) => void): void {

		// Ensure dialog options
		if (!options.dialogOptions) {
			options.dialogOptions = Object.create(null);
		}

		// Ensure defaultPath
		if (!options.dialogOptions.defaultPath) {
			options.dialogOptions.defaultPath = this.storageService.getItem<string>(FileDialog.workingDirPickerStorageKey);
		}

		// Ensure properties
		if (typeof options.pickFiles === 'boolean' || typeof options.pickFolders === 'boolean') {
			options.dialogOptions.properties = void 0; // let it override based on the booleans

			if (options.pickFiles && options.pickFolders) {
				options.dialogOptions.properties = ['multiSelections', 'openDirectory', 'openFile', 'createDirectory'];
			}
		}

		if (!options.dialogOptions.properties) {
			options.dialogOptions.properties = ['multiSelections', options.pickFolders ? 'openDirectory' : 'openFile', 'createDirectory'];
		}

		// Show Dialog
		const focussedWindow = this.windowsMainService.getWindowById(options.windowId) || this.windowsMainService.getFocusedWindow();
		dialog.showOpenDialog(focussedWindow && focussedWindow.win, options.dialogOptions, paths => {
			if (paths && paths.length > 0) {

				// Remember path in storage for next time
				this.storageService.setItem(FileDialog.workingDirPickerStorageKey, path.dirname(paths[0]));

				// Return
				return clb(paths);
			}

			return clb(void (0));
		});
	}
}
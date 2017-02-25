/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as cp from 'child_process';
import * as path from 'path';

import { ILineMatch, IProgress } from 'vs/platform/search/common/search';

import { ISerializedFileMatch, ISerializedSearchComplete, IRawSearch, ISearchEngine } from './search';

export class RipgrepEngine implements ISearchEngine<ISerializedFileMatch[]> { // SilverSearcher
	private config: IRawSearch;
	private pattern: string;

	private isCanceled = false;

	private agProc: cp.ChildProcess;

	constructor(config: IRawSearch) {
		this.config = config;
		const patternInfo = this.config.contentPattern;
		// const contentPattern = strings.createRegExp(patternInfo.pattern, patternInfo.isRegExp, { matchCase: patternInfo.isCaseSensitive, wholeWord: patternInfo.isWordMatch, multiline: false, global: true });
		this.pattern = patternInfo.pattern;
	}

	cancel(): void {
		this.isCanceled = true;

		this.agProc.kill();
	}

	search(onResult: (match: ISerializedFileMatch[]) => void, onProgress: (progress: IProgress) => void, done: (error: Error, complete: ISerializedSearchComplete) => void): void {
		this.searchNextFolder(onResult, onProgress, done);
	}

	searchNextFolder(onResult: (match: ISerializedFileMatch[]) => void, onProgress: (progress: IProgress) => void, done: (error: Error, complete: ISerializedSearchComplete) => void): void {
		if (this.config.rootFolders.length) {
			this.searchFolder(this.config.rootFolders.shift(), onResult, onProgress, done);
		}
	}

	// 1667;12 16,47 16:            addEventListener: function Promise_addEventListener(eventType, listener, capture) {
	/**
	 *  src/vs/workbench/services/search/node/ripgrepTextSearch.ts
		5:1:foobar
	 */
	searchFolder(rootFolder: string, onResult: (match: ISerializedFileMatch[]) => void, onProgress: (progress: IProgress) => void, done: (error: Error, complete: ISerializedSearchComplete) => void): void {
		const rgArgs = ['--vimgrep', '--heading', `${this.pattern}`];
		console.log(`rg ${rgArgs.join(' ')}, cwd: ${rootFolder}`);
		this.agProc = cp.spawn('rg', rgArgs, { cwd: rootFolder });

		// const resultRegex = /(.*):(\d):(\d):/;
		const resultRegex = /^(\d+):(\d+):(.*)$/;
		const fileRegex = /^(.+)$/;
		let fileMatch: FileMatch;
		let lineMatch: LineMatch;
		this.agProc.stdout.on('data', data => {
			console.log('data');
			console.log(data.toString().replace(/\n/g, '\\n'));

			const results: string[] = data.toString().split('\n');
			results.forEach(resultStr => {
				let r = resultStr.match(resultRegex);
				if (r) {
					// Line is a result - add to collected results for the current file path
					const line = parseInt(r[1]);
					const col = parseInt(r[2]) - 1;
					const text = r[3];

					if (!lineMatch || lineMatch.lineNumber !== line) {
						lineMatch = new LineMatch(text, line);
						fileMatch.addMatch(lineMatch);
					}

					lineMatch.addMatch(col, this.pattern.length); // TODO text.length
				} else {
					r = resultStr.match(fileRegex);
					if (r) {
						// Line is a file path - send all collected results for the previous file path
						if (fileMatch) {
							onResult([fileMatch.serialize()]);
						}

						fileMatch = new FileMatch(path.join(rootFolder, r[1]));
					}
				}
			});
		});

		this.agProc.stderr.on('data', data => {
			console.log('stderr');
			console.log(data.toString());
		});

		this.agProc.on('close', code => {
			this.agProc = null;
			console.log(`closed with ${code}`);
			done(null, {
				limitHit: false,
				stats: null
			});
		});
	}
}


export class FileMatch implements ISerializedFileMatch {
	path: string;
	lineMatches: LineMatch[];

	constructor(path: string) {
		this.path = path;
		this.lineMatches = [];
	}

	addMatch(lineMatch: LineMatch): void {
		this.lineMatches.push(lineMatch);
	}

	isEmpty(): boolean {
		return this.lineMatches.length === 0;
	}

	serialize(): ISerializedFileMatch {
		let lineMatches: ILineMatch[] = [];
		let numMatches = 0;

		for (let i = 0; i < this.lineMatches.length; i++) {
			numMatches += this.lineMatches[i].offsetAndLengths.length;
			lineMatches.push(this.lineMatches[i].serialize());
		}

		return {
			path: this.path,
			lineMatches,
			numMatches
		};
	}
}

export class LineMatch implements ILineMatch {
	preview: string;
	lineNumber: number;
	offsetAndLengths: number[][];

	constructor(preview: string, lineNumber: number) {
		this.preview = preview.replace(/(\r|\n)*$/, '');
		this.lineNumber = lineNumber;
		this.offsetAndLengths = [];
	}

	getText(): string {
		return this.preview;
	}

	getLineNumber(): number {
		return this.lineNumber;
	}

	addMatch(offset: number, length: number): void {
		this.offsetAndLengths.push([offset, length]);
	}

	serialize(): ILineMatch {
		const result = {
			preview: this.preview,
			lineNumber: this.lineNumber,
			offsetAndLengths: this.offsetAndLengths
		};

		return result;
	}
}
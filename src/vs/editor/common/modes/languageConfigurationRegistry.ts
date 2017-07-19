/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { CharacterPairSupport } from 'vs/editor/common/modes/supports/characterPair';
import { BracketElectricCharacterSupport, IElectricAction } from 'vs/editor/common/modes/supports/electricCharacter';
import { IOnEnterSupportOptions, OnEnterSupport } from 'vs/editor/common/modes/supports/onEnter';
import { IndentRulesSupport, IndentConsts } from 'vs/editor/common/modes/supports/indentRules';
import { RichEditBrackets } from 'vs/editor/common/modes/supports/richEditBrackets';
import Event, { Emitter } from 'vs/base/common/event';
import { ITokenizedModel } from 'vs/editor/common/editorCommon';
import { onUnexpectedError } from 'vs/base/common/errors';
import * as strings from 'vs/base/common/strings';
import { IDisposable } from 'vs/base/common/lifecycle';
import { DEFAULT_WORD_REGEXP, ensureValidWordDefinition } from 'vs/editor/common/model/wordHelper';
import { createScopedLineTokens } from 'vs/editor/common/modes/supports';
import { LineTokens } from 'vs/editor/common/core/lineTokens';
import { Range } from 'vs/editor/common/core/range';
import { IndentAction, EnterAction, IAutoClosingPair, LanguageConfiguration, IndentationRule } from 'vs/editor/common/modes/languageConfiguration';
import { LanguageIdentifier, LanguageId } from 'vs/editor/common/modes';

/**
 * Interface used to support insertion of mode specific comments.
 */
export interface ICommentsConfiguration {
	lineCommentToken?: string;
	blockCommentStartToken?: string;
	blockCommentEndToken?: string;
}

export interface IVirtualModel {
	getLineTokens(lineNumber: number): LineTokens;
	getLanguageIdentifier(): LanguageIdentifier;
	getLanguageIdAtPosition(lineNumber: number, column: number): LanguageId;
	getLineContent(lineNumber: number): string;
}

export interface IIndentConverter {
	shiftIndent?(indentation: string): string;
	unshiftIndent?(indentation: string): string;
	normalizeIndentation?(indentation: string): string;
}

export class RichEditSupport {

	private readonly _conf: LanguageConfiguration;

	public readonly electricCharacter: BracketElectricCharacterSupport;
	public readonly comments: ICommentsConfiguration;
	public readonly characterPair: CharacterPairSupport;
	public readonly wordDefinition: RegExp;
	public readonly onEnter: OnEnterSupport;
	public readonly indentRulesSupport: IndentRulesSupport;
	public readonly brackets: RichEditBrackets;
	public readonly indentationRules: IndentationRule;

	constructor(languageIdentifier: LanguageIdentifier, previous: RichEditSupport, rawConf: LanguageConfiguration) {

		let prev: LanguageConfiguration = null;
		if (previous) {
			prev = previous._conf;
		}

		this._conf = RichEditSupport._mergeConf(prev, rawConf);

		if (this._conf.brackets) {
			this.brackets = new RichEditBrackets(languageIdentifier, this._conf.brackets);
		}

		this.onEnter = RichEditSupport._handleOnEnter(this._conf);

		this.comments = RichEditSupport._handleComments(this._conf);

		this.characterPair = new CharacterPairSupport(this._conf);
		this.electricCharacter = new BracketElectricCharacterSupport(this.brackets, this.characterPair.getAutoClosingPairs(), this._conf.__electricCharacterSupport);

		this.wordDefinition = this._conf.wordPattern || DEFAULT_WORD_REGEXP;

		this.indentationRules = this._conf.indentationRules;
		if (this._conf.indentationRules) {
			this.indentRulesSupport = new IndentRulesSupport(this._conf.indentationRules);
		}
	}

	private static _mergeConf(prev: LanguageConfiguration, current: LanguageConfiguration): LanguageConfiguration {
		return {
			comments: (prev ? current.comments || prev.comments : current.comments),
			brackets: (prev ? current.brackets || prev.brackets : current.brackets),
			wordPattern: (prev ? current.wordPattern || prev.wordPattern : current.wordPattern),
			indentationRules: (prev ? current.indentationRules || prev.indentationRules : current.indentationRules),
			onEnterRules: (prev ? current.onEnterRules || prev.onEnterRules : current.onEnterRules),
			autoClosingPairs: (prev ? current.autoClosingPairs || prev.autoClosingPairs : current.autoClosingPairs),
			surroundingPairs: (prev ? current.surroundingPairs || prev.surroundingPairs : current.surroundingPairs),
			__electricCharacterSupport: (prev ? current.__electricCharacterSupport || prev.__electricCharacterSupport : current.__electricCharacterSupport),
		};
	}

	private static _handleOnEnter(conf: LanguageConfiguration): OnEnterSupport {
		// on enter
		let onEnter: IOnEnterSupportOptions = {};
		let empty = true;

		if (conf.brackets) {
			empty = false;
			onEnter.brackets = conf.brackets;
		}
		if (conf.indentationRules) {
			empty = false;
			onEnter.indentationRules = conf.indentationRules;
		}
		if (conf.onEnterRules) {
			empty = false;
			onEnter.regExpRules = conf.onEnterRules;
		}

		if (!empty) {
			return new OnEnterSupport(onEnter);
		}
		return null;
	}

	private static _handleComments(conf: LanguageConfiguration): ICommentsConfiguration {
		let commentRule = conf.comments;
		if (!commentRule) {
			return null;
		}

		// comment configuration
		let comments: ICommentsConfiguration = {};

		if (commentRule.lineComment) {
			comments.lineCommentToken = commentRule.lineComment;
		}
		if (commentRule.blockComment) {
			let [blockStart, blockEnd] = commentRule.blockComment;
			comments.blockCommentStartToken = blockStart;
			comments.blockCommentEndToken = blockEnd;
		}

		return comments;
	}
}

export class LanguageConfigurationRegistryImpl {

	private _entries: RichEditSupport[];

	private _onDidChange: Emitter<void> = new Emitter<void>();
	public onDidChange: Event<void> = this._onDidChange.event;

	constructor() {
		this._entries = [];
	}

	public register(languageIdentifier: LanguageIdentifier, configuration: LanguageConfiguration): IDisposable {
		let previous = this._getRichEditSupport(languageIdentifier.id);
		let current = new RichEditSupport(languageIdentifier, previous, configuration);
		this._entries[languageIdentifier.id] = current;
		this._onDidChange.fire(void 0);
		return {
			dispose: () => {
				if (this._entries[languageIdentifier.id] === current) {
					this._entries[languageIdentifier.id] = previous;
					this._onDidChange.fire(void 0);
				}
			}
		};
	}

	private _getRichEditSupport(languageId: LanguageId): RichEditSupport {
		return this._entries[languageId] || null;
	}

	public getIndentationRules(languageId: LanguageId) {
		let value = this._entries[languageId];

		if (!value) {
			return null;
		}

		return value.indentationRules || null;
	}

	// begin electricCharacter

	private _getElectricCharacterSupport(languageId: LanguageId): BracketElectricCharacterSupport {
		let value = this._getRichEditSupport(languageId);
		if (!value) {
			return null;
		}
		return value.electricCharacter || null;
	}

	public getElectricCharacters(languageId: LanguageId): string[] {
		let electricCharacterSupport = this._getElectricCharacterSupport(languageId);
		if (!electricCharacterSupport) {
			return [];
		}
		return electricCharacterSupport.getElectricCharacters();
	}

	/**
	 * Should return opening bracket type to match indentation with
	 */
	public onElectricCharacter(character: string, context: LineTokens, column: number): IElectricAction {
		let scopedLineTokens = createScopedLineTokens(context, column - 1);
		let electricCharacterSupport = this._getElectricCharacterSupport(scopedLineTokens.languageId);
		if (!electricCharacterSupport) {
			return null;
		}
		return electricCharacterSupport.onElectricCharacter(character, scopedLineTokens, column - scopedLineTokens.firstCharOffset);
	}

	// end electricCharacter

	public getComments(languageId: LanguageId): ICommentsConfiguration {
		let value = this._getRichEditSupport(languageId);
		if (!value) {
			return null;
		}
		return value.comments || null;
	}

	// begin characterPair

	private _getCharacterPairSupport(languageId: LanguageId): CharacterPairSupport {
		let value = this._getRichEditSupport(languageId);
		if (!value) {
			return null;
		}
		return value.characterPair || null;
	}

	public getAutoClosingPairs(languageId: LanguageId): IAutoClosingPair[] {
		let characterPairSupport = this._getCharacterPairSupport(languageId);
		if (!characterPairSupport) {
			return [];
		}
		return characterPairSupport.getAutoClosingPairs();
	}

	public getSurroundingPairs(languageId: LanguageId): IAutoClosingPair[] {
		let characterPairSupport = this._getCharacterPairSupport(languageId);
		if (!characterPairSupport) {
			return [];
		}
		return characterPairSupport.getSurroundingPairs();
	}

	public shouldAutoClosePair(character: string, context: LineTokens, column: number): boolean {
		let scopedLineTokens = createScopedLineTokens(context, column - 1);
		let characterPairSupport = this._getCharacterPairSupport(scopedLineTokens.languageId);
		if (!characterPairSupport) {
			return false;
		}
		return characterPairSupport.shouldAutoClosePair(character, scopedLineTokens, column - scopedLineTokens.firstCharOffset);
	}

	// end characterPair

	public getWordDefinition(languageId: LanguageId): RegExp {
		let value = this._getRichEditSupport(languageId);
		if (!value) {
			return ensureValidWordDefinition(null);
		}
		return ensureValidWordDefinition(value.wordDefinition || null);
	}



	// beigin Indent Rules

	public getIndentRulesSupport(languageId: LanguageId): IndentRulesSupport {
		let value = this._getRichEditSupport(languageId);
		if (!value) {
			return null;
		}
		return value.indentRulesSupport || null;
	}

	/**
	 * Get nearest preceiding line which doesn't match unIndentPattern or contains all whitespace.
	 */
	private getPrecedingValidLine(model: IVirtualModel, lineNumber: number, indentRulesSupport: IndentRulesSupport) {
		let languageID = model.getLanguageIdAtPosition(lineNumber, 0);
		if (lineNumber > 1) {
			let lastLineNumber = lineNumber - 1;
			let resultLineNumber = -1;

			for (lastLineNumber = lineNumber - 1; lastLineNumber >= 1; lastLineNumber--) {
				if (model.getLanguageIdAtPosition(lastLineNumber, 0) !== languageID) {
					return resultLineNumber;
				}
				let text = model.getLineContent(lastLineNumber);
				if (indentRulesSupport.shouldIgnore(text) || /^\s+$/.test(text) || text === '') {
					resultLineNumber = lastLineNumber;
					continue;
				}

				return lastLineNumber;
			}
		}

		return -1;
	}

	/**
	 * Get inherited indentation from above lines.
	 * 1. Find the nearest preceding line which doesn't match unIndentedLinePattern.
	 * 2. If this line matches indentNextLinePattern or increaseIndentPattern, it means that the indent level of `lineNumber` should be 1 greater than this line.
	 * 3. If this line doesn't match any indent rules
	 *   a. check whether the line above it matches indentNextLinePattern
	 *   b. If not, the indent level of this line is the result
	 *   c. If so, it means the indent of this line is *temporary*, go upward utill we find a line whose indent is not temporary (the same workflow a -> b -> c).
	 * 4. Otherwise, we fail to get an inherited indent from aboves. Return null and we should not touch the indent of `lineNumber`
	 *
	 * This function only return the inherited indent based on above lines, it doesn't check whether current line should decrease or not.
	 */
	public getInheritIndentForLine(model: IVirtualModel, lineNumber: number, honorIntentialIndent: boolean = true): { indentation: string, action: IndentAction, line?: number } {
		let indentRulesSupport = this.getIndentRulesSupport(model.getLanguageIdentifier().id);
		if (!indentRulesSupport) {
			return null;
		}

		if (lineNumber <= 1) {
			return {
				indentation: '',
				action: null
			};
		}

		let precedingUnIgnoredLine = this.getPrecedingValidLine(model, lineNumber, indentRulesSupport);
		if (precedingUnIgnoredLine < 1) {
			return {
				indentation: '',
				action: null
			};
		}

		let precedingUnIgnoredLineContent = model.getLineContent(precedingUnIgnoredLine);

		if (indentRulesSupport.shouldIncrease(precedingUnIgnoredLineContent) || indentRulesSupport.shouldIndentNextLine(precedingUnIgnoredLineContent)) {
			return {
				indentation: strings.getLeadingWhitespace(precedingUnIgnoredLineContent),
				action: IndentAction.Indent,
				line: precedingUnIgnoredLine
			};
		} else if (indentRulesSupport.shouldDecrease(precedingUnIgnoredLineContent)) {
			return {
				indentation: strings.getLeadingWhitespace(precedingUnIgnoredLineContent),
				action: null,
				line: precedingUnIgnoredLine
			};
		} else {
			// precedingUnIgnoredLine can not be ignored.
			// it doesn't increase indent of following lines
			// it doesn't increase just next line
			// so current line is not affect by precedingUnIgnoredLine
			// and then we should get a correct inheritted indentation from above lines
			if (precedingUnIgnoredLine === 1) {
				return {
					indentation: strings.getLeadingWhitespace(model.getLineContent(precedingUnIgnoredLine)),
					action: null,
					line: precedingUnIgnoredLine
				};
			}

			let previousLine = precedingUnIgnoredLine - 1;

			let previousLineIndentMetadata = indentRulesSupport.getIndentMetadata(model.getLineContent(previousLine));
			if (!(previousLineIndentMetadata & (IndentConsts.INCREASE_MASK | IndentConsts.DECREASE_MASK)) &&
				(previousLineIndentMetadata & IndentConsts.INDENT_NEXTLINE_MASK)) {
				let stopLine = 0;
				for (let i = previousLine - 1; i > 0; i--) {
					if (indentRulesSupport.shouldIndentNextLine(model.getLineContent(i))) {
						continue;
					}
					stopLine = i;
					break;
				}

				return {
					indentation: strings.getLeadingWhitespace(model.getLineContent(stopLine + 1)),
					action: null,
					line: stopLine + 1
				};
			}

			if (honorIntentialIndent) {
				return {
					indentation: strings.getLeadingWhitespace(model.getLineContent(precedingUnIgnoredLine)),
					action: null,
					line: precedingUnIgnoredLine
				};
			} else {
				// search from precedingUnIgnoredLine until we find one whose indent is not temporary
				for (let i = precedingUnIgnoredLine; i > 0; i--) {
					let lineContent = model.getLineContent(i);
					if (indentRulesSupport.shouldIncrease(lineContent)) {
						return {
							indentation: strings.getLeadingWhitespace(lineContent),
							action: IndentAction.Indent,
							line: i
						};
					} else if (indentRulesSupport.shouldIndentNextLine(lineContent)) {
						let stopLine = 0;
						for (let j = i - 1; j > 0; j--) {
							if (indentRulesSupport.shouldIndentNextLine(model.getLineContent(i))) {
								continue;
							}
							stopLine = j;
							break;
						}

						return {
							indentation: strings.getLeadingWhitespace(model.getLineContent(stopLine + 1)),
							action: null,
							line: stopLine + 1
						};
					} else if (indentRulesSupport.shouldDecrease(lineContent)) {
						return {
							indentation: strings.getLeadingWhitespace(lineContent),
							action: null,
							line: i
						};
					}
				}

				return {
					indentation: strings.getLeadingWhitespace(model.getLineContent(1)),
					action: null,
					line: 1
				};
			}
		}
	}

	public getGoodIndentForLine(virtualModel: IVirtualModel, languageId: LanguageId, lineNumber: number, indentConverter: IIndentConverter): string {
		let indentRulesSupport = this.getIndentRulesSupport(languageId);
		if (!indentRulesSupport) {
			return null;
		}

		let indent = this.getInheritIndentForLine(virtualModel, lineNumber);
		let lineContent = virtualModel.getLineContent(lineNumber);

		if (indent) {
			let inheritLine = indent.line;
			if (inheritLine !== undefined) {
				let onEnterSupport = this._getOnEnterSupport(languageId);
				let enterResult: EnterAction = null;
				try {
					enterResult = onEnterSupport.onEnter('', virtualModel.getLineContent(inheritLine), '');
				} catch (e) {
					onUnexpectedError(e);
				}

				if (enterResult) {
					let indentation = strings.getLeadingWhitespace(virtualModel.getLineContent(inheritLine));

					if (enterResult.removeText) {
						indentation = indentation.substring(0, indentation.length - enterResult.removeText);
					}

					if (
						(enterResult.indentAction === IndentAction.Indent) ||
						(enterResult.indentAction === IndentAction.IndentOutdent)
					) {
						indentation = indentConverter.shiftIndent(indentation);
					} else if (enterResult.indentAction === IndentAction.Outdent) {
						indentation = indentConverter.unshiftIndent(indentation);
					}

					if (indentRulesSupport.shouldDecrease(lineContent)) {
						indentation = indentConverter.unshiftIndent(indentation);
					}

					if (enterResult.appendText) {
						indentation += enterResult.appendText;
					}

					return strings.getLeadingWhitespace(indentation);
				}
			}

			if (indentRulesSupport.shouldDecrease(lineContent)) {
				if (indent.action === IndentAction.Indent) {
					return indent.indentation;
				} else {
					return indentConverter.unshiftIndent(indent.indentation);
				}
			} else {
				if (indent.action === IndentAction.Indent) {
					return indentConverter.shiftIndent(indent.indentation);
				} else {
					return indent.indentation;
				}
			}
		}
		return null;
	}

	public getIndentForEnter(model: ITokenizedModel, range: Range, indentConverter: IIndentConverter, autoIndent: boolean): { beforeEnter: string, afterEnter: string } {
		model.forceTokenization(range.startLineNumber);
		let lineTokens = model.getLineTokens(range.startLineNumber);

		let beforeEnterText;
		let tokenIndexUnderCursor = lineTokens.findTokenIndexAtOffset(range.startColumn);
		let tokenIndexAtBeginning = lineTokens.findTokenIndexAtOffset(0);
		let scopedLineTokens = createScopedLineTokens(lineTokens, range.startColumn);
		let scopedLineText = scopedLineTokens.getLineContent();

		if (lineTokens.getLanguageId(tokenIndexAtBeginning) === lineTokens.getLanguageId(tokenIndexUnderCursor)) {
			beforeEnterText = lineTokens.getLineContent().substring(0, range.startColumn - 1);
		} else {
			beforeEnterText = scopedLineText.substr(0, range.startColumn - 1 - scopedLineTokens.firstCharOffset);
		}

		let afterEnterText;

		if (range.isEmpty()) {
			afterEnterText = scopedLineText.substr(range.startColumn - 1 - scopedLineTokens.firstCharOffset);
		} else {
			const endScopedLineTokens = this.getScopedLineTokens(model, range.endLineNumber, range.endColumn);
			afterEnterText = endScopedLineTokens.getLineContent().substr(range.endColumn - 1 - scopedLineTokens.firstCharOffset);
		}

		let indentRulesSupport = this.getIndentRulesSupport(scopedLineTokens.languageId);

		if (!indentRulesSupport) {
			return null;
		}

		let beforeEnterResult = beforeEnterText;
		let beforeEnterIndent = strings.getLeadingWhitespace(beforeEnterText);

		if (!autoIndent) {
			let beforeEnterIndentAction = this.getInheritIndentForLine(model, range.startLineNumber);
			let beforeEnterIndent = strings.getLeadingWhitespace(beforeEnterText);

			if (indentRulesSupport.shouldDecrease(beforeEnterText)) {
				if (beforeEnterIndentAction) {
					beforeEnterIndent = beforeEnterIndentAction.indentation;
					if (beforeEnterIndentAction.action !== IndentAction.Indent) {
						beforeEnterIndent = indentConverter.unshiftIndent(beforeEnterIndent);
					}
				}
			}

			beforeEnterResult = beforeEnterIndent + strings.ltrim(strings.ltrim(beforeEnterText, ' '), '\t');
		}

		let virtualModel: IVirtualModel = {
			getLineTokens: (lineNumber: number) => {
				return model.getLineTokens(lineNumber);
			},
			getLanguageIdentifier: () => {
				return model.getLanguageIdentifier();
			},
			getLanguageIdAtPosition: (lineNumber: number, column: number) => {
				return model.getLanguageIdAtPosition(lineNumber, column);
			},
			getLineContent: (lineNumber: number) => {
				if (lineNumber === range.startLineNumber) {
					return beforeEnterResult;
				} else {
					return model.getLineContent(lineNumber);
				}
			}
		};

		let afterEnterAction = this.getInheritIndentForLine(virtualModel, range.startLineNumber + 1);
		if (!afterEnterAction) {
			return {
				beforeEnter: beforeEnterIndent,
				afterEnter: beforeEnterIndent
			};
		}

		let afterEnterIndent = afterEnterAction.indentation;

		if (afterEnterAction.action === IndentAction.Indent) {
			afterEnterIndent = indentConverter.shiftIndent(afterEnterIndent);
		}

		if (indentRulesSupport.shouldDecrease(afterEnterText)) {
			afterEnterIndent = indentConverter.unshiftIndent(afterEnterIndent);
		}

		return {
			beforeEnter: beforeEnterIndent,
			afterEnter: afterEnterIndent
		};
	}

	/**
	 * We should always allow intentional indentation. It means, if users change the indentation of `lineNumber` and the content of
	 * this line doesn't match decreaseIndentPattern, we should not adjust the indentation.
	 */
	public getIndentActionForType(model: ITokenizedModel, range: Range, ch: string, indentConverter: IIndentConverter): string {
		let scopedLineTokens = this.getScopedLineTokens(model, range.startLineNumber, range.startColumn);
		let indentRulesSupport = this.getIndentRulesSupport(scopedLineTokens.languageId);
		if (!indentRulesSupport) {
			return null;
		}

		let scopedLineText = scopedLineTokens.getLineContent();
		let beforeTypeText = scopedLineText.substr(0, range.startColumn - 1 - scopedLineTokens.firstCharOffset);
		let afterTypeText;

		// selection support
		if (range.isEmpty()) {
			afterTypeText = scopedLineText.substr(range.startColumn - 1 - scopedLineTokens.firstCharOffset);
		} else {
			const endScopedLineTokens = this.getScopedLineTokens(model, range.endLineNumber, range.endColumn);
			afterTypeText = endScopedLineTokens.getLineContent().substr(range.endColumn - 1 - scopedLineTokens.firstCharOffset);
		}

		if (indentRulesSupport.shouldDecrease(beforeTypeText + ch + afterTypeText)) {
			// after typing `ch`, the content matches decreaseIndentPattern, we should adjust the indent to a good manner.
			// 1. Get inherited indent action
			let r = this.getInheritIndentForLine(model, range.startLineNumber, false);
			if (!r) {
				return null;
			}

			let indentation = r.indentation;

			if (r.action !== IndentAction.Indent) {
				indentation = indentConverter.unshiftIndent(indentation);
			}

			return indentation;
		}

		return null;
	}

	public getIndentMetadata(model: ITokenizedModel, lineNumber: number): number {
		let indentRulesSupport = this.getIndentRulesSupport(model.getLanguageIdentifier().id);
		if (!indentRulesSupport) {
			return null;
		}

		if (lineNumber < 1 || lineNumber > model.getLineCount()) {
			return null;
		}

		return indentRulesSupport.getIndentMetadata(model.getLineContent(lineNumber));
	}

	// end Indent Rules

	// begin onEnter

	private _getOnEnterSupport(languageId: LanguageId): OnEnterSupport {
		let value = this._getRichEditSupport(languageId);
		if (!value) {
			return null;
		}
		return value.onEnter || null;
	}

	public getRawEnterActionAtPosition(model: ITokenizedModel, lineNumber: number, column: number): EnterAction {
		let r = this.getEnterAction(model, new Range(lineNumber, column, lineNumber, column));

		return r ? r.enterAction : null;
	}

	public getEnterAction(model: ITokenizedModel, range: Range): { enterAction: EnterAction; indentation: string; } {
		let indentation = this.getIndentationAtPosition(model, range.startLineNumber, range.startColumn);

		let scopedLineTokens = this.getScopedLineTokens(model, range.startLineNumber, range.startColumn);
		let onEnterSupport = this._getOnEnterSupport(scopedLineTokens.languageId);
		if (!onEnterSupport) {
			return null;
		}

		let scopedLineText = scopedLineTokens.getLineContent();
		let beforeEnterText = scopedLineText.substr(0, range.startColumn - 1 - scopedLineTokens.firstCharOffset);
		let afterEnterText;

		// selection support
		if (range.isEmpty()) {
			afterEnterText = scopedLineText.substr(range.startColumn - 1 - scopedLineTokens.firstCharOffset);
		} else {
			const endScopedLineTokens = this.getScopedLineTokens(model, range.endLineNumber, range.endColumn);
			afterEnterText = endScopedLineTokens.getLineContent().substr(range.endColumn - 1 - scopedLineTokens.firstCharOffset);
		}

		let lineNumber = range.startLineNumber;
		let oneLineAboveText = '';

		if (lineNumber > 1 && scopedLineTokens.firstCharOffset === 0) {
			// This is not the first line and the entire line belongs to this mode
			let oneLineAboveScopedLineTokens = this.getScopedLineTokens(model, lineNumber - 1);
			if (oneLineAboveScopedLineTokens.languageId === scopedLineTokens.languageId) {
				// The line above ends with text belonging to the same mode
				oneLineAboveText = oneLineAboveScopedLineTokens.getLineContent();
			}
		}

		let enterResult: EnterAction = null;
		try {
			enterResult = onEnterSupport.onEnter(oneLineAboveText, beforeEnterText, afterEnterText);
		} catch (e) {
			onUnexpectedError(e);
		}

		if (!enterResult) {
			return null;
		} else {
			// Here we add `\t` to appendText first because enterAction is leveraging appendText and removeText to change indentation.
			if (!enterResult.appendText) {
				if (
					(enterResult.indentAction === IndentAction.Indent) ||
					(enterResult.indentAction === IndentAction.IndentOutdent)
				) {
					enterResult.appendText = '\t';
				} else {
					enterResult.appendText = '';
				}
			}
		}

		if (enterResult.removeText) {
			indentation = indentation.substring(0, indentation.length - enterResult.removeText);
		}

		return {
			enterAction: enterResult,
			indentation: indentation,
		};
	}

	public getIndentationAtPosition(model: ITokenizedModel, lineNumber: number, column: number): string {
		let lineText = model.getLineContent(lineNumber);
		let indentation = strings.getLeadingWhitespace(lineText);
		if (indentation.length > column - 1) {
			indentation = indentation.substring(0, column - 1);
		}

		return indentation;
	}

	private getScopedLineTokens(model: ITokenizedModel, lineNumber: number, columnNumber?: number) {
		model.forceTokenization(lineNumber);
		let lineTokens = model.getLineTokens(lineNumber);
		let column = isNaN(columnNumber) ? model.getLineMaxColumn(lineNumber) - 1 : columnNumber;
		let scopedLineTokens = createScopedLineTokens(lineTokens, column);
		return scopedLineTokens;
	}

	// end onEnter

	public getBracketsSupport(languageId: LanguageId): RichEditBrackets {
		let value = this._getRichEditSupport(languageId);
		if (!value) {
			return null;
		}
		return value.brackets || null;
	}
}

export const LanguageConfigurationRegistry = new LanguageConfigurationRegistryImpl();
